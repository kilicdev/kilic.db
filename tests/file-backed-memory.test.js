const assert = require("node:assert/strict");
const test = require("node:test");

const {
  cleanupDb,
  db,
  defineModel,
  ejsonNumber,
  getCollection,
  readStore,
  tempFile,
  uniqueName,
} = require("./helpers");

test.afterEach(cleanupDb);

test("starts a file-backed memory replica set when url is omitted", async () => {
  const { file } = await tempFile();
  const database = uniqueName("filedb");
  const modelName = uniqueName("MemoryUser");
  const collectionName = "memory_users";

  defineModel(modelName, collectionName, {
    id: { type: String, unique: true },
    email: String,
    loginCount: Number,
  });

  db.config({ file, database });

  await db.create(modelName, {
    id: "u_1",
    email: "ada@example.com",
    loginCount: 1,
  });
  await db.update(modelName, { $inc: { loginCount: 1 } }, { id: "u_1" });

  const liveUser = await db.get(modelName, { id: "u_1" });
  assert.equal(liveUser.loginCount, 2);

  await db.disconnect();

  const store = await readStore(file);
  assert.equal(store.database, database);
  assert.deepEqual(Object.keys(store.collections), [collectionName]);
  assert.equal(ejsonNumber(getCollection(store, collectionName)[0].loginCount), 2);

  db.config({ file, database });
  const restoredUser = await db.get(modelName, { id: "u_1" });
  assert.equal(restoredUser.email, "ada@example.com");
  assert.equal(restoredUser.loginCount, 2);
});

test("flush writes raw Mongoose changes to the file store", async () => {
  const { file } = await tempFile();
  const modelName = uniqueName("RawUser");
  const collectionName = "raw_users";
  const RawUser = defineModel(modelName, collectionName, {
    id: { type: String, unique: true },
    source: String,
  });

  db.config({ file, database: uniqueName("rawdb") });
  await db.ready();

  await RawUser.create({ id: "raw_1", source: "mongoose" });
  await db.flush();

  const store = await readStore(file);
  const rawUsers = getCollection(store, collectionName);
  assert.equal(rawUsers.length, 1);
  assert.equal(rawUsers[0].source, "mongoose");
});

test("transaction commits flush after commit and aborted transactions do not dirty the file", async () => {
  const { file } = await tempFile();
  const modelName = uniqueName("TxUser");
  const collectionName = "tx_users";

  defineModel(modelName, collectionName, {
    id: { type: String, unique: true },
    count: Number,
  });

  db.config({ file, database: uniqueName("txdb") });
  await db.create(modelName, { id: "base", count: 1 });

  const commitSession = await db.mongoose.startSession();
  await commitSession.withTransaction(async () => {
    await db.update(modelName, { $inc: { count: 2 } }, { id: "base" }, { session: commitSession });
    await db.create(modelName, { id: "inside", count: 5 }, { session: commitSession });
  });
  await commitSession.endSession();

  const committedStore = await readStore(file);
  const committedRows = getCollection(committedStore, collectionName);
  assert.equal(committedRows.length, 2);
  assert.equal(ejsonNumber(committedRows.find((item) => item.id === "base").count), 3);

  const abortSession = await db.mongoose.startSession();
  await assert.rejects(
    abortSession.withTransaction(async () => {
      await db.update(modelName, { $inc: { count: 100 } }, { id: "base" }, { session: abortSession });
      throw new Error("abort this transaction");
    }),
    /abort this transaction/
  );
  await abortSession.endSession();

  const abortedStore = await readStore(file);
  const baseRow = getCollection(abortedStore, collectionName).find((item) => item.id === "base");
  assert.equal(ejsonNumber(baseRow.count), 3);
});

test("array writes are transaction-safe in file-backed mode", async () => {
  const { file } = await tempFile();
  const modelName = uniqueName("ArrayUser");
  const collectionName = "array_users";

  defineModel(modelName, collectionName, {
    id: { type: String, unique: true },
    count: Number,
  });

  db.config({ file, database: uniqueName("arraydb") });

  const session = await db.mongoose.startSession();
  await session.withTransaction(async () => {
    await db.create(modelName, [
      { id: "a", count: 1 },
      { id: "b", count: 2 },
    ], { session });
  });

  await session.withTransaction(async () => {
    await db.update(modelName, [
      { id: "a", count: 3 },
      { id: "b", count: 4 },
    ], undefined, { session });
    await db.delete(modelName, [{ id: "b" }], { session });
  });
  await session.endSession();

  const rows = getCollection(await readStore(file), collectionName);
  assert.deepEqual(rows.map((item) => item.id), ["a"]);
  assert.equal(ejsonNumber(rows[0].count), 3);
});
