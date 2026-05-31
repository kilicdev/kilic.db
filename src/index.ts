import * as fs from "fs";
import * as fsp from "fs/promises";
import * as nodePath from "path";
import {
  AggregateOptions,
  BackupOptions,
  BackupResult,
  DatabaseType,
  CountOptions,
  CreateOptions,
  Data,
  DeleteOptions,
  DeleteResult,
  Filter,
  FilterResolver,
  FindOptions,
  GetOptions,
  KilicConfigContinuation,
  KilicDBConfig,
  KilicModelAccessor,
  ModelSchemaDefinition,
  UpdateOptions,
  UpdateResult,
} from "./types";
import { KilicError, handleError } from "./errors";

const KD_EXTENSION = ".kd";
const LOCAL_TYPE: DatabaseType = "local";
const SERVER_TYPE: DatabaseType = "server";

const continueAfterConfig: KilicConfigContinuation = <T>(value: T): T => value;

type MongooseInstance = any;
type Connection = any;
type Model<T = any> = any;
type PipelineStage = Record<string, any>;

type MongoMemoryServerLike = {
  getUri(dbName?: string): string;
  stop(): Promise<boolean | void>;
};

type FileStoreSnapshot = {
  version?: number;
  database?: string;
  updatedAt?: string;
  collections?: Record<string, any[]>;
};

function loadMongoose(): MongooseInstance {
  try {
    return require("mongoose") as MongooseInstance;
  } catch (err: any) {
    if (err?.code === "MODULE_NOT_FOUND" && err?.message?.includes("'mongoose'")) {
      throw new KilicError("Missing optional dependency 'mongoose'.", {
        code: "MISSING_OPTIONAL_DEPENDENCY",
        hint: "Install kilic.db with optional dependencies enabled, or run: npm install mongoose",
        originalError: err,
      });
    }

    throw err;
  }
}

const mongoose = loadMongoose();

class KilicDB {
  #config: KilicDBConfig = {};
  #hasConfigured = false;
  #cache: Map<string, Model<any>> = new Map();
  #connectionPromise?: Promise<Connection>;
  #memoryServer?: MongoMemoryServerLike;
  #memoryServerStops: Set<Promise<void>> = new Set();
  #fileStorePath?: string;
  #fileStoreWritePromise: Promise<void> = Promise.resolve();
  #removeDisconnectedListener?: () => void;
  #patchedSessions: WeakSet<object> = new WeakSet();
  #shutdownBound?: () => void;
  #shuttingDown = false;

  public readonly model: KilicModelAccessor;

  public constructor() {
    const owner = this;
    const modelAccessor = function <T = any>(
      this: unknown,
      modelName: string,
      definition?: ModelSchemaDefinition<T>,
      options?: Record<string, any>
    ): Model<T> {
      if (new.target || arguments.length > 1) {
        return owner.#defineModel<T>(modelName, definition, options);
      }

      return owner.#resolveModel<T>(modelName);
    };

    this.model = modelAccessor as unknown as KilicModelAccessor;
  }

  /**
   * Raw Mongoose instance for sessions, plugins, transactions, and advanced APIs.
   */
  public get mongoose(): typeof mongoose {
    return mongoose;
  }

  /**
   * Raw Mongoose connection for events and low-level access.
   */
  public get connection(): Connection {
    return mongoose.connection;
  }

  /**
   * Configure kilic.db. Connection starts in the background.
   * If `url` is omitted, kilic.db starts a local mongodb-memory-server-core replica set
   * and persists data to the configured file store.
   */
  public config(options: KilicDBConfig = {}): KilicConfigContinuation {
    this.#assertConfigOptions(options);

    const previousCollections = this.#modelDirectory(this.#config);
    const state = mongoose.connection.readyState;
    const active = state === 1 || state === 2 || Boolean(this.#connectionPromise);
    const baseConfig = active ? this.#config : {};
    const nextConfig = this.#normalizeConfig({ ...baseConfig, ...options });

    if (
      active &&
      this.#connectionKey(this.#config) !== this.#connectionKey(nextConfig)
    ) {
      throw new KilicError("Cannot change database connection while a connection is active.", {
        code: "CONFIG_CONFLICT",
        hint: "Call db.disconnect() first, or keep one kilic.db configuration per process.",
      });
    }

    this.#config = nextConfig;
    this.#hasConfigured = true;

    if (this.#modelDirectory(this.#config) !== previousCollections) {
      this.#cache.clear();
    }

    if (active) {
      this.#log("Already connected or connecting. Skipping duplicate connection.");
      return continueAfterConfig;
    }

    this.#shuttingDown = false;
    mongoose.set("strictQuery", true);

    if (this.#config.type === LOCAL_TYPE) {
      this.#registerShutdownHook();
    }

    const connect = (this.#config.type === SERVER_TYPE ? this.#connectToMongoDB() : this.#connectToFileStore())
      .catch((err: any) => {
        this.#connectionPromise = undefined;
        if (err instanceof KilicError) {
          this.#log(err.message);
          throw err;
        }

        const wrapped = new KilicError(
          `Could not connect to MongoDB: ${err?.message ?? err}`,
          "CONNECTION_ERROR",
          err
        );
        this.#log(wrapped.message);
        throw wrapped;
      });

    this.#connectionPromise = connect;
    void connect.catch(() => undefined);
    return continueAfterConfig;
  }

  /**
   * Wait until the configured connection is ready.
   */
  public async ready(): Promise<Connection> {
    if (mongoose.connection.readyState === 1) return mongoose.connection;

    if (!this.#connectionPromise) {
      this.config(this.#hasConfigured ? this.#config : {});
    }

    if (!this.#connectionPromise) {
      throw new KilicError("Database connection did not start.", "CONNECTION_NOT_STARTED");
    }

    return this.#connectionPromise;
  }

  /**
   * Persist the current file-backed memory database to disk.
   * No-ops when kilic.db is connected to a real MongoDB URL.
   */
  public async flush(): Promise<void> {
    await this.ready();
    await this.#persistFileStore();
  }

  /**
   * Flush pending file-backed data, disconnect Mongoose, and stop the local memory server.
   */
  public async disconnect(): Promise<void> {
    const pendingConnection = this.#connectionPromise;

    try {
      if (pendingConnection && mongoose.connection.readyState !== 1 && !this.#shuttingDown) {
        await pendingConnection.catch(() => undefined);
      }

      if (mongoose.connection.readyState === 1) {
        await this.#persistFileStore();
      }
    } finally {
      this.#removeDisconnectedListener?.();
      const connectingDuringShutdown = this.#shuttingDown && mongoose.connection.readyState !== 1;

      if (connectingDuringShutdown) {
        void mongoose.disconnect().catch(() => undefined);
      } else {
        await mongoose.disconnect().catch(() => undefined);
        while (mongoose.connection.readyState !== 0) {
          await new Promise((r) => setTimeout(r, 10));
        }
      }

      this.#removeShutdownHook();
      await this.#stopMemoryServer().catch(() => undefined);
      this.#connectionPromise = undefined;
      this.#shuttingDown = false;
    }
  }

  /**
   * Create a dated zip backup of every MongoDB collection.
   */
  public async backup(options: BackupOptions = {}): Promise<BackupResult> {
    await this.ready();

    const db = mongoose.connection.db;
    if (!db) {
      throw new KilicError("Database connection is not ready for backup.", {
        code: "DATABASE_NOT_READY",
        hint: "Call db.config({ url }) or db.config({ file }), then await db.ready() before db.backup().",
      });
    }

    const backupDir = nodePath.resolve(options.backupDir ?? this.#config.backupDir ?? nodePath.join(process.cwd(), "backups"));
    const createdAt = new Date().toISOString();
    const id = this.#backupId(options.id, createdAt);
    const dumpDir = nodePath.join(backupDir, `.tmp-${id}`);
    const zipFile = nodePath.join(backupDir, `${id}.zip`);

    try {
      await fsp.mkdir(dumpDir, { recursive: true });

      const collectionNames = await this.#collectionNames();
      const collections = [];

      for (const collectionName of collectionNames) {
        collections.push(await this.#dumpCollection(collectionName, dumpDir, options.batchSize));
      }

      await this.#writeBackupMetadata(dumpDir, {
        id,
        createdAt,
        database: db.databaseName,
        collections,
      });

      const size = await this.#zipDirectory(dumpDir, zipFile);

      return {
        success: true,
        id,
        file: zipFile,
        directory: backupDir,
        database: db.databaseName,
        collections,
        size,
        createdAt,
      };
    } catch (err) {
      handleError(err);
    } finally {
      await fsp.rm(dumpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Create one or many documents once with atomic upserts.
   */
  public async create<T = any>(
    modelName: string,
    data: Data[],
    options?: CreateOptions
  ): Promise<T[]>;
  public async create<T = any>(
    modelName: string,
    data: Data,
    options?: CreateOptions
  ): Promise<T | null>;
  public async create<T = any>(
    modelName: string,
    data: Data | Data[],
    options: CreateOptions = {}
  ): Promise<T | null | T[]> {
    await this.ready();
    const model = this.#resolveModel<T>(modelName);

    if (Array.isArray(data)) {
      this.#assertNonEmptyArray(data, "create() data");
      this.#assertFilterArrayLength(data, options.filter, "create()");
      const docs = this.#sessionInTransaction(options.session)
        ? await this.#mapSequential(data, (item, index) => this.#createOne<T>(modelName, model, item, options, index))
        : await Promise.all(
            data.map((item, index) => this.#createOne<T>(modelName, model, item, options, index))
          );
      const result = docs.filter((doc) => doc !== null) as T[];
      await this.#persistAfterWrite(options.session);
      return result;
    }

    const result = await this.#createOne<T>(modelName, model, data, options);
    await this.#persistAfterWrite(options.session);
    return result;
  }

  /**
   * Find a single document.
   */
  public async get<T = any>(
    modelName: string,
    filter: Filter = {},
    options: GetOptions = {}
  ): Promise<T | null> {
    await this.ready();
    const model = this.#resolveModel<T>(modelName);
    this.#assertPlainObject(filter, "get() filter");

    let query = model.findOne(filter, options.projection, this.#sessionOptions(options.session));
    if (options.lean !== false) query = query.lean() as any;
    query = this.#applyPopulate(query, options.populate);

    const doc = await query.exec().catch(handleError);
    return (doc as T) ?? null;
  }

  /**
   * Update one document, array data, or many matching documents.
   */
  public async update<T = any>(
    modelName: string,
    data: Data[],
    filter?: FilterResolver | Filter[],
    options?: UpdateOptions
  ): Promise<Array<T | null>>;
  public async update<T = any>(
    modelName: string,
    data: Data,
    filter: Filter,
    options: UpdateOptions & { multi: true }
  ): Promise<UpdateResult>;
  public async update<T = any>(
    modelName: string,
    data: Data,
    filter?: Filter,
    options?: UpdateOptions
  ): Promise<T | null>;
  public async update<T = any>(
    modelName: string,
    data: Data | Data[],
    filter?: Filter | FilterResolver | Filter[],
    options: UpdateOptions = {}
  ): Promise<T | null | Array<T | null> | UpdateResult> {
    await this.ready();
    const model = this.#resolveModel<T>(modelName);
    let result: T | null | Array<T | null> | UpdateResult;

    if (Array.isArray(data)) {
      if (options.multi) {
        throw new KilicError("update() cannot combine array data with multi: true.", "INVALID_OPTION");
      }
      this.#assertNonEmptyArray(data, "update() data");
      this.#assertFilterArrayLength(data, filter as FilterResolver | undefined, "update()");
      result = this.#sessionInTransaction(options.session)
        ? await this.#mapSequential(data, (item, index) => this.#updateOne<T>(modelName, model, item, filter as FilterResolver | undefined, options, index))
        : await Promise.all(
            data.map((item, index) => this.#updateOne<T>(modelName, model, item, filter as FilterResolver | undefined, options, index))
          );
      await this.#persistAfterWrite(options.session);
      return result;
    }

    if (options.multi) {
      result = await this.#updateMany(model, data, filter as Filter | undefined, options);
      await this.#persistAfterWrite(options.session);
      return result;
    }

    result = await this.#updateOne<T>(modelName, model, data, filter as Filter | undefined, options);
    await this.#persistAfterWrite(options.session);
    return result;
  }

  /**
   * Delete one document, array filters, or many matching documents.
   */
  public async delete(
    modelName: string,
    filter: Filter | Filter[],
    options: DeleteOptions = {}
  ): Promise<DeleteResult> {
    await this.ready();
    const model = this.#resolveModel(modelName);

    try {
      if (Array.isArray(filter)) {
        this.#assertNonEmptyArray(filter, "delete() filters");
        const deleteOne = (item: Filter) => {
            this.#assertFilter(item, "delete()");
            return options.multi
              ? model.deleteMany(item, this.#sessionOptions(options.session))
              : model.deleteOne(item, this.#sessionOptions(options.session));
        };
        const results = this.#sessionInTransaction(options.session)
          ? await this.#mapSequential(filter, deleteOne)
          : await Promise.all(filter.map(deleteOne));

        const deletedCount = results.reduce((total, result) => total + (result.deletedCount ?? 0), 0);
        const result = { success: true, deletedCount };
        await this.#persistAfterWrite(options.session);
        return result;
      }

      this.#assertFilter(filter, "delete()");
      const method = options.multi ? model.deleteMany.bind(model) : model.deleteOne.bind(model);
      const result = await method(filter, this.#sessionOptions(options.session));
      const payload = { success: true, deletedCount: result.deletedCount ?? 0 };
      await this.#persistAfterWrite(options.session);
      return payload;
    } catch (err) {
      handleError(err);
    }
  }

  /**
   * Find multiple documents.
   */
  public async find<T = any>(
    modelName: string,
    filter: Filter,
    options: FindOptions & { cursor: true }
  ): Promise<AsyncIterable<T>>;
  public async find<T = any>(
    modelName: string,
    filter?: Filter,
    options?: FindOptions
  ): Promise<T[]>;
  public async find<T = any>(
    modelName: string,
    filter: Filter = {},
    options: FindOptions = {}
  ): Promise<T[] | AsyncIterable<T>> {
    await this.ready();
    const model = this.#resolveModel<T>(modelName);
    this.#assertPlainObject(filter, "find() filter");

    let query = model.find(filter, options.projection, this.#sessionOptions(options.session));
    if (options.lean !== false) query = query.lean() as any;
    if (options.sort) query = query.sort(options.sort);
    if (options.skip !== undefined) query = query.skip(this.#nonNegativeNumber(options.skip, "skip"));
    if (options.limit !== undefined) query = query.limit(this.#nonNegativeNumber(options.limit, "limit"));
    query = this.#applyPopulate(query, options.populate);

    if (options.cursor) {
      return query.cursor(options.cursorOptions as any) as AsyncIterable<T>;
    }

    const docs = await query.exec().catch(handleError);
    return (docs as T[]) ?? [];
  }

  /**
   * Count documents matching a filter.
   */
  public async count(
    modelName: string,
    filter: Filter = {},
    options: CountOptions = {}
  ): Promise<number> {
    await this.ready();
    const model = this.#resolveModel(modelName);
    this.#assertPlainObject(filter, "count() filter");
    return model.countDocuments(filter, this.#sessionOptions(options.session)).catch(handleError);
  }

  /**
   * Run a full MongoDB aggregation pipeline.
   */
  public async aggregate<T = any>(
    modelName: string,
    stages: PipelineStage[],
    options: AggregateOptions = {}
  ): Promise<T[]> {
    await this.ready();
    const model = this.#resolveModel(modelName);
    if (!Array.isArray(stages)) {
      throw new KilicError("aggregate() stages must be an array.", "INVALID_PIPELINE");
    }

    try {
      const { session, ...aggregateOptions } = options;
      let aggregate = model.aggregate(stages);
      aggregate = aggregate.option(aggregateOptions);
      if (session) aggregate = aggregate.session(session);
      const result = await aggregate.exec();
      if (this.#aggregateWrites(stages)) await this.#persistAfterWrite(session);
      return result as T[];
    } catch (err) {
      handleError(err);
    }
  }

  async #connectToMongoDB(): Promise<Connection> {
    await mongoose.connect(this.#config.url as string, this.#config.options ?? {});
    this.#watchDisconnect(false);
    this.#log("Connected to MongoDB.");
    return mongoose.connection;
  }

  async #connectToFileStore(): Promise<Connection> {
    const filePath = this.#fileStoreFilePath();
    await this.#cleanupFileStoreTempFiles(filePath);
    const snapshot = await this.#readFileStoreSnapshot(filePath);
    const database = this.#fileStoreDatabaseName(snapshot);
    const { MongoMemoryReplSet } = this.#loadMongoMemoryServer();
    let memoryServer: MongoMemoryServerLike | undefined;

    try {
      this.#config = { ...this.#config, file: filePath, database };
      this.#registerShutdownHook();
      memoryServer = await MongoMemoryReplSet.create(this.#config.memoryServerOptions ?? {});
      this.#memoryServer = memoryServer;
      this.#fileStorePath = filePath;

      await mongoose.connect(memoryServer.getUri(database), this.#config.options ?? {});
      this.#watchDisconnect(true);
      await this.#restoreFileStoreSnapshot(snapshot);
      await this.#initRegisteredModels();
      await this.#persistFileStore();

      this.#log(`Connected to file-backed MongoDB memory server at ${filePath}.`);
      return mongoose.connection;
    } catch (err) {
      this.#removeDisconnectedListener?.();
      this.#removeShutdownHook();
      await mongoose.disconnect().catch(() => undefined);
      this.#memoryServer = undefined;
      this.#fileStorePath = undefined;
      if (memoryServer) await memoryServer.stop().catch(() => undefined);
      throw err;
    }
  }

  async #createOne<T>(
    modelName: string,
    model: Model<T>,
    data: Data,
    options: CreateOptions,
    index?: number
  ): Promise<T | null> {
    this.#assertPlainObject(data, "create() data");
    this.#assertNonEmptyObject(data, "create() data");
    if (this.#hasUpdateOperator(data)) {
      throw new KilicError("create() data cannot contain update operators. Use update() instead.", "INVALID_PAYLOAD");
    }

    const filter = this.#filterFromData(modelName, data, options.filter, index, "create()");
    const queryOptions = this.#writeOptions(options.session, {
      upsert: true,
      returnDocument: "after",
      setDefaultsOnInsert: true,
      runValidators: true,
    });

    try {
      const doc = await model.findOneAndUpdate(filter, { $setOnInsert: data }, queryOptions).lean();
      return (doc as T) ?? null;
    } catch (err: any) {
      if (err?.code === 11000) {
        // Race: another writer inserted between our check. Retry the upsert once — it will now find the existing doc.
        try {
          const doc = await model.findOneAndUpdate(filter, { $setOnInsert: data }, queryOptions).lean();
          return (doc as T) ?? null;
        } catch (retryErr: any) {
          handleError(retryErr);
        }
      }
      handleError(err);
    }
  }

  async #updateOne<T>(
    modelName: string,
    model: Model<T>,
    data: Data,
    filter: Filter | FilterResolver | undefined,
    options: UpdateOptions,
    index?: number
  ): Promise<T | null> {
    this.#assertPlainObject(data, "update() data");
    this.#assertNonEmptyObject(data, "update() data");

    const resolvedFilter = this.#filterFromData(modelName, data, filter, index, "update()");
    const updatePayload = this.#hasUpdateOperator(data) ? data : { $set: data };
    const queryOptions = this.#writeOptions(options.session, {
      returnDocument: "after",
      runValidators: true,
      ...(options.upsert ? { upsert: true, setDefaultsOnInsert: true } : {}),
    });

    try {
      let query = model.findOneAndUpdate(resolvedFilter, updatePayload, queryOptions);
      if (options.lean !== false) query = query.lean() as any;
      const doc = await query.exec();
      return (doc as T) ?? null;
    } catch (err) {
      handleError(err);
    }
  }

  async #updateMany<T>(
    model: Model<T>,
    data: Data,
    filter: Filter | undefined,
    options: UpdateOptions
  ): Promise<UpdateResult> {
    this.#assertPlainObject(data, "update() data");
    this.#assertNonEmptyObject(data, "update() data");
    this.#assertSingleFilter(filter, "update()");

    const updatePayload = this.#hasUpdateOperator(data) ? data : { $set: data };
    const queryOptions = this.#writeOptions(options.session, {
      runValidators: true,
      ...(options.upsert ? { upsert: true } : {}),
    });

    try {
      const result = await model.updateMany(filter, updatePayload, queryOptions);
      return {
        success: true,
        matchedCount: result.matchedCount ?? 0,
        modifiedCount: result.modifiedCount ?? 0,
      };
    } catch (err) {
      handleError(err);
    }
  }

  #log(message: string, ...args: any[]): void {
    if (this.#config.debug) {
      console.log(`[kilic.db] ${message}`, ...args);
    }
  }

  #watchDisconnect(stopMemoryServer: boolean): void {
    this.#removeDisconnectedListener?.();

    const listener = () => {
      this.#connectionPromise = undefined;
      this.#removeDisconnectedListener = undefined;
      if (stopMemoryServer && !this.#shuttingDown) {
        void this.#stopMemoryServer().catch((err) => {
          this.#log(`Could not stop memory server: ${err?.message ?? err}`);
        });
      }
    };

    mongoose.connection.once("disconnected", listener);
    this.#removeDisconnectedListener = () => {
      mongoose.connection.off("disconnected", listener);
      this.#removeDisconnectedListener = undefined;
    };
  }

  #registerShutdownHook(): void {
    this.#removeShutdownHook();

    const handler = () => {
      if (this.#shuttingDown) return;
      this.#shuttingDown = true;

      void this.disconnect()
        .catch(() => undefined)
        .finally(() => process.exit(0));
    };

    this.#shutdownBound = handler;
    process.once("SIGINT", handler);
    process.once("SIGTERM", handler);
  }

  #removeShutdownHook(): void {
    if (this.#shutdownBound) {
      process.removeListener("SIGINT", this.#shutdownBound);
      process.removeListener("SIGTERM", this.#shutdownBound);
      this.#shutdownBound = undefined;
    }
  }

  #normalizeConfig(config: KilicDBConfig): KilicDBConfig {
    const type = this.#normalizeDatabaseType(config);
    const collections = this.#normalizeCollectionsPath(config);
    const url = this.#optionalNonEmptyString(config.url, "url");
    const file = this.#optionalNonEmptyString(config.file, "file");
    const cwd = this.#optionalNonEmptyString(config.cwd, "cwd");
    const backupDir = this.#optionalNonEmptyString(config.backupDir, "backupDir");
    const database = this.#optionalNonEmptyString(config.database, "database");

    if (type === SERVER_TYPE) {
      if (!url) {
        throw new KilicError("Server database mode requires a MongoDB connection URL.", {
          code: "INVALID_CONFIG",
          hint: "Use db.config({ type: 'server', url: 'mongodb://127.0.0.1:27017/myapp' }) or switch to type: 'local'.",
        });
      }
    }

    if (type === LOCAL_TYPE && config.url) {
      throw new KilicError("Local database mode cannot be combined with a MongoDB URL.", {
        code: "INVALID_CONFIG",
        hint: "Remove `url`, or use db.config({ type: 'server', url }).",
      });
    }

    return {
      ...config,
      ...(url ? { url } : {}),
      ...(file ? { file } : {}),
      ...(cwd ? { cwd } : {}),
      ...(backupDir ? { backupDir } : {}),
      ...(database ? { database } : {}),
      type,
      ...(collections ? { collections } : {}),
    };
  }

  #assertConfigOptions(options: unknown): asserts options is KilicDBConfig {
    if (!this.#isPlainObject(options)) {
      throw new KilicError("config() options must be a plain object.", {
        code: "INVALID_CONFIG",
        hint: "Use db.config({ type: 'local' }) or db.config({ type: 'server', url }).",
      });
    }
  }

  #isPlainObject(value: unknown): value is Record<string, any> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  #optionalNonEmptyString(value: unknown, key: string): string | undefined {
    if (value === undefined) return undefined;

    if (typeof value !== "string" || value.trim() === "") {
      throw new KilicError(`config.${key} must be a non-empty string.`, {
        code: "INVALID_CONFIG",
        hint: `Remove ${key}, or pass a valid string value.`,
        details: { option: key },
      });
    }

    return value;
  }

  #normalizeDatabaseType(config: KilicDBConfig): DatabaseType {
    if (config.type !== undefined && config.type !== LOCAL_TYPE && config.type !== SERVER_TYPE) {
      throw new KilicError("Invalid database type.", {
        code: "INVALID_CONFIG",
        hint: "Use `type: 'local'` or `type: 'server'`.",
        details: { type: String(config.type) },
      });
    }

    return config.type ?? (config.url ? SERVER_TYPE : LOCAL_TYPE);
  }

  #normalizeCollectionsPath(config: KilicDBConfig): string | undefined {
    const collections = this.#optionalNonEmptyString(config.collections, "collections");
    const legacyPath = this.#optionalNonEmptyString(config.path, "path");

    if (collections && legacyPath) {
      const resolvedCollections = this.#resolveConfigPath(collections, config);
      const resolvedLegacyPath = this.#resolveConfigPath(legacyPath, config);
      if (resolvedCollections !== resolvedLegacyPath) {
        throw new KilicError("`collections` and deprecated `path` point to different directories.", {
          code: "INVALID_CONFIG",
          hint: "Use only `collections` in db.config().",
          details: {
            collections: resolvedCollections,
            path: resolvedLegacyPath,
          },
        });
      }

      return resolvedCollections;
    }

    const modelDirectory = collections ?? legacyPath;
    return modelDirectory ? this.#resolveConfigPath(modelDirectory, config) : undefined;
  }

  #modelDirectory(config: KilicDBConfig = this.#config): string | undefined {
    return config.collections ?? config.path;
  }

  #resolveConfigPath(value: string, config: KilicDBConfig = this.#config): string {
    const base = config.cwd ?? process.cwd();
    return nodePath.isAbsolute(value)
      ? nodePath.resolve(value)
      : nodePath.resolve(base, value);
  }

  #connectionKey(config: KilicDBConfig): string {
    const type = config.type ?? (config.url ? SERVER_TYPE : LOCAL_TYPE);
    if (type === SERVER_TYPE) return `server:${config.url ?? ""}`;

    const filePath = this.#ensureKdExtension(this.#resolveConfigPath(config.file ?? this.#getDefaultFileStorePathForConfig(config), config));
    return `local:${filePath}:${config.database ?? ""}`;
  }

  #getDefaultFileStorePathForConfig(config: KilicDBConfig): string {
    return nodePath.join(config.cwd ?? process.cwd(), "datas.kd");
  }

  #getDefaultDatabaseName(): string {
    return "kilicdb";
  }

  #loadMongoMemoryServer(): { MongoMemoryReplSet: { create(options?: Record<string, any>): Promise<MongoMemoryServerLike> } } {
    try {
      return require("mongodb-memory-server-core");
    } catch (err: any) {
      if (err?.code === "MODULE_NOT_FOUND" && err?.message?.includes("mongodb-memory-server-core")) {
        throw new KilicError("Missing dependency 'mongodb-memory-server-core'.", {
          code: "MISSING_DEPENDENCY",
          hint: "Install kilic.db with optional dependencies enabled, or run: npm install mongodb-memory-server-core",
          originalError: err,
        });
      }

      throw err;
    }
  }

  #fileStoreFilePath(): string {
    const raw = this.#config.file ?? this.#getDefaultFileStorePath();
    const resolved = this.#ensureKdExtension(this.#resolveConfigPath(raw));
    return resolved;
  }

  #getDefaultFileStorePath(): string {
    return nodePath.join(this.#config.cwd ?? process.cwd(), "datas.kd");
  }

  #ensureKdExtension(filePath: string): string {
    const ext = nodePath.extname(filePath);
    if (ext === KD_EXTENSION) return filePath;
    if (ext) return filePath.slice(0, -ext.length) + KD_EXTENSION;
    return filePath + KD_EXTENSION;
  }

  async #readFileStoreSnapshot(filePath: string): Promise<FileStoreSnapshot | null> {
    try {
      const content = await fsp.readFile(filePath, "utf-8");
      if (!content.trim()) return null;
      const snapshot = JSON.parse(content);

      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
        throw new Error("file store root must be an object");
      }

      if (
        snapshot.collections !== undefined &&
        (!snapshot.collections || typeof snapshot.collections !== "object" || Array.isArray(snapshot.collections))
      ) {
        throw new Error("collections must be an object keyed by collection name");
      }

      return snapshot as FileStoreSnapshot;
    } catch (err: any) {
      if (err?.code === "ENOENT") return null;
      throw new KilicError("Could not read file-backed database store.", {
        code: "FILE_STORE_READ_FAILED",
        hint: "Check that the configured db.config({ file }) path contains valid kilic.db JSON.",
        details: { file: filePath },
        originalError: err,
      });
    }
  }

  #fileStoreDatabaseName(snapshot: FileStoreSnapshot | null): string {
    const database = String(this.#config.database ?? snapshot?.database ?? this.#getDefaultDatabaseName()).trim();
    if (!database || /[\/\\."$\0]/.test(database)) {
      throw new KilicError("File-backed database name is invalid.", {
        code: "INVALID_DATABASE_NAME",
        hint: "Use db.config({ database }) with a MongoDB database name that does not contain /, \\, ., \", $, or null bytes.",
        details: { database },
      });
    }

    return database;
  }

  async #restoreFileStoreSnapshot(snapshot: FileStoreSnapshot | null): Promise<void> {
    const db = mongoose.connection.db;
    if (!db || !snapshot?.collections) return;

    for (const [collectionName, documents] of Object.entries(snapshot.collections)) {
      if (!Array.isArray(documents)) {
        throw new KilicError("Could not restore file-backed database store.", {
          code: "FILE_STORE_INVALID",
          hint: "Each collection in the file store must be an array of EJSON documents.",
          details: { collection: collectionName },
        });
      }

      const collection = db.collection(collectionName);
      if (documents.length === 0) {
        await db.createCollection(collectionName).catch((err: any) => {
          if (err?.codeName !== "NamespaceExists") throw err;
        });
        continue;
      }

      await collection.insertMany(documents.map((document) => this.#deserializeEJSON(document)), {
        ordered: true,
      });
    }
  }

  async #initRegisteredModels(): Promise<void> {
    const models = Object.values(mongoose.models) as Array<Model<any>>;

    for (const model of models) {
      await model.init().catch((err: any) => {
        throw new KilicError(`Could not initialize model '${model.modelName}' for file-backed database mode.`, {
          code: "FILE_STORE_MODEL_INIT_FAILED",
          hint: "Check schema indexes and existing file-backed data for conflicts.",
          details: { model: model.modelName },
          originalError: err,
        });
      });
    }
  }

  async #persistFileStore(): Promise<void> {
    if (!this.#fileStorePath) return;

    const next = this.#fileStoreWritePromise
      .catch(() => undefined)
      .then(() => this.#writeFileStoreSnapshot());
    this.#fileStoreWritePromise = next;

    try {
      await next;
    } catch (err) {
      // Reset chain so next caller retries from clean state
      if (this.#fileStoreWritePromise === next) {
        this.#fileStoreWritePromise = Promise.resolve();
      }
      throw err;
    }
  }

  async #persistAfterWrite(session?: any): Promise<void> {
    if (!this.#fileStorePath) return;

    if (this.#sessionInTransaction(session)) {
      this.#patchSessionCommit(session);
      return;
    }

    await this.#persistFileStore();
  }

  #sessionInTransaction(session?: any): boolean {
    if (!session || typeof session.inTransaction !== "function") return false;

    try {
      return Boolean(session.inTransaction());
    } catch {
      return false;
    }
  }

  async #mapSequential<T, R>(
    items: T[],
    mapper: (item: T, index: number) => Promise<R>
  ): Promise<R[]> {
    const results: R[] = [];

    for (let index = 0; index < items.length; index++) {
      results.push(await mapper(items[index], index));
    }

    return results;
  }

  #patchSessionCommit(session: any): void {
    if (!session || typeof session !== "object" || this.#patchedSessions.has(session)) return;
    if (typeof session.commitTransaction !== "function") return;

    const commitTransaction = session.commitTransaction.bind(session);
    session.commitTransaction = async (...args: any[]) => {
      const result = await commitTransaction(...args);
      await this.#persistFileStore();
      return result;
    };

    this.#patchedSessions.add(session);
  }

  async #cleanupFileStoreTempFiles(filePath: string): Promise<void> {
    const directory = nodePath.dirname(filePath);
    const basename = nodePath.basename(filePath);
    const prefix = `.${basename}.`;

    try {
      const entries = await fsp.readdir(directory);
      await Promise.all(
        entries
          .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".tmp"))
          .map((entry) => fsp.rm(nodePath.join(directory, entry), { force: true }))
      );
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        throw new KilicError("Could not clean stale file-backed database temp files.", {
          code: "FILE_STORE_TEMP_CLEANUP_FAILED",
          hint: "Check that the configured db.config({ file }) directory is readable and writable.",
          details: { directory },
          originalError: err,
        });
      }
    }
  }

  async #writeFileStoreSnapshot(): Promise<void> {
    const db = mongoose.connection.db;
    const filePath = this.#fileStorePath;
    if (!db || !filePath) return;

    const directory = nodePath.dirname(filePath);
    const tempFile = nodePath.join(directory, `.${nodePath.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    let stream: fs.WriteStream | undefined;
    let renamed = false;

    try {
      await fsp.mkdir(directory, { recursive: true });
      await this.#cleanupFileStoreTempFiles(filePath);
      const collectionNames = await this.#collectionNames();

      stream = fs.createWriteStream(tempFile, { encoding: "utf-8" });
      const activeStream = stream;
      const write = (content: string) => this.#streamWrite(activeStream, content);

      await write(`{\n  "version": 1,\n  "database": ${JSON.stringify(db.databaseName)},\n  "updatedAt": ${JSON.stringify(new Date().toISOString())},\n  "collections": {\n`);

      for (let ci = 0; ci < collectionNames.length; ci++) {
        const collectionName = collectionNames[ci];
        if (ci > 0) await write(",\n");
        await write(`    ${JSON.stringify(collectionName)}: [`);

        const cursor = db.collection(collectionName).find({});
        let first = true;

        for await (const document of cursor) {
          const serialized = JSON.stringify(this.#serializeEJSON(document));
          if (!first) await write(",");
          await write(serialized);
          first = false;
        }

        await write("]");
      }

      await write("\n  }\n}\n");

      await new Promise<void>((resolve, reject) => {
        activeStream.on("error", reject);
        activeStream.end(() => resolve());
      });

      await fsp.rename(tempFile, filePath);
      renamed = true;
    } catch (err) {
      stream?.destroy();
      await fsp.rm(tempFile, { force: true }).catch(() => undefined);
      throw new KilicError("Could not write file-backed database store.", {
        code: "FILE_STORE_WRITE_FAILED",
        hint: "Check that the configured db.config({ file }) path is writable.",
        details: { file: filePath },
        originalError: err,
      });
    } finally {
      if (!renamed) {
        await fsp.rm(tempFile, { force: true }).catch(() => undefined);
      }
    }
  }

  async #stopMemoryServer(): Promise<void> {
    const memoryServer = this.#memoryServer;
    this.#memoryServer = undefined;
    this.#fileStorePath = undefined;
    if (!memoryServer) {
      await Promise.all(Array.from(this.#memoryServerStops));
      return;
    }

    const stopPromise = memoryServer
      .stop()
      .then(() => undefined)
      .finally(() => {
        this.#memoryServerStops.delete(stopPromise);
      });
    this.#memoryServerStops.add(stopPromise);
    await stopPromise;
  }

  #aggregateWrites(stages: PipelineStage[]): boolean {
    return stages.some((stage) => (
      Boolean(stage) &&
      typeof stage === "object" &&
      (Object.prototype.hasOwnProperty.call(stage, "$out") || Object.prototype.hasOwnProperty.call(stage, "$merge"))
    ));
  }

  #serializeEJSON(document: any): any {
    return JSON.parse(mongoose.mongo.BSON.EJSON.stringify(document, { relaxed: false }));
  }

  #deserializeEJSON(document: any): any {
    return mongoose.mongo.BSON.EJSON.parse(JSON.stringify(document), { relaxed: false });
  }

  #backupId(id: string | undefined, createdAt: string): string {
    const safeId = String(id || "")
      .trim()
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .replace(/^\.+|\.+$/g, "")
      .replace(/-+/g, "-");
    if (safeId) return safeId;

    return `kilic-db-${createdAt.replace(/[:.]/g, "-")}`;
  }

  async #collectionNames(): Promise<string[]> {
    const db = mongoose.connection.db;
    if (!db) {
      throw new KilicError("Database connection is not ready for backup.", "DATABASE_NOT_READY");
    }

    const collections = await db.listCollections({}, { nameOnly: true }).toArray();
    return collections
      .map((item: any) => String(item?.name || "").trim())
      .filter((name: string) => name && !name.startsWith("system."))
      .sort((a: string, b: string) => a.localeCompare(b));
  }

  async #dumpCollection(collectionName: string, dumpDir: string, batchSize = 200): Promise<{ collection: string; count: number; file: string }> {
    const db = mongoose.connection.db;
    if (!db) {
      throw new KilicError("Database connection is not ready for backup.", "DATABASE_NOT_READY");
    }

    const fileName = `${this.#backupFileName(collectionName)}.json`;
    const filePath = nodePath.join(dumpDir, fileName);
    const stream = fs.createWriteStream(filePath, { encoding: "utf-8" });
    const cursor = db.collection(collectionName).find({}, {
      batchSize: this.#positiveNumber(batchSize, "backup batchSize"),
      noCursorTimeout: true,
      maxTimeMS: 30 * 60 * 1000, // 30 min safety cap
    });

    let count = 0;
    let first = true;

    try {
      await this.#streamWrite(stream, "[\n");

      for await (const document of cursor) {
        const serialized = mongoose.mongo.BSON.EJSON.stringify(document, { relaxed: false });
        if (!first) await this.#streamWrite(stream, ",\n");
        await this.#streamWrite(stream, serialized);
        first = false;
        count++;
      }

      await this.#streamWrite(stream, "\n]\n");
      await new Promise<void>((resolve, reject) => {
        stream.on("error", reject);
        stream.end(() => resolve());
      });

      return {
        collection: collectionName,
        count,
        file: fileName,
      };
    } catch (err) {
      stream.destroy();
      if (cursor?.close) await cursor.close().catch(() => undefined);
      throw new KilicError(`Could not dump collection '${collectionName}'.`, {
        code: "BACKUP_COLLECTION_DUMP_FAILED",
        hint: "Check MongoDB read permissions and available disk space.",
        details: { collection: collectionName },
        originalError: err,
      });
    }
  }

  async #writeBackupMetadata(dumpDir: string, metadata: Record<string, any>): Promise<void> {
    await fsp.writeFile(
      nodePath.join(dumpDir, "__meta__.json"),
      JSON.stringify(metadata, null, 2),
      "utf-8"
    );
  }

  #loadArchiver(): { ZipArchive: new (options?: Record<string, any>) => any } {
    try {
      return require("archiver");
    } catch (err: any) {
      if (err?.code === "MODULE_NOT_FOUND" && err?.message?.includes("archiver")) {
        throw new KilicError("Missing dependency 'archiver'.", {
          code: "MISSING_DEPENDENCY",
          hint: "Install kilic.db with optional dependencies enabled, or run: npm install archiver",
          originalError: err,
        });
      }

      throw err;
    }
  }

  #zipDirectory(sourceDir: string, zipFile: string): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const { ZipArchive } = this.#loadArchiver();
      const archive = new ZipArchive({ zlib: { level: 9 } });
      const output = fs.createWriteStream(zipFile);

      output.on("close", () => resolve(Number(archive.pointer() || 0)));
      output.on("error", reject);
      archive.on("error", reject);

      archive.pipe(output);
      archive.directory(sourceDir, false);
      void archive.finalize();
    }).catch((err) => {
      throw new KilicError("Could not create backup zip file.", {
        code: "BACKUP_ZIP_FAILED",
        hint: "Check that backupDir is writable and there is enough disk space.",
        details: { file: zipFile },
        originalError: err,
      });
    });
  }

  #streamWrite(stream: fs.WriteStream, content: string): Promise<void> {
    return new Promise((resolve, reject) => {
      stream.write(content, "utf-8", (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  #backupFileName(collectionName: string): string {
    const safeName = encodeURIComponent(collectionName).replace(/\./g, "%2E");
    return safeName || "collection";
  }

  #defineModel<T = any>(
    modelName: string,
    definition: ModelSchemaDefinition<T> | undefined,
    options?: Record<string, any>
  ): Model<T> {
    this.#assertModelName(modelName);

    if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
      throw new KilicError("Model schema definition must be a plain object or a Mongoose Schema.", {
        code: "INVALID_MODEL_SCHEMA",
        hint: "Use new db.model('Name', { id: String, name: String }).",
      });
    }

    const registeredModel = mongoose.models[modelName];
    if (registeredModel) {
      this.#cache.set(modelName, registeredModel);
      return registeredModel as Model<T>;
    }

    const schema = definition instanceof mongoose.Schema
      ? definition
      : new mongoose.Schema(definition as any, {
          versionKey: false,
          ...options,
        });
    const model = mongoose.model(modelName, schema) as Model<T>;
    this.#cache.set(modelName, model);
    return model;
  }

  #resolveModel<T = any>(modelName: string): Model<T> {
    this.#assertModelName(modelName);

    if (this.#cache.has(modelName)) {
      return this.#cache.get(modelName) as Model<T>;
    }

    const registeredModel = mongoose.models[modelName];
    if (registeredModel) {
      this.#cache.set(modelName, registeredModel);
      return registeredModel as Model<T>;
    }

    if (this.#modelDirectory()) {
      const filePath = this.#findModelFile(modelName);
      if (filePath) {
        const model = this.#loadModel<T>(modelName, filePath);
        this.#cache.set(modelName, model);
        return model;
      }
    }

    throw new KilicError(
      `Model '${modelName}' not found. Register it with new db.model() or set db.config({ collections }).`,
      "MODEL_NOT_FOUND"
    );
  }

  #findModelFile(modelName: string): string | null {
    const basePath = this.#modelDirectory();
    if (!basePath) return null;

    const resolvedBasePath = this.#resolveConfigPath(basePath);
    const candidates = [
      `${modelName}.js`,
      `${modelName}.cjs`,
      `${modelName}.ts`,
    ].map((fileName) => nodePath.resolve(resolvedBasePath, fileName));

    return candidates.find((filePath) => {
      const relativePath = nodePath.relative(resolvedBasePath, filePath);
      const isInsideBasePath = relativePath && !relativePath.startsWith("..") && !nodePath.isAbsolute(relativePath);
      return isInsideBasePath && fs.existsSync(filePath);
    }) ?? null;
  }

  #loadModel<T>(modelName: string, filePath: string): Model<T> {
    try {
      let loaded = require(filePath);
      if (loaded?.default) loaded = loaded.default;

      if (!loaded || typeof loaded.findOne !== "function") {
        throw new KilicError(
          `Collection file '${filePath}' did not export a kilic.db model.`,
          "INVALID_MODEL_EXPORT"
        );
      }

      this.#log(`Loaded model '${modelName}' from ${filePath}`);
      return loaded as Model<T>;
    } catch (err: any) {
      if (err instanceof KilicError) throw err;

      if (err?.code === "MODULE_NOT_FOUND" && this.#missingModuleName(err) === "mongoose") {
        throw new KilicError(`Collection '${modelName}' requires mongoose but it is not installed in the user's project.`, {
          code: "MODEL_DEPENDENCY_MISSING",
          hint: "Use `const db = require('kilic.db'); module.exports = new db.model('Name', schema);` inside the collection file, or install mongoose in the project.",
          details: { file: filePath, dependency: "mongoose" },
          originalError: err,
        });
      }

      throw new KilicError(
        `Failed to load model '${modelName}' from ${filePath}: ${err?.message ?? err}`,
        "MODEL_LOAD_ERROR",
        err
      );
    }
  }

  #assertModelName(modelName: unknown): asserts modelName is string {
    if (!modelName || typeof modelName !== "string") {
      throw new KilicError("Model name must be a non-empty string.", "INVALID_MODEL_NAME");
    }
  }

  #missingModuleName(err: any): string | undefined {
    const match = String(err?.message ?? "").match(/Cannot find module ['"]([^'"]+)['"]/);
    return match?.[1];
  }

  #filterFromData(
    modelName: string,
    data: Data,
    filter: FilterResolver | undefined,
    index: number | undefined,
    scope: string
  ): Filter {
    if (typeof filter === "function") {
      const resolved = filter(data, index ?? 0);
      this.#assertFilter(resolved, `${scope} filter`);
      return resolved;
    }

    if (Array.isArray(filter)) {
      if (index === undefined) {
        throw new KilicError(`${scope} filter array can only be used with array data.`, "INVALID_FILTER");
      }
      const resolved = filter[index];
      this.#assertFilter(resolved, `${scope} filter`);
      return resolved;
    }

    if (filter) {
      if (index !== undefined) {
        throw new KilicError(
          `${scope} received array data with one shared filter object. Use a filter resolver function or a filter array instead.`,
          "UNSAFE_SHARED_FILTER"
        );
      }
      this.#assertFilter(filter, `${scope} filter`);
      return filter;
    }

    if (Object.prototype.hasOwnProperty.call(data, "id") && data.id !== undefined && data.id !== null) {
      return { id: data.id };
    }

    throw new KilicError(
      `${scope.replace("()", "")}('${modelName}') requires data.id or options.filter.`,
      "MISSING_FILTER"
    );
  }

  #applyPopulate(query: any, populate?: string | string[] | Record<string, any>): any {
    if (!populate) return query;
    const entries = Array.isArray(populate) ? populate : [populate];
    return entries.reduce((current, item) => current.populate(item), query);
  }

  #sessionOptions(session?: any): Record<string, any> {
    return session ? { session } : {};
  }

  #writeOptions(session: any, options: Record<string, any>): Record<string, any> {
    return { ...options, ...this.#sessionOptions(session) };
  }

  #assertFilter(filter: unknown, scope: string): asserts filter is Filter {
    this.#assertPlainObject(filter, `${scope} filter`);
    if (Object.keys(filter as Filter).length === 0) {
      throw new KilicError(`${scope} requires a non-empty filter.`, "MISSING_FILTER");
    }
  }

  #assertSingleFilter(filter: unknown, scope: string): asserts filter is Filter {
    if (typeof filter === "function" || Array.isArray(filter)) {
      throw new KilicError(`${scope} multi mode requires a single filter object.`, "INVALID_FILTER");
    }
    this.#assertFilter(filter, scope);
  }

  #assertPlainObject(value: unknown, label: string): asserts value is Record<string, any> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new KilicError(`${label} must be a plain object.`, "INVALID_OBJECT");
    }

    const dangerous = Object.keys(value).find((key) => key === "__proto__" || key === "constructor" || key === "prototype");
    if (dangerous) {
      throw new KilicError(`${label} contains a forbidden key '${dangerous}'.`, "PROTOTYPE_POLLUTION");
    }
  }

  #assertNonEmptyArray(value: unknown[], label: string): void {
    if (value.length === 0) {
      throw new KilicError(`${label} cannot be empty.`, "EMPTY_ARRAY");
    }
  }

  #assertFilterArrayLength(data: Data[], filter: FilterResolver | undefined, scope: string): void {
    if (Array.isArray(filter) && filter.length !== data.length) {
      throw new KilicError(
        `${scope} filter array length (${filter.length}) does not match data array length (${data.length}).`,
        "FILTER_LENGTH_MISMATCH"
      );
    }
  }

  #assertNonEmptyObject(value: Record<string, any>, label: string): void {
    if (Object.keys(value).length === 0) {
      throw new KilicError(`${label} cannot be empty.`, "EMPTY_OBJECT");
    }
  }

  #hasUpdateOperator(data: Record<string, any>): boolean {
    return Object.keys(data).some((key) => key.startsWith("$"));
  }

  #nonNegativeNumber(value: number, label: string): number {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue) || numberValue < 0) {
      throw new KilicError(`${label} must be a non-negative number.`, "INVALID_OPTION");
    }
    return numberValue;
  }

  #positiveNumber(value: number, label: string): number {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue) || numberValue < 1) {
      throw new KilicError(`${label} must be a positive number.`, "INVALID_OPTION");
    }
    return numberValue;
  }
}

const db = new KilicDB();
export = db;
