import mongoose, { Model, Connection, PipelineStage } from "mongoose";
import * as fs from "fs";
import * as nodePath from "path";
import {
  KilicDBConfig,
  CreateOptions,
  GetOptions,
  UpdateOptions,
  DeleteOptions,
  FindOptions,
  AggregateExtraOptions,
  InsertManyExtraOptions,
  BulkWriteExtraOptions,
  CountOptions,
  DeleteResult,
  BulkWriteResult,
} from "./types";
import { KilicError, handleError } from "./errors";


class KilicDB {
  private _config: KilicDBConfig = {};
  private _cache: Map<string, Model<any>> = new Map();
  private _connected: boolean = false;

  // ─────────────────────────────────────────────────────────────
  // Escape Hatches — Raw Mongoose Access
  // ─────────────────────────────────────────────────────────────

  /**
   * Raw `mongoose` instance.
   * Use this for ACID Transactions, global plugins, etc.
   *
   * @example
   * const session = await db.mongoose.startSession();
   */
  public get mongoose(): typeof mongoose {
    return mongoose;
  }

  /**
   * Raw Mongoose connection.
   * Use this to listen to `disconnected`, `reconnected` events globally.
   *
   * @example
   * db.connection.on('disconnected', () => console.error('DB dropped!'));
   */
  public get connection(): Connection {
    return mongoose.connection;
  }

  // ─────────────────────────────────────────────────────────────
  // Configuration & Connection
  // ─────────────────────────────────────────────────────────────

  /**
   * Configure and connect to MongoDB in the background.
   * You can start writing queries immediately — Mongoose buffers commands automatically.
   *
   * @example
   * db.config({ url: "mongodb://localhost:27017/myapp", path: path.join(__dirname, "models") });
   */
  public config(options: KilicDBConfig): void {
    this._config = { ...this._config, ...options };

    if (!this._config.url) return;

    // Prevent double-connecting if already in connected/connecting state
    const state = mongoose.connection.readyState;
    if (state === 1 || state === 2) {
      this._log("Already connected or connecting — skipping duplicate connection.");
      return;
    }

    mongoose.set("strictQuery", true);

    // Non-blocking. Mongoose buffers all operations until connection resolves.
    mongoose.connect(this._config.url, this._config.options ?? {})
      .then(() => {
        this._connected = true;
        this._log("Connected to MongoDB.");
      })
      .catch((err: any) => {
        console.error("[kilic.db] Fatal: Could not connect to MongoDB:", err?.message ?? err);
      });
  }

  /**
   * Retrieve a raw Mongoose Model by name.
   * This is an escape hatch for any operation not covered by this wrapper.
   *
   * @example
   * const User = db.model("User");
   * User.watch().on("change", (change) => console.log(change)); // Change Streams
   */
  public model<T = any>(modelName: string): Model<T> {
    return this._resolveModel(modelName);
  }

  // ─────────────────────────────────────────────────────────────
  // Internal
  // ─────────────────────────────────────────────────────────────

  private _log(msg: string, ...args: any[]): void {
    if (this._config.debug) {
      console.log(`[kilic.db] ${msg}`, ...args);
    }
  }

  private _resolveModel<T = any>(modelName: string): Model<T> {
    // 1. Hot cache
    if (this._cache.has(modelName)) {
      return this._cache.get(modelName) as Model<T>;
    }

    // 2. Already-registered Mongoose model
    if (mongoose.models[modelName]) {
      this._cache.set(modelName, mongoose.models[modelName]);
      return mongoose.models[modelName] as Model<T>;
    }

    // 3. Dynamic require from user-supplied path
    if (this._config.path) {
      const fileCandidates = [
        nodePath.join(this._config.path, `${modelName}.js`),
        nodePath.join(this._config.path, `${modelName}.ts`),
        nodePath.join(this._config.path, `${modelName}.cjs`),
      ];

      for (const filePath of fileCandidates) {
        if (fs.existsSync(filePath)) {
          try {
            let loaded = require(filePath);
            // Handle both CJS and ESM default exports
            if (loaded && loaded.default) loaded = loaded.default;
            this._cache.set(modelName, loaded);
            this._log(`Loaded model '${modelName}' from ${filePath}`);
            return loaded as Model<T>;
          } catch (err: any) {
            throw new KilicError(`Failed to load model '${modelName}' from ${filePath}: ${err?.message}`, "MODEL_LOAD_ERROR", err);
          }
        }
      }
    }

    throw new KilicError(
      `Model '${modelName}' not found.\n` +
      `  → Ensure it is registered via mongoose.model() before use, OR\n` +
      `  → Set 'path' in db.config() to your models directory.`,
      "MODEL_NOT_FOUND"
    );
  }

  private _applyPopulate(query: any, populate?: string | string[] | Record<string, any>): any {
    if (!populate) return query;
    if (Array.isArray(populate)) {
      populate.forEach((p) => { query = query.populate(p); });
    } else {
      query = query.populate(populate);
    }
    return query;
  }

  // ─────────────────────────────────────────────────────────────
  // CRUD — Core Operations
  // ─────────────────────────────────────────────────────────────

  /**
   * Create or find a document atomically using an upsert under the hood.
   * Handles race conditions (duplicate key 11000) gracefully.
   *
   * @param modelName - Name of the Mongoose model
   * @param data - Document data to insert
   * @param options.filter - Custom filter for uniqueness check (required if data has no `id`)
   * @param options.force - If true, overwrites existing fields instead of only writing on insert
   *
   * @example
   * const user = await db.create("User", { email: "test@test.com" });
   * const user = await db.create("User", { email: "test@test.com", role: "admin" }, { force: true });
   */
  public async create<T = any>(
    modelName: string,
    data: Record<string, any> = {},
    options: CreateOptions = {}
  ): Promise<T | null> {
    const model = this._resolveModel<T>(modelName);

    const filter = options.filter ?? (data.id ? { id: data.id } : null);
    if (!filter) {
      throw new KilicError(
        `create('${modelName}') requires a unique filter.\n` +
        `  → Either set data.id, or pass options.filter explicitly.\n` +
        `  → Example: db.create("User", { email: "..." }, { filter: { email: "..." } })`,
        "MISSING_FILTER"
      );
    }

    const updatePayload = options.force
      ? { $set: data }
      : { $setOnInsert: data };

    const queryOptions: Record<string, any> = {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    };
    if (options.session) queryOptions.session = options.session;

    try {
      const doc = await model.findOneAndUpdate(filter, updatePayload, queryOptions).lean();
      return (doc as T) ?? null;
    } catch (err: any) {
      // Race condition: another request inserted between our check and upsert
      if (err?.code === 11000) {
        const existing = await model.findOne(filter, null, options.session ? { session: options.session } : {}).lean();
        if (options.force && existing) {
          const forced = await model.findOneAndUpdate(
            filter,
            { $set: data },
            { new: true, ...(options.session ? { session: options.session } : {}) }
          ).lean();
          return (forced as T) ?? null;
        }
        return (existing as T) ?? null;
      }
      handleError(err);
    }
  }

  /**
   * Find a single document.
   *
   * @example
   * const user = await db.get("User", { email: "test@test.com" });
   * const user = await db.get("User", { id: "123" }, { projection: { password: 0 } });
   */
  public async get<T = any>(
    modelName: string,
    filter: Record<string, any> = {},
    options: GetOptions = {}
  ): Promise<T | null> {
    const model = this._resolveModel<T>(modelName);

    let query = model.findOne(
      filter,
      options.projection,
      options.session ? { session: options.session } : {}
    );

    if (options.lean !== false) query = query.lean() as any;
    query = this._applyPopulate(query, options.populate);

    const doc = await query.exec().catch(handleError);
    return (doc as T) ?? null;
  }

  /**
   * Update a single document and return the updated document.
   *
   * @param data - Mongoose update operator object, e.g. `{ $set: { name: "..." } }` or plain object `{ name: "..." }` (auto-wrapped in $set)
   *
   * @example
   * await db.update("User", { $set: { name: "John" } }, { filter: { id: "123" } });
   * await db.update("User", { $inc: { score: 1 } }, { filter: { id: "123" } });
   */
  public async update<T = any>(
    modelName: string,
    data: Record<string, any> = {},
    options: UpdateOptions = {}
  ): Promise<T | false> {
    const model = this._resolveModel<T>(modelName);

    if (!options.filter && !options.force) {
      throw new KilicError(
        `update('${modelName}') requires options.filter.\n` +
        `  → Pass { filter: { id: "..." } } as the third argument.\n` +
        `  → Or use { force: true } to update without a filter (matches first document).`,
        "MISSING_FILTER"
      );
    }

    const filter = options.filter ?? {};

    // Auto-wrap plain objects in $set so users don't need to know Mongoose operators
    const hasOperators = Object.keys(data).some((k) => k.startsWith("$"));
    const updatePayload = hasOperators ? data : { $set: data };

    const queryOptions: Record<string, any> = { new: true };
    if (options.upsert) queryOptions.upsert = true;
    if (options.session) queryOptions.session = options.session;

    try {
      if (options.multi) {
        const result = await model.updateMany(filter, updatePayload, queryOptions);
        return result as any;
      }
      const doc = await model.findOneAndUpdate(filter, updatePayload, queryOptions).lean();
      return (doc as T) ?? false;
    } catch (err: any) {
      if (err?.code === 11000) return false;
      handleError(err);
    }
  }

  /**
   * Delete one or many documents.
   *
   * @example
   * await db.delete("User", { id: "123" });
   * await db.delete("User", { status: "banned" }, { multi: true });
   * await db.delete("User", { status: "banned" }, { force: true }); // deleteMany, never throws
   */
  public async delete(
    modelName: string,
    filter: Record<string, any> = {},
    options: DeleteOptions = {}
  ): Promise<DeleteResult> {
    const model = this._resolveModel(modelName);
    const queryOptions = options.session ? { session: options.session } : {};

    try {
      if (options.force || options.multi) {
        const result = await model.deleteMany(filter, queryOptions);
        return { success: true, deletedCount: result.deletedCount };
      } else {
        const result = await model.deleteOne(filter, queryOptions);
        return { success: true, deletedCount: result.deletedCount };
      }
    } catch (err) {
      if (options.force) return { success: true, deletedCount: 0 };
      handleError(err);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Query — Multiple Documents
  // ─────────────────────────────────────────────────────────────

  /**
   * Find multiple documents with full pagination support.
   *
   * @example
   * const users = await db.find("User", { status: "active" }, { limit: 10, skip: 0, sort: { createdAt: -1 } });
   */
  public async find<T = any>(
    modelName: string,
    filter: Record<string, any> = {},
    options: FindOptions = {}
  ): Promise<T[]> {
    const model = this._resolveModel<T>(modelName);

    const sessionOpt = options.session ? { session: options.session } : {};
    let query = model.find(filter, options.projection, sessionOpt);

    if (options.lean !== false) query = query.lean() as any;
    if (options.sort) query = query.sort(options.sort);
    if (options.skip) query = query.skip(Number(options.skip));
    if (options.limit) query = query.limit(Number(options.limit));
    query = this._applyPopulate(query, options.populate);

    if (options.cursor) {
      const cursor = query.cursor();
      const results: T[] = [];
      try {
        for await (const doc of cursor) {
          results.push(doc as T);
        }
      } catch (err) {
        handleError(err);
      }
      return results;
    }

    const docs = await query.exec().catch(handleError);
    return (docs as T[]) ?? [];
  }

  // ─────────────────────────────────────────────────────────────
  // Aggregation
  // ─────────────────────────────────────────────────────────────

  /**
   * Run a native MongoDB aggregation pipeline.
   *
   * @example
   * const stats = await db.aggregate("Orders", [
   *   { $match: { status: "completed" } },
   *   { $group: { _id: "$userId", total: { $sum: "$amount" } } }
   * ]);
   */
  public async aggregate<T = any>(
    modelName: string,
    pipeline: PipelineStage[] = [],
    options: AggregateExtraOptions = {}
  ): Promise<T[]> {
    const model = this._resolveModel(modelName);
    let agg = model.aggregate<T>(pipeline);
    if (options.options) agg = agg.option(options.options);
    if (options.session) agg = agg.session(options.session);
    return agg.exec().catch(handleError);
  }

  // ─────────────────────────────────────────────────────────────
  // Convenience / Extra Operations
  // ─────────────────────────────────────────────────────────────

  /**
   * Count documents matching a filter.
   *
   * @example
   * const count = await db.countDocuments("User", { status: "active" });
   */
  public async countDocuments(
    modelName: string,
    filter: Record<string, any> = {},
    options: CountOptions = {}
  ): Promise<number> {
    const model = this._resolveModel(modelName);
    const queryOptions = options.session ? { session: options.session } : {};
    return model.countDocuments(filter, queryOptions).catch(handleError);
  }

  /**
   * Get an ultra-fast estimated total count of the collection.
   * Does not accept a filter — uses collection metadata.
   *
   * @example
   * const total = await db.estimatedDocumentCount("User");
   */
  public async estimatedDocumentCount(modelName: string): Promise<number> {
    const model = this._resolveModel(modelName);
    return model.estimatedDocumentCount().catch(handleError);
  }

  /**
   * Find distinct values for a given field.
   *
   * @example
   * const tags = await db.distinct("Article", "tags", { published: true });
   */
  public async distinct<T = any>(
    modelName: string,
    field: string,
    filter: Record<string, any> = {}
  ): Promise<T[]> {
    const model = this._resolveModel(modelName);
    return model.distinct(field, filter).exec().catch(handleError) as Promise<T[]>;
  }

  /**
   * Bulk insert an array of documents. Faster than calling create() in a loop.
   *
   * @example
   * await db.insertMany("Product", [{ name: "A" }, { name: "B" }]);
   */
  public async insertMany<T = any>(
    modelName: string,
    docs: Record<string, any>[] = [],
    options: InsertManyExtraOptions = {}
  ): Promise<T[]> {
    const model = this._resolveModel<T>(modelName);
    const result = await model.insertMany(docs, options as any).catch(handleError);
    return result as unknown as T[];
  }

  /**
   * Find a document by ID.
   *
   * @example
   * const user = await db.findById("User", "64abc123...");
   */
  public async findById<T = any>(
    modelName: string,
    id: string,
    options: GetOptions = {}
  ): Promise<T | null> {
    const model = this._resolveModel<T>(modelName);
    let query = model.findById(id, options.projection, options.session ? { session: options.session } : {});
    if (options.lean !== false) query = query.lean() as any;
    query = this._applyPopulate(query, options.populate);
    const doc = await query.exec().catch(handleError);
    return (doc as T) ?? null;
  }

  /**
   * Find a document by ID and delete it atomically.
   *
   * @example
   * const deleted = await db.findByIdAndDelete("User", "64abc123...");
   */
  public async findByIdAndDelete<T = any>(
    modelName: string,
    id: string,
    options: { session?: any } = {}
  ): Promise<T | null> {
    const model = this._resolveModel<T>(modelName);
    const doc = await model.findByIdAndDelete(id, options).lean().catch(handleError);
    return (doc as T) ?? null;
  }

  /**
   * Find a document matching a filter and delete it atomically.
   *
   * @example
   * const deleted = await db.findOneAndDelete("User", { email: "test@test.com" });
   */
  public async findOneAndDelete<T = any>(
    modelName: string,
    filter: Record<string, any> = {},
    options: { session?: any } = {}
  ): Promise<T | null> {
    const model = this._resolveModel<T>(modelName);
    const doc = await model.findOneAndDelete(filter, options).lean().catch(handleError);
    return (doc as T) ?? null;
  }

  /**
   * Replace an entire document (not a partial update).
   *
   * @example
   * await db.replaceOne("User", { id: "123" }, { id: "123", name: "New", email: "..." });
   */
  public async replaceOne<T = any>(
    modelName: string,
    filter: Record<string, any> = {},
    replacement: Record<string, any> = {},
    options: { upsert?: boolean; session?: any } = {}
  ): Promise<T | null> {
    const model = this._resolveModel<T>(modelName);
    const doc = await model.findOneAndReplace(filter, replacement, { new: true, ...options }).lean().catch(handleError);
    return (doc as T) ?? null;
  }

  /**
   * Execute multiple write operations in a single network round-trip.
   *
   * @example
   * await db.bulkWrite("User", [
   *   { insertOne: { document: { name: "Alice" } } },
   *   { deleteOne: { filter: { id: "999" } } },
   *   { updateOne: { filter: { id: "1" }, update: { $set: { role: "admin" } } } }
   * ]);
   */
  public async bulkWrite(
    modelName: string,
    operations: any[] = [],
    options: BulkWriteExtraOptions = {}
  ): Promise<BulkWriteResult> {
    const model = this._resolveModel(modelName);
    const ops = Array.isArray(operations) ? operations.filter(Boolean) : [];
    if (ops.length === 0) return { ok: true, result: null };
    const result = await model.bulkWrite(ops, options as any).catch(handleError);
    return { ok: true, result };
  }
}

const db = new KilicDB();
export = db;
