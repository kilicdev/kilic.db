export interface KilicErrorOptions {
  code?: string;
  hint?: string;
  details?: Record<string, any>;
  originalError?: any;
}

function formatDetails(details?: Record<string, any>): string[] {
  if (!details || Object.keys(details).length === 0) return [];

  return [
    "Details:",
    ...Object.entries(details)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => `  - ${key}: ${String(value)}`),
  ];
}

function formatMessage(message: string, code: string, hint?: string, details?: Record<string, any>): string {
  return [
    `[kilic.db:${code}]`,
    message,
    hint ? `Hint: ${hint}` : undefined,
    ...formatDetails(details),
  ].filter(Boolean).join("\n");
}

export class KilicError extends Error {
  public code: string;
  public hint?: string;
  public details?: Record<string, any>;
  public originalError?: any;

  constructor(message: string, codeOrOptions: string | KilicErrorOptions = "UNKNOWN_ERROR", originalError?: any) {
    const options = typeof codeOrOptions === "string"
      ? { code: codeOrOptions, originalError }
      : codeOrOptions;

    const code = options.code ?? "UNKNOWN_ERROR";
    super(formatMessage(message, code, options.hint, options.details));

    this.name = "KilicError";
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
    this.originalError = options.originalError;

    Object.setPrototypeOf(this, KilicError.prototype);
  }
}

export function handleError(err: any): never {
  if (err instanceof KilicError) {
    throw err;
  }

  if (err?.code === 11000) {
    const keyValue = err?.keyValue ? JSON.stringify(err.keyValue) : undefined;
    throw new KilicError("A document with the same unique value already exists.", {
      code: "DUPLICATE_KEY",
      hint: "Use update() for existing documents, or pass a create() filter that matches your unique key.",
      details: {
        collection: err?.collection,
        key: keyValue,
      },
      originalError: err,
    });
  }

  if (err?.name === "ValidationError") {
    const fields = err?.errors
      ? Object.entries(err.errors)
          .map(([field, fieldError]: [string, any]) => `${field}: ${fieldError?.message ?? "invalid value"}`)
          .join("; ")
      : undefined;

    throw new KilicError("Mongoose rejected the document because validation failed.", {
      code: "VALIDATION_ERROR",
      hint: "Check required fields, enum values, custom validators, and schema types.",
      details: {
        fields,
      },
      originalError: err,
    });
  }

  if (err?.name === "CastError") {
    throw new KilicError("Mongoose could not cast a value to the schema type it expected.", {
      code: "CAST_ERROR",
      hint: "Check IDs, filter values, and update payload types before calling kilic.db.",
      details: {
        path: err?.path,
        expected: err?.kind,
        value: err?.value,
      },
      originalError: err,
    });
  }

  const message = err?.message || "An unknown database error occurred.";
  const code = err?.code || "DATABASE_ERROR";

  throw new KilicError(message, {
    code: String(code),
    hint: "Inspect originalError for the underlying Mongoose or MongoDB failure.",
    originalError: err,
  });
}
