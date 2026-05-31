const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");

const {
  cleanupDb,
  db,
  defineModel,
  tempFile,
  uniqueName,
} = require("./helpers");

test.afterEach(cleanupDb);

test("backup creates a zip file with collection data and metadata", async () => {
  const { file, directory } = await tempFile();
  const backupDir = path.join(directory, "backups");
  const modelName = uniqueName("BackupUser");
  const collectionName = "backup_users";

  defineModel(modelName, collectionName, {
    id: { type: String, unique: true },
    name: String,
  });

  db.config({ file, database: uniqueName("backupdb"), backupDir });

  await db.create(modelName, [
    { id: "u_1", name: "Ada" },
    { id: "u_2", name: "Grace" },
  ]);

  const result = await db.backup();

  assert.equal(result.success, true);
  assert.equal(typeof result.id, "string");
  assert.equal(typeof result.file, "string");
  assert.equal(result.directory, backupDir);
  assert.equal(typeof result.database, "string");
  assert.equal(typeof result.size, "number");
  assert.ok(result.size > 0);
  assert.equal(typeof result.createdAt, "string");
  assert.ok(Array.isArray(result.collections));

  const col = result.collections.find((c) => c.collection === collectionName);
  assert.ok(col, `Expected collection '${collectionName}' in backup`);
  assert.equal(col.count, 2);
  assert.equal(typeof col.file, "string");

  // zip file exists
  await fs.access(result.file);

  // temp directory cleaned up
  const entries = await fs.readdir(backupDir);
  const tmpDirs = entries.filter((e) => e.startsWith(".tmp-"));
  assert.equal(tmpDirs.length, 0, "Temp directory should be cleaned up");
});

test("backup with custom id uses provided id in file name", async () => {
  const { file, directory } = await tempFile();
  const backupDir = path.join(directory, "backups");
  const modelName = uniqueName("IdUser");

  defineModel(modelName, "id_users", {
    id: { type: String, unique: true },
  });

  db.config({ file, database: uniqueName("iddb"), backupDir });
  await db.create(modelName, { id: "x" });

  const result = await db.backup({ id: "my-custom-backup" });

  assert.equal(result.id, "my-custom-backup");
  assert.ok(result.file.includes("my-custom-backup"));
});

test("backup with custom backupDir overrides config", async () => {
  const { file, directory } = await tempFile();
  const configDir = path.join(directory, "config-backups");
  const overrideDir = path.join(directory, "override-backups");
  const modelName = uniqueName("DirUser");

  defineModel(modelName, "dir_users", {
    id: { type: String, unique: true },
  });

  db.config({ file, database: uniqueName("dirdb"), backupDir: configDir });
  await db.create(modelName, { id: "y" });

  const result = await db.backup({ backupDir: overrideDir });

  assert.equal(result.directory, overrideDir);
  assert.ok(result.file.startsWith(overrideDir));
  await fs.access(result.file);
});

test("backup with empty database produces valid result", async () => {
  const { file, directory } = await tempFile();
  const backupDir = path.join(directory, "backups");

  db.config({ file, database: uniqueName("emptydb"), backupDir });
  await db.ready();

  const result = await db.backup();

  assert.equal(result.success, true);
  assert.ok(Array.isArray(result.collections));
  await fs.access(result.file);
});

test("backup id sanitizes special characters", async () => {
  const { file, directory } = await tempFile();
  const backupDir = path.join(directory, "backups");
  const modelName = uniqueName("SanitizeUser");

  defineModel(modelName, "sanitize_users", {
    id: { type: String, unique: true },
  });

  db.config({ file, database: uniqueName("sanitizedb"), backupDir });
  await db.create(modelName, { id: "z" });

  const result = await db.backup({ id: "my backup/test:2026" });

  assert.ok(!result.id.includes("/"));
  assert.ok(!result.id.includes(":"));
  await fs.access(result.file);
});
