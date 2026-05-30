const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const test = require("node:test");
const { MongoMemoryReplSet } = require("mongodb-memory-server-core");

const {
  cleanupDb,
  db,
  defineModel,
  tempFile,
  uniqueName,
} = require("./helpers");

test.afterEach(cleanupDb);

test("uses the provided MongoDB url without touching file-backed storage", async () => {
  const { file } = await tempFile();
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const database = uniqueName("urldb");
  const modelName = uniqueName("UrlUser");
  const collectionName = "url_users";

  try {
    defineModel(modelName, collectionName, {
      id: { type: String, unique: true },
      name: String,
      count: Number,
    });

    db.config({
      url: replSet.getUri(database),
      file,
      database: "ignored_file_mode_name",
    });

    await db.create(modelName, { id: "u_1", name: "Ada", count: 1 });

    const session = await db.mongoose.startSession();
    await session.withTransaction(async () => {
      await db.update(modelName, { $inc: { count: 1 } }, { id: "u_1" }, { session });
      await db.create(modelName, { id: "u_2", name: "Grace", count: 2 }, { session });
    });
    await session.endSession();

    const users = await db.find(modelName, {}, { sort: { id: 1 } });
    assert.deepEqual(
      users.map((item) => ({ id: item.id, count: item.count })),
      [
        { id: "u_1", count: 2 },
        { id: "u_2", count: 2 },
      ]
    );

    await assert.rejects(fs.access(file), { code: "ENOENT" });
  } finally {
    await cleanupDb();
    await replSet.stop();
  }
});
