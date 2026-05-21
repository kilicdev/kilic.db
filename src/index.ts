import type mongooseType from "mongoose";
import type { Connection, Model, PipelineStage } from "mongoose";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as nodePath from "path";
import {
  AggregateOptions,
  BackupOptions,
  BackupResult,
  CountOptions,
  CreateOptions,
  Data,
  DeleteOptions,
  DeleteResult,
  Filter,
  FilterResolver,
  FindOptions,
  GetOptions,
  KilicDBConfig,
  UpdateOptions,
  UpdateResult,
} from "./types";
import { KilicError, handleError } from "./errors";

const archiver = require("archiver");

function loadMongoose(): typeof mongooseType {
  try {
    return require("mongoose") as typeof mongooseType;
  } catch (err: any) {
    if (err?.code === "MODULE_NOT_FOUND" && err?.message?.includes("'mongoose'")) {
      throw new KilicError("Missing peer dependency 'mongoose'.", {
        code: "MISSING_PEER_DEPENDENCY",
        hint: "Install it in your project with: npm install mongoose",
        originalError: err,
      });
    }

    throw err;
  }
}

const mongoose = loadMongoose();

class KilicDB {
  #config: KilicDBConfig = {};
  #cache: Map<string, Model<any>> = new Map();
  #connectionPromise?: Promise<Connection>;

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
   * Configure kilic.db. Connection starts in the background when `url` is present.
   */
  public config(options: KilicDBConfig): void {
    const previousUrl = this.#config.url;
    const previousPath = this.#config.path;
    const state = mongoose.connection.readyState;

    if (
      options.url &&
      previousUrl &&
      options.url !== previousUrl &&
      (state === 1 || state === 2 || this.#connectionPromise)
    ) {
      throw new KilicError("Cannot change MongoDB url while a connection is active.", {
        code: "CONFIG_CONFLICT",
        hint: "Disconnect Mongoose first, or keep one kilic.db configuration per process.",
      });
    }

    this.#config = { ...this.#config, ...options };

    if (options.path && options.path !== previousPath) {
      this.#cache.clear();
    }

    if (!this.#config.url) return;

    if (state === 1 || state === 2 || this.#connectionPromise) {
      this.#log("Already connected or connecting. Skipping duplicate connection.");
      return;
    }

    mongoose.set("strictQuery", true);

    const connect = mongoose
      .connect(this.#config.url, this.#config.options ?? {})
      .then(() => {
        this.#log("Connected to MongoDB.");
        return mongoose.connection;
      })
      .catch((err: any) => {
        this.#connectionPromise = undefined;
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
  }

  /**
   * Wait until the configured connection is ready.
   */
  public async ready(): Promise<Connection> {
    if (mongoose.connection.readyState === 1) return mongoose.connection;

    if (!this.#connectionPromise) {
      throw new KilicError(
        "Database is not configured. Call db.config({ url }) first.",
        "NOT_CONFIGURED"
      );
    }

    return this.#connectionPromise;
  }

  /**
   * Retrieve a raw Mongoose model.
   */
  public model<T = any>(modelName: string): Model<T> {
    return this.#resolveModel<T>(modelName);
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
        hint: "Call db.config({ url }) and await db.ready() before db.backup().",
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
    const model = this.#resolveModel<T>(modelName);

    if (Array.isArray(data)) {
      this.#assertNonEmptyArray(data, "create() data");
      const docs = await Promise.all(
        data.map((item, index) => this.#createOne(modelName, model, item, options, index))
      );
      return docs.filter((doc) => doc !== null) as T[];
    }

    return this.#createOne(modelName, model, data, options);
  }

  /**
   * Find a single document.
   */
  public async get<T = any>(
    modelName: string,
    filter: Filter = {},
    options: GetOptions = {}
  ): Promise<T | null> {
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
    options?: UpdateOptions
  ): Promise<Array<T | null>>;
  public async update<T = any>(
    modelName: string,
    data: Data,
    options: UpdateOptions & { multi: true }
  ): Promise<UpdateResult>;
  public async update<T = any>(
    modelName: string,
    data: Data,
    options?: UpdateOptions
  ): Promise<T | null>;
  public async update<T = any>(
    modelName: string,
    data: Data | Data[],
    options: UpdateOptions = {}
  ): Promise<T | null | Array<T | null> | UpdateResult> {
    const model = this.#resolveModel<T>(modelName);

    if (Array.isArray(data)) {
      if (options.multi) {
        throw new KilicError("update() cannot combine array data with multi: true.", "INVALID_OPTION");
      }
      this.#assertNonEmptyArray(data, "update() data");
      return Promise.all(
        data.map((item, index) => this.#updateOne(modelName, model, item, options, index))
      );
    }

    if (options.multi) {
      return this.#updateMany(model, data, options);
    }

    return this.#updateOne(modelName, model, data, options);
  }

  /**
   * Delete one document, array filters, or many matching documents.
   */
  public async delete(
    modelName: string,
    filter: Filter | Filter[],
    options: DeleteOptions = {}
  ): Promise<DeleteResult> {
    const model = this.#resolveModel(modelName);

    try {
      if (Array.isArray(filter)) {
        this.#assertNonEmptyArray(filter, "delete() filters");
        const results = await Promise.all(
          filter.map((item) => {
            this.#assertFilter(item, "delete()");
            return options.multi
              ? model.deleteMany(item, this.#sessionOptions(options.session))
              : model.deleteOne(item, this.#sessionOptions(options.session));
          })
        );

        const deletedCount = results.reduce((total, result) => total + (result.deletedCount ?? 0), 0);
        return { success: true, deletedCount };
      }

      this.#assertFilter(filter, "delete()");
      const method = options.multi ? model.deleteMany.bind(model) : model.deleteOne.bind(model);
      const result = await method(filter, this.#sessionOptions(options.session));
      return { success: true, deletedCount: result.deletedCount ?? 0 };
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
    const model = this.#resolveModel(modelName);
    if (!Array.isArray(stages)) {
      throw new KilicError("aggregate() stages must be an array.", "INVALID_PIPELINE");
    }

    try {
      const { session, ...aggregateOptions } = options;
      let aggregate = model.aggregate<T>(stages);
      aggregate = aggregate.option(aggregateOptions);
      if (session) aggregate = aggregate.session(session);
      return await aggregate.exec();
    } catch (err) {
      handleError(err);
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
      new: true,
      setDefaultsOnInsert: true,
      runValidators: true,
    });

    try {
      const doc = await model.findOneAndUpdate(filter, { $setOnInsert: data }, queryOptions).lean();
      return (doc as T) ?? null;
    } catch (err: any) {
      if (err?.code === 11000) {
        const existing = await model.findOne(filter, null, this.#sessionOptions(options.session)).lean();
        if (existing) return existing as T;
      }
      handleError(err);
    }
  }

  async #updateOne<T>(
    modelName: string,
    model: Model<T>,
    data: Data,
    options: UpdateOptions,
    index?: number
  ): Promise<T | null> {
    this.#assertPlainObject(data, "update() data");
    this.#assertNonEmptyObject(data, "update() data");

    const filter = this.#filterFromData(modelName, data, options.filter, index, "update()");
    const updatePayload = this.#hasUpdateOperator(data) ? data : { $set: data };
    const queryOptions = this.#writeOptions(options.session, {
      new: true,
      runValidators: true,
    });

    try {
      let query = model.findOneAndUpdate(filter, updatePayload, queryOptions);
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
    options: UpdateOptions
  ): Promise<UpdateResult> {
    this.#assertPlainObject(data, "update() data");
    this.#assertNonEmptyObject(data, "update() data");
    this.#assertSingleFilter(options.filter, "update()");

    const updatePayload = this.#hasUpdateOperator(data) ? data : { $set: data };
    const queryOptions = this.#writeOptions(options.session, { runValidators: true });

    try {
      const result = await model.updateMany(options.filter, updatePayload, queryOptions);
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
      .map((item) => String(item?.name || "").trim())
      .filter((name) => name && !name.startsWith("system."))
      .sort((a, b) => a.localeCompare(b));
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
        stream.end(() => resolve());
        stream.once("error", reject);
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

  #zipDirectory(sourceDir: string, zipFile: string): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const archive = archiver("zip", { zlib: { level: 9 } });
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

  #resolveModel<T = any>(modelName: string): Model<T> {
    if (!modelName || typeof modelName !== "string") {
      throw new KilicError("Model name must be a non-empty string.", "INVALID_MODEL_NAME");
    }

    if (this.#cache.has(modelName)) {
      return this.#cache.get(modelName) as Model<T>;
    }

    const registeredModel = mongoose.models[modelName];
    if (registeredModel) {
      this.#cache.set(modelName, registeredModel);
      return registeredModel as Model<T>;
    }

    if (this.#config.path) {
      const filePath = this.#findModelFile(modelName);
      if (filePath) {
        const model = this.#loadModel<T>(modelName, filePath);
        this.#cache.set(modelName, model);
        return model;
      }
    }

    throw new KilicError(
      `Model '${modelName}' not found. Register it with mongoose.model() or set db.config({ path }).`,
      "MODEL_NOT_FOUND"
    );
  }

  #findModelFile(modelName: string): string | null {
    const basePath = this.#config.path;
    if (!basePath) return null;

    const resolvedBasePath = nodePath.resolve(basePath);
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
          `Model file '${filePath}' did not export a Mongoose model.`,
          "INVALID_MODEL_EXPORT"
        );
      }

      this.#log(`Loaded model '${modelName}' from ${filePath}`);
      return loaded as Model<T>;
    } catch (err: any) {
      if (err instanceof KilicError) throw err;
      throw new KilicError(
        `Failed to load model '${modelName}' from ${filePath}: ${err?.message ?? err}`,
        "MODEL_LOAD_ERROR",
        err
      );
    }
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
  }

  #assertNonEmptyArray(value: unknown[], label: string): void {
    if (value.length === 0) {
      throw new KilicError(`${label} cannot be empty.`, "EMPTY_ARRAY");
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
