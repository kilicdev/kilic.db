import mongoose, { Model, Connection, PipelineStage } from "mongoose";
import { KilicDBConfig, CreateOptions, GetOptions, UpdateOptions, DeleteOptions, FindOptions, AggregateExtraOptions, InsertManyExtraOptions, BulkWriteExtraOptions, CountOptions, DeleteResult, BulkWriteResult } from "./types";
declare class KilicDB {
    private _config;
    private _cache;
    private _connected;
    /**
     * Raw `mongoose` instance.
     * Use this for ACID Transactions, global plugins, etc.
     *
     * @example
     * const session = await db.mongoose.startSession();
     */
    get mongoose(): typeof mongoose;
    /**
     * Raw Mongoose connection.
     * Use this to listen to `disconnected`, `reconnected` events globally.
     *
     * @example
     * db.connection.on('disconnected', () => console.error('DB dropped!'));
     */
    get connection(): Connection;
    /**
     * Configure and connect to MongoDB in the background.
     * You can start writing queries immediately — Mongoose buffers commands automatically.
     *
     * @example
     * db.config({ url: "mongodb://localhost:27017/myapp", path: path.join(__dirname, "models") });
     */
    config(options: KilicDBConfig): void;
    /**
     * Retrieve a raw Mongoose Model by name.
     * This is an escape hatch for any operation not covered by this wrapper.
     *
     * @example
     * const User = db.model("User");
     * User.watch().on("change", (change) => console.log(change)); // Change Streams
     */
    model<T = any>(modelName: string): Model<T>;
    private _log;
    private _resolveModel;
    private _applyPopulate;
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
    create<T = any>(modelName: string, data?: Record<string, any>, options?: CreateOptions): Promise<T | null>;
    /**
     * Find a single document.
     *
     * @example
     * const user = await db.get("User", { email: "test@test.com" });
     * const user = await db.get("User", { id: "123" }, { projection: { password: 0 } });
     */
    get<T = any>(modelName: string, filter?: Record<string, any>, options?: GetOptions): Promise<T | null>;
    /**
     * Update a single document and return the updated document.
     *
     * @param data - Mongoose update operator object, e.g. `{ $set: { name: "..." } }` or plain object `{ name: "..." }` (auto-wrapped in $set)
     *
     * @example
     * await db.update("User", { $set: { name: "John" } }, { filter: { id: "123" } });
     * await db.update("User", { $inc: { score: 1 } }, { filter: { id: "123" } });
     */
    update<T = any>(modelName: string, data?: Record<string, any>, options?: UpdateOptions): Promise<T | false>;
    /**
     * Delete one or many documents.
     *
     * @example
     * await db.delete("User", { id: "123" });
     * await db.delete("User", { status: "banned" }, { multi: true });
     * await db.delete("User", { status: "banned" }, { force: true }); // deleteMany, never throws
     */
    delete(modelName: string, filter?: Record<string, any>, options?: DeleteOptions): Promise<DeleteResult>;
    /**
     * Find multiple documents with full pagination support.
     *
     * @example
     * const users = await db.find("User", { status: "active" }, { limit: 10, skip: 0, sort: { createdAt: -1 } });
     */
    find<T = any>(modelName: string, filter?: Record<string, any>, options?: FindOptions): Promise<T[]>;
    /**
     * Run a native MongoDB aggregation pipeline.
     *
     * @example
     * const stats = await db.aggregate("Orders", [
     *   { $match: { status: "completed" } },
     *   { $group: { _id: "$userId", total: { $sum: "$amount" } } }
     * ]);
     */
    aggregate<T = any>(modelName: string, pipeline?: PipelineStage[], options?: AggregateExtraOptions): Promise<T[]>;
    /**
     * Count documents matching a filter.
     *
     * @example
     * const count = await db.countDocuments("User", { status: "active" });
     */
    countDocuments(modelName: string, filter?: Record<string, any>, options?: CountOptions): Promise<number>;
    /**
     * Get an ultra-fast estimated total count of the collection.
     * Does not accept a filter — uses collection metadata.
     *
     * @example
     * const total = await db.estimatedDocumentCount("User");
     */
    estimatedDocumentCount(modelName: string): Promise<number>;
    /**
     * Find distinct values for a given field.
     *
     * @example
     * const tags = await db.distinct("Article", "tags", { published: true });
     */
    distinct<T = any>(modelName: string, field: string, filter?: Record<string, any>): Promise<T[]>;
    /**
     * Bulk insert an array of documents. Faster than calling create() in a loop.
     *
     * @example
     * await db.insertMany("Product", [{ name: "A" }, { name: "B" }]);
     */
    insertMany<T = any>(modelName: string, docs?: Record<string, any>[], options?: InsertManyExtraOptions): Promise<T[]>;
    /**
     * Find a document by ID.
     *
     * @example
     * const user = await db.findById("User", "64abc123...");
     */
    findById<T = any>(modelName: string, id: string, options?: GetOptions): Promise<T | null>;
    /**
     * Find a document by ID and delete it atomically.
     *
     * @example
     * const deleted = await db.findByIdAndDelete("User", "64abc123...");
     */
    findByIdAndDelete<T = any>(modelName: string, id: string, options?: {
        session?: any;
    }): Promise<T | null>;
    /**
     * Find a document matching a filter and delete it atomically.
     *
     * @example
     * const deleted = await db.findOneAndDelete("User", { email: "test@test.com" });
     */
    findOneAndDelete<T = any>(modelName: string, filter?: Record<string, any>, options?: {
        session?: any;
    }): Promise<T | null>;
    /**
     * Replace an entire document (not a partial update).
     *
     * @example
     * await db.replaceOne("User", { id: "123" }, { id: "123", name: "New", email: "..." });
     */
    replaceOne<T = any>(modelName: string, filter?: Record<string, any>, replacement?: Record<string, any>, options?: {
        upsert?: boolean;
        session?: any;
    }): Promise<T | null>;
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
    bulkWrite(modelName: string, operations?: any[], options?: BulkWriteExtraOptions): Promise<BulkWriteResult>;
}
declare const db: KilicDB;
export = db;
//# sourceMappingURL=index.d.ts.map