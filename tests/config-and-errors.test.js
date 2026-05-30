const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const test = require("node:test");

const {
  cleanupDb,
  db,
  defineModel,
  getCollection,
  readStore,
  tempFile,
  uniqueName,
} = require("./helpers");

test.afterEach(cleanupDb);

test("ready explains when the database has not been configured", async () => {
  await assert.rejects(db.ready(), { code: "NOT_CONFIGURED" });
});

test("active connections reject switching to another database target", async () => {
  const first = await tempFile("first.json");
  const second = await tempFile("second.json");

  defineModel(uniqueName("ConflictUser"), "conflict_users", {
    id: String,
  });

  db.config({ file: first.file, database: uniqueName("conflict") });
  await db.ready();

  assert.throws(
    () => db.config({ file: second.file, database: uniqueName("other") }),
    { code: "CONFIG_CONFLICT" }
  );
});

test("invalid file stores keep their specific error and the next config can recover", async () => {
  const bad = await tempFile("bad.json");
  const good = await tempFile("good.json");
  const modelName = uniqueName("RecoverUser");
  const collectionName = "recover_users";

  await fs.writeFile(
    bad.file,
    JSON.stringify({ version: 1, database: "bad", collections: { broken: { not: "an array" } } }),
    "utf-8"
  );

  defineModel(modelName, collectionName, {
    id: String,
  });

  db.config({ file: bad.file, database: "bad" });
  await assert.rejects(db.ready(), { code: "FILE_STORE_INVALID" });

  db.config({ file: good.file, database: "good" });
  await db.create(modelName, { id: "ok" });
  await db.disconnect();

  const rows = getCollection(await readStore(good.file), collectionName);
  assert.equal(rows[0].id, "ok");
});
