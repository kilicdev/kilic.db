"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const mongoose_1 = __importDefault(require("mongoose"));
const fs = __importStar(require("fs"));
const nodePath = __importStar(require("path"));
const errors_1 = require("./errors");
class KilicDB {
    _config = {};
    _cache = new Map();
    _connected = false;
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
    get mongoose() {
        return mongoose_1.default;
    }
    /**
     * Raw Mongoose connection.
     * Use this to listen to `disconnected`, `reconnected` events globally.
     *
     * @example
     * db.connection.on('disconnected', () => console.error('DB dropped!'));
     */
    get connection() {
        return mongoose_1.default.connection;
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
    config(options) {
        this._config = { ...this._config, ...options };
        if (!this._config.url)
            return;
        // Prevent double-connecting if already in connected/connecting state
        const state = mongoose_1.default.connection.readyState;
        if (state === 1 || state === 2) {
            this._log("Already connected or connecting — skipping duplicate connection.");
            return;
        }
        mongoose_1.default.set("strictQuery", true);
        // Non-blocking. Mongoose buffers all operations until connection resolves.
        mongoose_1.default.connect(this._config.url, this._config.options ?? {})
            .then(() => {
            this._connected = true;
            this._log("Connected to MongoDB.");
        })
            .catch((err) => {
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
    model(modelName) {
        return this._resolveModel(modelName);
    }
    // ─────────────────────────────────────────────────────────────
    // Internal
    // ─────────────────────────────────────────────────────────────
    _log(msg, ...args) {
        if (this._config.debug) {
            console.log(`[kilic.db] ${msg}`, ...args);
        }
    }
    _resolveModel(modelName) {
        // 1. Hot cache
        if (this._cache.has(modelName)) {
            return this._cache.get(modelName);
        }
        // 2. Already-registered Mongoose model
        if (mongoose_1.default.models[modelName]) {
            this._cache.set(modelName, mongoose_1.default.models[modelName]);
            return mongoose_1.default.models[modelName];
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
                        if (loaded && loaded.default)
                            loaded = loaded.default;
                        this._cache.set(modelName, loaded);
                        this._log(`Loaded model '${modelName}' from ${filePath}`);
                        return loaded;
                    }
                    catch (err) {
                        throw new errors_1.KilicError(`Failed to load model '${modelName}' from ${filePath}: ${err?.message}`, "MODEL_LOAD_ERROR", err);
                    }
                }
            }
        }
        throw new errors_1.KilicError(`Model '${modelName}' not found.\n` +
            `  → Ensure it is registered via mongoose.model() before use, OR\n` +
            `  → Set 'path' in db.config() to your models directory.`, "MODEL_NOT_FOUND");
    }
    _applyPopulate(query, populate) {
        if (!populate)
            return query;
        if (Array.isArray(populate)) {
            populate.forEach((p) => { query = query.populate(p); });
        }
        else {
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
    async create(modelName, data = {}, options = {}) {
        const model = this._resolveModel(modelName);
        const filter = options.filter ?? (data.id ? { id: data.id } : null);
        if (!filter) {
            throw new errors_1.KilicError(`create('${modelName}') requires a unique filter.\n` +
                `  → Either set data.id, or pass options.filter explicitly.\n` +
                `  → Example: db.create("User", { email: "..." }, { filter: { email: "..." } })`, "MISSING_FILTER");
        }
        const updatePayload = options.force
            ? { $set: data }
            : { $setOnInsert: data };
        const queryOptions = {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true,
        };
        if (options.session)
            queryOptions.session = options.session;
        try {
            const doc = await model.findOneAndUpdate(filter, updatePayload, queryOptions).lean();
            return doc ?? null;
        }
        catch (err) {
            // Race condition: another request inserted between our check and upsert
            if (err?.code === 11000) {
                const existing = await model.findOne(filter, null, options.session ? { session: options.session } : {}).lean();
                if (options.force && existing) {
                    const forced = await model.findOneAndUpdate(filter, { $set: data }, { new: true, ...(options.session ? { session: options.session } : {}) }).lean();
                    return forced ?? null;
                }
                return existing ?? null;
            }
            (0, errors_1.handleError)(err);
        }
    }
    /**
     * Find a single document.
     *
     * @example
     * const user = await db.get("User", { email: "test@test.com" });
     * const user = await db.get("User", { id: "123" }, { projection: { password: 0 } });
     */
    async get(modelName, filter = {}, options = {}) {
        const model = this._resolveModel(modelName);
        let query = model.findOne(filter, options.projection, options.session ? { session: options.session } : {});
        if (options.lean !== false)
            query = query.lean();
        query = this._applyPopulate(query, options.populate);
        const doc = await query.exec().catch(errors_1.handleError);
        return doc ?? null;
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
    async update(modelName, data = {}, options = {}) {
        const model = this._resolveModel(modelName);
        if (!options.filter && !options.force) {
            throw new errors_1.KilicError(`update('${modelName}') requires options.filter.\n` +
                `  → Pass { filter: { id: "..." } } as the third argument.\n` +
                `  → Or use { force: true } to update without a filter (matches first document).`, "MISSING_FILTER");
        }
        const filter = options.filter ?? {};
        // Auto-wrap plain objects in $set so users don't need to know Mongoose operators
        const hasOperators = Object.keys(data).some((k) => k.startsWith("$"));
        const updatePayload = hasOperators ? data : { $set: data };
        const queryOptions = { new: true };
        if (options.upsert)
            queryOptions.upsert = true;
        if (options.session)
            queryOptions.session = options.session;
        try {
            if (options.multi) {
                const result = await model.updateMany(filter, updatePayload, queryOptions);
                return result;
            }
            const doc = await model.findOneAndUpdate(filter, updatePayload, queryOptions).lean();
            return doc ?? false;
        }
        catch (err) {
            if (err?.code === 11000)
                return false;
            (0, errors_1.handleError)(err);
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
    async delete(modelName, filter = {}, options = {}) {
        const model = this._resolveModel(modelName);
        const queryOptions = options.session ? { session: options.session } : {};
        try {
            if (options.force || options.multi) {
                const result = await model.deleteMany(filter, queryOptions);
                return { success: true, deletedCount: result.deletedCount };
            }
            else {
                const result = await model.deleteOne(filter, queryOptions);
                return { success: true, deletedCount: result.deletedCount };
            }
        }
        catch (err) {
            if (options.force)
                return { success: true, deletedCount: 0 };
            (0, errors_1.handleError)(err);
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
    async find(modelName, filter = {}, options = {}) {
        const model = this._resolveModel(modelName);
        const sessionOpt = options.session ? { session: options.session } : {};
        let query = model.find(filter, options.projection, sessionOpt);
        if (options.lean !== false)
            query = query.lean();
        if (options.sort)
            query = query.sort(options.sort);
        if (options.skip)
            query = query.skip(Number(options.skip));
        if (options.limit)
            query = query.limit(Number(options.limit));
        query = this._applyPopulate(query, options.populate);
        if (options.cursor) {
            const cursor = query.cursor();
            const results = [];
            try {
                for await (const doc of cursor) {
                    results.push(doc);
                }
            }
            catch (err) {
                (0, errors_1.handleError)(err);
            }
            return results;
        }
        const docs = await query.exec().catch(errors_1.handleError);
        return docs ?? [];
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
    async aggregate(modelName, pipeline = [], options = {}) {
        const model = this._resolveModel(modelName);
        let agg = model.aggregate(pipeline);
        if (options.options)
            agg = agg.option(options.options);
        if (options.session)
            agg = agg.session(options.session);
        return agg.exec().catch(errors_1.handleError);
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
    async countDocuments(modelName, filter = {}, options = {}) {
        const model = this._resolveModel(modelName);
        const queryOptions = options.session ? { session: options.session } : {};
        return model.countDocuments(filter, queryOptions).catch(errors_1.handleError);
    }
    /**
     * Get an ultra-fast estimated total count of the collection.
     * Does not accept a filter — uses collection metadata.
     *
     * @example
     * const total = await db.estimatedDocumentCount("User");
     */
    async estimatedDocumentCount(modelName) {
        const model = this._resolveModel(modelName);
        return model.estimatedDocumentCount().catch(errors_1.handleError);
    }
    /**
     * Find distinct values for a given field.
     *
     * @example
     * const tags = await db.distinct("Article", "tags", { published: true });
     */
    async distinct(modelName, field, filter = {}) {
        const model = this._resolveModel(modelName);
        return model.distinct(field, filter).exec().catch(errors_1.handleError);
    }
    /**
     * Bulk insert an array of documents. Faster than calling create() in a loop.
     *
     * @example
     * await db.insertMany("Product", [{ name: "A" }, { name: "B" }]);
     */
    async insertMany(modelName, docs = [], options = {}) {
        const model = this._resolveModel(modelName);
        const result = await model.insertMany(docs, options).catch(errors_1.handleError);
        return result;
    }
    /**
     * Find a document by ID.
     *
     * @example
     * const user = await db.findById("User", "64abc123...");
     */
    async findById(modelName, id, options = {}) {
        const model = this._resolveModel(modelName);
        let query = model.findById(id, options.projection, options.session ? { session: options.session } : {});
        if (options.lean !== false)
            query = query.lean();
        query = this._applyPopulate(query, options.populate);
        const doc = await query.exec().catch(errors_1.handleError);
        return doc ?? null;
    }
    /**
     * Find a document by ID and delete it atomically.
     *
     * @example
     * const deleted = await db.findByIdAndDelete("User", "64abc123...");
     */
    async findByIdAndDelete(modelName, id, options = {}) {
        const model = this._resolveModel(modelName);
        const doc = await model.findByIdAndDelete(id, options).lean().catch(errors_1.handleError);
        return doc ?? null;
    }
    /**
     * Find a document matching a filter and delete it atomically.
     *
     * @example
     * const deleted = await db.findOneAndDelete("User", { email: "test@test.com" });
     */
    async findOneAndDelete(modelName, filter = {}, options = {}) {
        const model = this._resolveModel(modelName);
        const doc = await model.findOneAndDelete(filter, options).lean().catch(errors_1.handleError);
        return doc ?? null;
    }
    /**
     * Replace an entire document (not a partial update).
     *
     * @example
     * await db.replaceOne("User", { id: "123" }, { id: "123", name: "New", email: "..." });
     */
    async replaceOne(modelName, filter = {}, replacement = {}, options = {}) {
        const model = this._resolveModel(modelName);
        const doc = await model.findOneAndReplace(filter, replacement, { new: true, ...options }).lean().catch(errors_1.handleError);
        return doc ?? null;
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
    async bulkWrite(modelName, operations = [], options = {}) {
        const model = this._resolveModel(modelName);
        const ops = Array.isArray(operations) ? operations.filter(Boolean) : [];
        if (ops.length === 0)
            return { ok: true, result: null };
        const result = await model.bulkWrite(ops, options).catch(errors_1.handleError);
        return { ok: true, result };
    }
}
const db = new KilicDB();
module.exports = db;
//# sourceMappingURL=index.js.map