import { ConnectOptions, ClientSession } from "mongoose";
export { KilicError } from "./errors";
export interface KilicDBConfig {
    /**
     * MongoDB connection URL.
     * @example "mongodb://localhost:27017/myapp"
     * @example "mongodb+srv://user:pass@cluster.mongodb.net/myapp"
     */
    url?: string;
    /**
     * Additional Mongoose connection options (poolSize, ssl, etc.)
     */
    options?: ConnectOptions;
    /**
     * Absolute path to the directory containing your Mongoose model files.
     * Each file should export a Mongoose Model as `module.exports` or `export default`.
     * If omitted, the wrapper will only resolve models registered via `mongoose.model()`.
     * @example path.join(__dirname, "models")
     */
    path?: string;
    /**
     * Enable verbose debug logging to stdout.
     */
    debug?: boolean;
}
export interface CreateOptions {
    /**
     * Custom filter to find an existing document.
     * Required when your data has no `id` field.
     */
    filter?: Record<string, any>;
    /**
     * If `true`, overwrites existing fields with `$set` instead of only writing on insert (`$setOnInsert`).
     * Also handles 11000 duplicate key race conditions gracefully.
     */
    force?: boolean;
    /**
     * Mongoose ClientSession for use inside Transactions.
     */
    session?: ClientSession;
}
export interface GetOptions {
    /**
     * Field projection — which fields to include or exclude.
     */
    projection?: Record<string, 0 | 1>;
    /**
     * Return lean plain JS object instead of full Mongoose Document. Defaults to `true`.
     */
    lean?: boolean;
    /**
     * Populate fields after query.
     */
    populate?: string | string[] | Record<string, any>;
    /**
     * Mongoose ClientSession for use inside Transactions.
     */
    session?: ClientSession;
}
export interface UpdateOptions {
    /**
     * Filter to find the document to update.
     * Required unless `force: true` is passed.
     */
    filter?: Record<string, any>;
    /**
     * If `true`, allows updating without a filter (dangerous — updates first match).
     */
    force?: boolean;
    /**
     * Run update on all matching documents instead of just the first.
     */
    multi?: boolean;
    /**
     * If `true`, creates the document if it doesn't exist.
     */
    upsert?: boolean;
    /**
     * Mongoose ClientSession for use inside Transactions.
     */
    session?: ClientSession;
}
export interface DeleteOptions {
    /**
     * If `true`, deletes all matching documents (deleteMany) and never throws if nothing is found.
     */
    force?: boolean;
    /**
     * Delete all matching documents.
     */
    multi?: boolean;
    /**
     * Mongoose ClientSession for use inside Transactions.
     */
    session?: ClientSession;
}
export interface FindOptions {
    /**
     * Field projection — which fields to include or exclude.
     */
    projection?: Record<string, 0 | 1>;
    /**
     * Sort documents. `{ createdAt: -1 }` or `"-createdAt"`.
     */
    sort?: string | Record<string, 1 | -1>;
    /**
     * Number of documents to skip (for pagination).
     */
    skip?: number;
    /**
     * Maximum documents to return.
     */
    limit?: number;
    /**
     * Return lean plain JS objects instead of full Mongoose Documents. Defaults to `true`.
     */
    lean?: boolean;
    /**
     * Instead of returning an array, stream via a memory-safe cursor. Useful for millions of records.
     */
    cursor?: boolean;
    /**
     * Populate fields after query.
     */
    populate?: string | string[] | Record<string, any>;
    /**
     * Mongoose ClientSession for use inside Transactions.
     */
    session?: ClientSession;
}
export interface AggregateExtraOptions {
    /**
     * Extra options passed directly to Mongoose aggregate (allowDiskUse, etc.)
     */
    options?: Record<string, any>;
    /**
     * Mongoose ClientSession for use inside Transactions.
     */
    session?: ClientSession;
}
export interface InsertManyExtraOptions {
    /**
     * If `true`, continues inserting remaining documents even if one fails.
     */
    ordered?: boolean;
    /**
     * Mongoose ClientSession for use inside Transactions.
     */
    session?: ClientSession;
}
export interface BulkWriteExtraOptions {
    /**
     * If `true` (default), stop processing on first error. Set to `false` for unordered writes.
     */
    ordered?: boolean;
    /**
     * Mongoose ClientSession for use inside Transactions.
     */
    session?: ClientSession;
}
export interface CountOptions {
    /**
     * Mongoose ClientSession for use inside Transactions.
     */
    session?: ClientSession;
}
export interface DeleteResult {
    success: boolean;
    deletedCount?: number;
}
export interface BulkWriteResult {
    ok: boolean;
    result: any;
}
//# sourceMappingURL=types.d.ts.map