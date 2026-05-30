import { AggregateOptions as MongooseAggregateOptions, ClientSession, ConnectOptions } from "mongoose";

export { KilicError } from "./errors";

export type Filter = Record<string, any>;
export type Data = Record<string, any>;
export type Projection = Record<string, 0 | 1 | boolean>;
export type Populate = string | string[] | Record<string, any>;
export type FilterResolver = Filter | Filter[] | ((data: Data, index: number) => Filter);

export interface KilicDBConfig {
  /**
   * MongoDB connection URL.
   * When omitted, kilic.db starts a mongodb-memory-server-core replica set and persists data to `file`.
   */
  url?: string;

  /**
   * Additional Mongoose connection options.
   */
  options?: ConnectOptions;

  /**
   * Absolute path to the directory containing your Mongoose model files.
   */
  path?: string;

  /**
   * JSON file used by the built-in mongodb-memory-server mode.
   * Defaults to `<cwd>/kilic.db.json` when `url` is omitted.
   */
  file?: string;

  /**
   * Database name used by the built-in mongodb-memory-server mode.
   * Defaults to the existing file store database name, then `kilicdb`.
   */
  database?: string;

  /**
   * Options passed to MongoMemoryReplSet.create() when `url` is omitted.
   */
  memoryServerOptions?: Record<string, any>;

  /**
   * Directory where db.backup() writes dated zip files.
   * Defaults to `<cwd>/backups`.
   */
  backupDir?: string;

  /**
   * Enable verbose debug logging.
   */
  debug?: boolean;
}

export interface CreateOptions {
  /**
   * Custom filter used to identify the document.
   * If omitted, kilic.db uses `data.id`.
   * For array creates, pass an array of filters or a filter resolver function.
   */
  filter?: FilterResolver;

  /**
   * Mongoose ClientSession for transactions.
   */
  session?: ClientSession;
}

export interface ReadOptions {
  /**
   * Field projection.
   */
  projection?: Projection;

  /**
   * Return plain JavaScript objects instead of Mongoose documents.
   * Defaults to `true`.
   */
  lean?: boolean;

  /**
   * Populate fields after query.
   */
  populate?: Populate;

  /**
   * Mongoose ClientSession for transactions.
   */
  session?: ClientSession;
}

export type GetOptions = ReadOptions;

export interface FindOptions extends ReadOptions {
  /**
   * Sort documents. Example: `{ createdAt: -1 }` or `"-createdAt"`.
   */
  sort?: string | Record<string, 1 | -1>;

  /**
   * Number of documents to skip.
   */
  skip?: number;

  /**
   * Maximum documents to return.
   */
  limit?: number;

  /**
   * Return a Mongoose cursor instead of loading all results into memory.
   */
  cursor?: boolean;

  /**
   * Cursor options passed to Mongoose.
   */
  cursorOptions?: Record<string, any>;
}

export interface UpdateOptions {
  /**
   * Update every document matching `filter` with the same payload.
   */
  multi?: boolean;

  /**
   * Return plain JavaScript objects instead of Mongoose documents.
   * Defaults to `true`.
   */
  lean?: boolean;

  /**
   * Mongoose ClientSession for transactions.
   */
  session?: ClientSession;
}

export interface DeleteOptions {
  /**
   * Delete every document matching `filter`.
   */
  multi?: boolean;

  /**
   * Mongoose ClientSession for transactions.
   */
  session?: ClientSession;
}

export interface CountOptions {
  /**
   * Mongoose ClientSession for transactions.
   */
  session?: ClientSession;
}

export interface AggregateOptions extends MongooseAggregateOptions {
  /**
   * Mongoose ClientSession for transactions.
   */
  session?: ClientSession;
}

export interface BackupOptions {
  /**
   * Override the configured backup directory for this run.
   */
  backupDir?: string;

  /**
   * Custom backup id used in the zip file name.
   */
  id?: string;

  /**
   * Cursor batch size per collection.
   */
  batchSize?: number;
}

export interface UpdateResult {
  success: boolean;
  matchedCount: number;
  modifiedCount: number;
}

export interface DeleteResult {
  success: boolean;
  deletedCount: number;
}

export interface BackupCollectionResult {
  collection: string;
  count: number;
  file: string;
}

export interface BackupResult {
  success: boolean;
  id: string;
  file: string;
  directory: string;
  database: string;
  collections: BackupCollectionResult[];
  size: number;
  createdAt: string;
}
