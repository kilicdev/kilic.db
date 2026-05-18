/**
 * Custom error class for kilic.db
 */
export class KilicError extends Error {
  public code: string;
  public originalError?: any;

  constructor(message: string, code: string = "UNKNOWN_ERROR", originalError?: any) {
    super(`[kilic.db] ${message}`);
    this.name = "KilicError";
    this.code = code;
    this.originalError = originalError;

    // Set prototype explicitly for extending Error in TypeScript
    Object.setPrototypeOf(this, KilicError.prototype);
  }
}

/**
 * Wraps raw Mongoose errors and standard Errors into KilicError
 */
export function handleError(err: any): never {
  if (err instanceof KilicError) {
    throw err;
  }

  // Handle Mongoose Duplicate Key (11000)
  if (err?.code === 11000) {
    throw new KilicError("Duplicate key error. A document with this unique field already exists.", "DUPLICATE_KEY", err);
  }

  // Handle Mongoose Validation Error
  if (err?.name === "ValidationError") {
    throw new KilicError(`Validation failed: ${err.message}`, "VALIDATION_ERROR", err);
  }

  // Handle Mongoose Cast Error (e.g. invalid ObjectId)
  if (err?.name === "CastError") {
    throw new KilicError(`Invalid data type or ID: ${err.message}`, "CAST_ERROR", err);
  }

  // Fallback for other errors
  const message = err?.message || "An unknown database error occurred.";
  const code = err?.code || "DATABASE_ERROR";
  
  throw new KilicError(message, String(code), err);
}
