# kilic.db

[![npm version](https://img.shields.io/npm/v/kilic.db.svg)](https://www.npmjs.com/package/kilic.db)
[![npm downloads](https://img.shields.io/npm/dm/kilic.db.svg)](https://www.npmjs.com/package/kilic.db)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-ready-blue.svg)](https://www.typescriptlang.org/)

> Zero-boilerplate, singleton-based MongoDB wrapper for Node.js.  
> Configure once. `require()` everywhere. Never worry about connections again.

---

## Why kilic.db?

| Problem | kilic.db |
|---|---|
| Repeating `mongoose.connect()` across files | Configure once in `app.js`, use everywhere |
| Connection race conditions on startup | Mongoose Command Buffering — works instantly |
| Boilerplate for every query | Direct, readable methods |
| Race conditions on `create()` | Atomic upserts with 11000 fallback |
| "I need raw Mongoose for complex queries" | Escape hatches built in |

---

## Installation

```bash
npm install kilic.db
npm install mongoose   # peer dependency
```

---

## Quick Start

### 1. Configure (once, in your entry file)

```js
// app.js or server.js
const db = require("kilic.db");
const path = require("path");

db.config({
  url: "mongodb://localhost:27017/myapp",
  path: path.join(__dirname, "models"), // auto-loads models from this folder
  debug: true,
});
```

> ✅ `db.config()` connects to MongoDB **in the background** — no `await` needed.  
> Mongoose automatically buffers all subsequent operations until the connection resolves.

### 2. Use anywhere in your project

```js
// routes/users.js — no db.connect(), no imports, no setup
const db = require("kilic.db");

async function getUser(id) {
  return db.get("User", { id });
}

async function registerUser(data) {
  return db.create("User", data, { filter: { email: data.email } });
}
```

---

## API Reference

### `db.config(options)`

| Option | Type | Description |
|---|---|---|
| `url` | `string` | MongoDB connection string |
| `path` | `string` | Absolute path to your Mongoose models folder |
| `options` | `object` | Standard Mongoose connection options |
| `debug` | `boolean` | Enable verbose console logging |

---

### `db.create(model, data, options?)`

Atomically creates or returns a document using `findOneAndUpdate` with `upsert: true`.
Handles race conditions (duplicate key `11000` errors) gracefully.

```js
// Basic — filter derived from data.id
const user = await db.create("User", { id: "123", name: "Alice" });

// With explicit filter
const user = await db.create("User", 
  { email: "alice@example.com", name: "Alice" },
  { filter: { email: "alice@example.com" } }
);

// Force: overwrites existing fields (uses $set instead of $setOnInsert)
const user = await db.create("User",
  { id: "123", role: "admin" },
  { force: true }
);
```

---

### `db.get(model, filter, options?)`

Find a single document. Returns a plain JS object (lean) by default.

```js
const user = await db.get("User", { id: "123" });

// With field projection (exclude password)
const user = await db.get("User", { id: "123" }, { 
  projection: { password: 0 } 
});

// With populate
const post = await db.get("Post", { id: "abc" }, { 
  populate: "author" 
});
```

---

### `db.update(model, data, options?)`

Update a document. Plain objects are automatically wrapped in `$set`. Supports all Mongoose update operators.

```js
// Simple field update — auto-wrapped in $set
await db.update("User", { name: "Bob" }, { filter: { id: "123" } });

// Using Mongoose operators directly
await db.update("User", { $inc: { loginCount: 1 } }, { filter: { id: "123" } });

// Update with $set and $push
await db.update("Post", 
  { $set: { title: "New" }, $push: { tags: "nodejs" } },
  { filter: { id: "abc" } }
);

// Update all matching documents
await db.update("User", 
  { $set: { status: "inactive" } },
  { filter: { lastLogin: { $lt: new Date("2024-01-01") } }, multi: true }
);

// Upsert (create if not found)
await db.update("Settings",
  { theme: "dark" },
  { filter: { userId: "123" }, upsert: true }
);
```

---

### `db.delete(model, filter, options?)`

```js
// Delete one
await db.delete("User", { id: "123" });

// Delete many
await db.delete("Session", { expired: true }, { multi: true });

// Force delete — uses deleteMany and never throws if nothing matched
await db.delete("TempFile", { ttl: { $lt: Date.now() } }, { force: true });
```

---

### `db.find(model, filter, options?)`

Retrieve multiple documents with full pagination, sorting, and population support.

```js
// Basic find
const users = await db.find("User", { status: "active" });

// Paginated + sorted
const users = await db.find("User", { status: "active" }, {
  limit: 20,
  skip: 40,
  sort: { createdAt: -1 },
  projection: { password: 0 },
});

// Memory-safe cursor for huge datasets (millions of records)
const logs = await db.find("Log", { level: "error" }, { cursor: true });
```

---

### `db.aggregate(model, pipeline, options?)`

Full native MongoDB aggregation pipeline support.

```js
const stats = await db.aggregate("Order", [
  { $match: { status: "completed" } },
  { $group: { _id: "$userId", total: { $sum: "$amount" }, count: { $sum: 1 } } },
  { $sort: { total: -1 } },
  { $limit: 10 }
]);

// With allowDiskUse for large datasets
const stats = await db.aggregate("Log", pipeline, {
  options: { allowDiskUse: true }
});
```

---

### `db.distinct(model, field, filter?)`

```js
const uniqueTags = await db.distinct("Article", "tags", { published: true });
// → ["nodejs", "mongodb", "typescript"]
```

---

### `db.countDocuments(model, filter?, options?)`

```js
const activeUsers = await db.countDocuments("User", { status: "active" });
```

### `db.estimatedDocumentCount(model)`

Ultra-fast count using collection metadata. Does not accept a filter.

```js
const total = await db.estimatedDocumentCount("User");
```

---

### `db.insertMany(model, docs, options?)`

Bulk insert an array of documents. Significantly faster than `create()` in a loop.

```js
await db.insertMany("Product", [
  { name: "Widget A", price: 9.99 },
  { name: "Widget B", price: 14.99 },
]);
```

---

### `db.findById(model, id, options?)`

```js
const user = await db.findById("User", "64abc123def456...");
```

---

### `db.findOneAndDelete(model, filter, options?)`

Find and atomically delete a document, returning the deleted document.

```js
const removed = await db.findOneAndDelete("Session", { token: "abc123" });
```

### `db.findByIdAndDelete(model, id, options?)`

```js
const removed = await db.findByIdAndDelete("User", "64abc123...");
```

---

### `db.replaceOne(model, filter, replacement, options?)`

Replace an **entire** document (unlike `update` which does partial updates).

```js
await db.replaceOne("Config", { env: "production" }, {
  env: "production",
  featureFlags: { darkMode: true },
  version: 2,
});
```

---

### `db.bulkWrite(model, operations, options?)`

Execute multiple write operations in a single round-trip to MongoDB.

```js
await db.bulkWrite("User", [
  { insertOne: { document: { name: "Alice" } } },
  { updateOne: { filter: { id: "1" }, update: { $set: { role: "admin" } } } },
  { deleteOne: { filter: { id: "999" } } },
]);
```

---

## Advanced Usage

### ACID Transactions

Use `db.mongoose` to access the raw Mongoose instance for sessions and transactions.

```js
const session = await db.mongoose.startSession();
session.startTransaction();

try {
  await db.create("Order", orderData, { filter: { id: orderData.id }, session });
  await db.update("Inventory", { $inc: { stock: -1 } }, { filter: { sku: "ABC" }, session });
  await session.commitTransaction();
} catch (err) {
  await session.abortTransaction();
  throw err;
} finally {
  session.endSession();
}
```

---

### Change Streams

Use `db.model()` to get the raw Mongoose Model for Change Streams.

```js
const User = db.model("User");

User.watch([{ $match: { operationType: "insert" } }]).on("change", (change) => {
  console.log("New user registered:", change.fullDocument);
});
```

---

### Connection Events

```js
db.connection.on("connected", () => console.log("MongoDB connected"));
db.connection.on("disconnected", () => console.warn("MongoDB disconnected — retrying..."));
db.connection.on("error", (err) => console.error("MongoDB error:", err));
```

---

### Typing Your Models (TypeScript)

```ts
import db from "kilic.db";

interface IUser {
  id: string;
  name: string;
  email: string;
}

const user = await db.get<IUser>("User", { id: "123" });
user?.name; // typed ✅

const users = await db.find<IUser>("User", { status: "active" });
users[0].email; // typed ✅
```

---

## Escape Hatches

`kilic.db` never traps you. If you need raw Mongoose access, these are always available:

| Property | Returns | Use case |
|---|---|---|
| `db.model("User")` | `mongoose.Model` | Change Streams, custom methods, direct queries |
| `db.mongoose` | `typeof mongoose` | Transactions, plugins, global settings |
| `db.connection` | `mongoose.Connection` | Connection events, multi-tenancy |

---

## License

MIT © [kilicdev](https://github.com/kilicdev)
