<div align="center">

# kilic.db

### Tiny MongoDB commands for Node.js projects that already love Mongoose.

[![npm version](https://img.shields.io/npm/v/kilic.db.svg?style=for-the-badge)](https://www.npmjs.com/package/kilic.db)
[![npm downloads](https://img.shields.io/npm/dm/kilic.db.svg?style=for-the-badge)](https://www.npmjs.com/package/kilic.db)
[![TypeScript](https://img.shields.io/badge/TypeScript-ready-3178c6.svg?style=for-the-badge)](https://www.typescriptlang.org/)
[![Docs](https://img.shields.io/badge/Docs-GitHub%20Pages-111827.svg?style=for-the-badge)](https://kilicdev.github.io/kilic.db)
[![License: MIT](https://img.shields.io/badge/License-MIT-111111.svg?style=for-the-badge)](LICENSE)

Configure once. Query everywhere. Keep the API small. Keep MongoDB powerful.

</div>

---

## Overview

`kilic.db` is a compact command layer over Mongoose. It gives everyday database work a clean shape without hiding the native MongoDB/Mongoose escape hatches.

```js
const db = require("kilic.db");

await db.create("User", { id: "u_1", email: "ada@example.com" });

const user = await db.get("User", { id: "u_1" });

await db.update("User", { $inc: { loginCount: 1 } }, {
  filter: { id: "u_1" },
});

const revenue = await db.aggregate("Order", [
  { $match: { status: "paid" } },
  { $group: { _id: "$currency", total: { $sum: "$amount" } } },
]);
```

## Why

| You want | kilic.db gives you |
|---|---|
| One database setup | `db.config()` once, then use it anywhere |
| Clear create/update semantics | `create()` inserts once, `update()` changes existing data |
| Small surface area | A focused command set instead of a giant wrapper |
| Safe defaults | Write methods reject empty filters and empty payloads |
| Real MongoDB power | First-class `aggregate()` plus raw `db.model()` |
| TypeScript without ceremony | Generic return types where they matter |

## Install

```bash
npm install kilic.db mongoose
```

`mongoose` is a peer dependency, so your app owns the actual Mongoose version.

`archiver` is installed with `kilic.db` and is used internally by `db.backup()`.

## Configure

```js
const db = require("kilic.db");
const path = require("path");

db.config({
  url: "mongodb://localhost:27017/myapp",
  path: path.join(__dirname, "models"),
  backupDir: path.join(__dirname, "backups"),
  debug: true,
});
```

`config()` starts the connection in the background. Mongoose buffers commands while the connection is opening.

Need an explicit boot barrier?

```js
await db.ready();
```

Config options:

| Option | Type | Purpose |
|---|---|---|
| `url` | `string` | MongoDB connection string |
| `options` | `ConnectOptions` | Options passed to `mongoose.connect()` |
| `path` | `string` | Directory for auto-loading model files |
| `backupDir` | `string` | Default output directory for `db.backup()` |
| `debug` | `boolean` | Print small kilic.db lifecycle logs |

## Command Map

| Command | Reads like | Supports |
|---|---|---|
| `config(options)` | connect and configure | `url`, `path`, Mongoose connect options |
| `ready()` | wait for connection | startup checks |
| `create(model, data, options?)` | create once | single data, array data, custom filters |
| `get(model, filter, options?)` | read one | projection, populate, session, lean control |
| `update(model, data, options?)` | update data | single update, array updates, `multi` |
| `delete(model, filter, options?)` | delete data | single filter, array filters, `multi` |
| `find(model, filter?, options?)` | read many | projection, sort, skip, limit, populate, cursor |
| `count(model, filter?, options?)` | count many | filtered counts |
| `aggregate(model, stages, options?)` | run pipeline | full MongoDB aggregation |
| `backup(options?)` | zip a database backup | EJSON collection dumps, metadata, dated zip files |
| `model(model)` | escape hatch | raw Mongoose model access |

---

## Create

`create()` means “create this logical document once.” It uses an atomic upsert with `$setOnInsert`, so existing documents are not overwritten.

```js
await db.create("User", {
  id: "u_1",
  email: "ada@example.com",
  name: "Ada",
});
```

Without `id`, provide the identity filter:

```js
await db.create(
  "User",
  { email: "ada@example.com", name: "Ada" },
  { filter: { email: "ada@example.com" } }
);
```

Create many by passing an array:

```js
await db.create("User", [
  { id: "u_1", email: "ada@example.com" },
  { id: "u_2", email: "grace@example.com" },
]);
```

Create many with a filter resolver:

```js
await db.create("User", users, {
  filter: (user) => ({ email: user.email }),
});
```

Create many with a filter array:

```js
await db.create("User", users, {
  filter: users.map((user) => ({ email: user.email })),
});
```

Array data cannot share one static filter object. This is blocked on purpose:

```js
// Throws: every item would target the same document.
await db.create("User", users, {
  filter: { email: "ada@example.com" },
});
```

Use a resolver function or a filter array so every item has its own identity:

```js
await db.create("User", users, {
  filter: (user) => ({ email: user.email }),
});
```

| Guardrail | Why it exists |
|---|---|
| Empty data is rejected | A create command should create meaningful data |
| Update operators are rejected | `$inc`, `$push`, `$set` belong in `update()` |
| Shared static filters are rejected for array data | Prevents many items from writing the same document |
| Duplicate key races return existing docs when possible | Startup and request flows stay idempotent |

## Get

```js
const user = await db.get("User", { id: "u_1" });
```

```js
const publicUser = await db.get("User", { id: "u_1" }, {
  projection: { password: 0, token: 0 },
});
```

```js
const post = await db.get("Post", { id: "p_1" }, {
  populate: "author",
});
```

Lean objects are returned by default. Ask for a Mongoose document when you need document methods:

```js
const userDoc = await db.get("User", { id: "u_1" }, {
  lean: false,
});
```

## Update

Plain objects become `$set` updates:

```js
await db.update("User", { name: "Grace" }, {
  filter: { id: "u_1" },
});
```

MongoDB update operators pass through:

```js
await db.update("User", { $inc: { loginCount: 1 } }, {
  filter: { id: "u_1" },
});
```

Update many matching documents with one payload:

```js
await db.update("User", { archived: true }, {
  filter: { active: false },
  multi: true,
});
```

Update many documents with different payloads:

```js
await db.update("User", [
  { id: "u_1", name: "Ada" },
  { id: "u_2", name: "Grace" },
]);
```

Use a filter resolver when your identity field is not `id`:

```js
await db.update("User", users, {
  filter: (user) => ({ email: user.email }),
});
```

Array updates also reject one shared filter object:

```js
// Throws: every update would target the same user.
await db.update("User", users, {
  filter: { email: "ada@example.com" },
});
```

When `multi: true` is used, `update()` returns counts instead of a document:

```js
const result = await db.update("User", { archived: true }, {
  filter: { active: false },
  multi: true,
});

console.log(result.matchedCount, result.modifiedCount);
```

## Delete

Delete one:

```js
await db.delete("Session", { token: "session_token" });
```

Delete many matching one filter:

```js
await db.delete("Session", { expired: true }, { multi: true });
```

Delete multiple independent filters:

```js
await db.delete("Session", [
  { token: "token_1" },
  { token: "token_2" },
]);
```

`delete()` returns `{ success, deletedCount }`.

## Find

```js
const users = await db.find("User", { active: true }, {
  projection: { password: 0 },
  sort: { createdAt: -1 },
  skip: 20,
  limit: 10,
  populate: "team",
});
```

By default, `find()` returns an array. That is perfect for normal lists and paginated screens.

For huge datasets, do not load everything into memory. Use cursor mode:

```js
const cursor = await db.find("Log", { level: "error" }, {
  cursor: true,
  sort: { createdAt: 1 },
  cursorOptions: { batchSize: 500 },
});

for await (const log of cursor) {
  // process one document at a time
}
```

Cursor mode returns a Mongoose async iterable instead of an array. It is the right path for exports, migrations, backfills, and large reporting jobs.

For even more control, raw Mongoose is still available:

```js
const cursor = db.model("Log").find({ level: "error" }).cursor();
```

## Count

```js
const activeUsers = await db.count("User", { active: true });
```

Need a metadata-based estimate?

```js
const totalUsers = await db.model("User").estimatedDocumentCount();
```

## Aggregate

Aggregation is a core MongoDB feature, so it is first-class here.

```js
const leaderboard = await db.aggregate("Score", [
  { $match: { season: "2026" } },
  { $group: { _id: "$userId", total: { $sum: "$points" } } },
  { $sort: { total: -1 } },
  { $limit: 10 },
], {
  allowDiskUse: true,
});
```

Sessions work too:

```js
const session = await db.mongoose.startSession();

const rows = await db.aggregate("Order", [
  { $match: { status: "paid" } },
  { $group: { _id: "$userId", revenue: { $sum: "$amount" } } },
], { session });
```

Use the real pipeline stages: `$lookup`, `$unwind`, `$facet`, `$project`, `$bucket`, `$graphLookup`, and everything else MongoDB supports through Mongoose.

## Backup

Create a dated zip backup of every collection:

```js
const backup = await db.backup();

console.log(backup.file);
```

Set a default backup directory in config:

```js
db.config({
  url: "mongodb://localhost:27017/myapp",
  backupDir: path.join(__dirname, "backups"),
});
```

Or override it for one run:

```js
await db.backup({
  backupDir: "/var/backups/myapp",
  batchSize: 500,
});
```

Use a custom file id when you want a stable name:

```js
await db.backup({
  id: "before-migration",
});
```

`backup()` returns:

```js
{
  success: true,
  id: "kilic-db-2026-05-21T16-30-00-000Z",
  file: "/app/backups/kilic-db-2026-05-21T16-30-00-000Z.zip",
  directory: "/app/backups",
  database: "myapp",
  collections: [
    { collection: "users", count: 42, file: "users.json" },
  ],
  size: 12480,
  createdAt: "2026-05-21T16:30:00.000Z",
}
```

The zip contains one EJSON `.json` dump per collection plus `__meta__.json`. Backups are logical JSON exports, not a replacement for MongoDB's native `mongodump` archive format. For very large databases, native MongoDB tooling is still the safer operational choice.

## Raw Mongoose

The wrapper stays small on purpose. When you need full Mongoose, take the model:

```js
const User = db.model("User");

await User.bulkWrite([
  {
    updateOne: {
      filter: { id: "u_1" },
      update: { $set: { role: "admin" } },
    },
  },
]);
```

Raw access is also available for sessions, plugins, transactions, and connection events:

```js
const session = await db.mongoose.startSession();

db.connection.on("disconnected", () => {
  console.warn("MongoDB disconnected");
});
```

---

## Models

Register models yourself:

```js
mongoose.model("User", userSchema);
```

Or let kilic.db load model files from `config.path`:

```text
models/
  User.js
  Post.js
  Order.js
```

Each file should export a Mongoose model:

```js
module.exports = mongoose.model("User", userSchema);
```

Default exports are supported.

Model names are resolved only inside `config.path`; path traversal strings such as `"../User"` are ignored.

## TypeScript

```ts
import db from "kilic.db";

interface User {
  id: string;
  email: string;
  name: string;
}

const user = await db.get<User>("User", { id: "u_1" });
const users = await db.find<User>("User", { active: true });
const created = await db.create<User>("User", {
  id: "u_2",
  email: "grace@example.com",
});
```

Typed aggregation results:

```ts
interface RevenueRow {
  _id: string;
  total: number;
}

const rows = await db.aggregate<RevenueRow>("Order", [
  { $group: { _id: "$currency", total: { $sum: "$amount" } } },
]);
```

Typed backup results:

```ts
const backup = await db.backup({
  backupDir: "./backups",
});

backup.collections.forEach((item) => {
  console.log(item.collection, item.count);
});
```

## Errors

All wrapper errors are `KilicError` instances with a stable `code` field:

```js
try {
  await db.delete("User", {});
} catch (err) {
  console.log(err.code);
  console.log(err.message);
}
```

Example message:

```text
[kilic.db:MISSING_FILTER]
delete() requires a non-empty filter.
```

Mongoose duplicate key, validation, and cast errors are normalized with hints and details while preserving `originalError`.

## Safety

| Operation | Guardrail |
|---|---|
| `create()` | Rejects empty data and update operators |
| `create()` | Uses `$setOnInsert` so existing documents are not overwritten |
| `create(array)` | Rejects one shared filter object; use a resolver or filter array |
| `update()` | Uses `data.id` or a non-empty `filter` |
| `update(array)` | Rejects one shared filter object; use a resolver or filter array |
| `update({ multi: true })` | Requires one explicit filter object |
| `delete()` | Requires non-empty filters |
| `find({ cursor: true })` | Streams results instead of building a huge array |
| `aggregate()` | Requires an array pipeline |
| `backup()` | Writes to a temporary folder first, then zips and cleans it up |

These guardrails are not a security product. They are boring defaults that prevent the common foot-guns.

## Recipes

### Idempotent Registration

```js
await db.create("User", {
  id: externalUser.id,
  email: externalUser.email,
  provider: "github",
});
```

### Batch Sync

```js
await db.create("Customer", customers, {
  filter: (customer) => ({ externalId: customer.externalId }),
});

await db.update("Customer", customers, {
  filter: (customer) => ({ externalId: customer.externalId }),
});
```

### Huge Export

```js
const cursor = await db.find("Event", { type: "purchase" }, {
  cursor: true,
  sort: { createdAt: 1 },
});

for await (const event of cursor) {
  await writeToExport(event);
}
```

### Archive Old Data

```js
await db.update("User", { archived: true }, {
  filter: { lastLoginAt: { $lt: new Date("2025-01-01") } },
  multi: true,
});
```

### Dashboard Stats

```js
const stats = await db.aggregate("Order", [
  { $match: { status: "paid" } },
  {
    $group: {
      _id: {
        day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
      },
      orders: { $sum: 1 },
      revenue: { $sum: "$amount" },
    },
  },
  { $sort: { "_id.day": 1 } },
], { allowDiskUse: true });
```

---

## Philosophy

`kilic.db` is not trying to replace Mongoose. It is the small layer you write when you are tired of repeating the same database ceremony across routes, services, jobs, and scripts.

```text
create    create one or many logical documents once
get       read one document
update    update one, array data, or many with multi
delete    delete one, array filters, or many with multi
find      read many documents
count     count matching documents
aggregate run a MongoDB pipeline
backup   create a dated EJSON zip backup
model     use raw Mongoose
```

If a feature is common and benefits from a clear command, it belongs here. If a feature is broad, rare, or deeply Mongo-specific, `db.model()` keeps it one line away.

## License

MIT © [kilicdev](https://github.com/kilicdev)
