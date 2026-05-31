export { KilicError } from "./errors";

export type Filter = Record<string, any>;
export type Data = Record<string, any>;
export type Projection = Record<string, 0 | 1 | boolean>;
export type Populate = string | string[] | Record<string, any>;
export type FilterResolver = Filter | Filter[] | ((data: Data, index: number) => Filter);
export type DatabaseType = "local" | "server";
export type ModelSchemaDefinition<T = any> = Record<keyof T & string, any> | Record<string, any> | object;
export type ModelSchemaOptions = Record<string, any>;
export type ClientSession = any;
export type ConnectOptions = Record<string, any>;
export type MongooseAggregateOptions = Record<string, any>;

export interface KilicRawModel<T = any> {
  modelName: string;
  collection: any;
  create(doc: Partial<T> | Partial<T>[], options?: Record<string, any>): Promise<any>;
  find(filter?: Filter, projection?: Projection | null, options?: Record<string, any>): any;
  findOne(filter?: Filter, projection?: Projection | null, options?: Record<string, any>): any;
  findOneAndUpdate(filter: Filter, update: Record<string, any>, options?: Record<string, any>): any;
  updateMany(filter: Filter, update: Record<string, any>, options?: Record<string, any>): Promise<any>;
  deleteOne(filter: Filter, options?: Record<string, any>): Promise<any>;
  deleteMany(filter: Filter, options?: Record<string, any>): Promise<any>;
  aggregate<R = any>(pipeline?: any[]): any;
  countDocuments(filter?: Filter, options?: Record<string, any>): Promise<number>;
  estimatedDocumentCount(options?: Record<string, any>): Promise<number>;
  init(): Promise<KilicRawModel<T>>;
  [key: string]: any;
}

export interface KilicConfigContinuation {
  <T>(value: T): T;
}

export interface KilicModelAccessor {
  <T = any>(modelName: string): KilicRawModel<T>;
  <T = any>(modelName: string, definition: ModelSchemaDefinition<T>, options?: ModelSchemaOptions): KilicRawModel<T>;
  new <T = any>(modelName: string, definition: ModelSchemaDefinition<T>, options?: ModelSchemaOptions): KilicRawModel<T>;
}

export interface KilicDBConfig {
  /**
   * Database mode.
   * `server` connects to the configured MongoDB `url`.
   * `local` starts the built-in file-backed mongodb-memory-server mode.
   * Defaults to `server` when `url` is provided, otherwise `local`.
   */
  type?: DatabaseType;

  /**
   * MongoDB connection URL.
   * Required when `type` is `server`.
   */
  url?: string;

  /**
   * Additional Mongoose connection options.
   */
  options?: ConnectOptions;

  /**
   * Directory containing collection/model files.
   * Files may export a Mongoose model or use `module.exports = new db.model("Name", schema)`.
   */
  collections?: string;

  /**
   * @deprecated Use `collections` instead. This alias is kept for older projects.
   */
  path?: string;

  /**
   * Data file used by local file-backed mode.
   * The `.kd` extension is enforced automatically — any other extension is replaced.
   * Defaults to `<cwd>/datas.kd` in local mode.
   */
  file?: string;

  /**
   * Database name used by local file-backed mode.
   * Defaults to the existing file store database name, then `kilicdb`.
   */
  database?: string;

  /**
   * Override Node.js process.cwd() for file-backed mode path resolution.
   * Used only in tests, for dynamic temporary directory handling.
   */
  cwd?: string;

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
   * Create the document if it does not exist.
   */
  upsert?: boolean;

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
