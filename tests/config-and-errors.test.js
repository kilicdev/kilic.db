const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
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

const packageEntry = path.join(__dirname, "..", "dist");

test("commands default to local file-backed mode when config is omitted", async () => {
  const { directory } = await tempFile();
  const previousCwd = process.cwd();
  const modelName = uniqueName("DefaultConfigUser");

  new db.model(modelName, {
    id: { type: String, unique: true },
    name: String,
  });

  try {
    process.chdir(directory);
    await db.create(modelName, { id: "no_config", name: "Ada" });
    await db.disconnect();

    const store = await readStore(path.join(directory, "datas.kd"));
    const rows = Object.values(store.collections)[0];
    assert.equal(rows[0].name, "Ada");
  } finally {
    process.chdir(previousCwd);
  }
});

test("server mode requires a MongoDB url", () => {
  assert.throws(
    () => db.config({ type: "server" }),
    { code: "INVALID_CONFIG" }
  );
});

test("active connections reject switching to another database target", async () => {
  const first = await tempFile("first.kd");
  const second = await tempFile("second.kd");

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
  const bad = await tempFile("bad.kd");
  const good = await tempFile("good.kd");
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

test("collections loads files that define models with new db.model", async () => {
  const { directory, file } = await tempFile();
  const collectionsDir = path.join(directory, "collections");
  const modelName = uniqueName("CollectionUser");

  await fs.mkdir(collectionsDir, { recursive: true });
  await fs.writeFile(
    path.join(collectionsDir, `${modelName}.js`),
    [
      `const db = require(${JSON.stringify(packageEntry)});`,
      `module.exports = new db.model(${JSON.stringify(modelName)}, {`,
      "  id: { type: String, unique: true },",
      "  name: String,",
      "  age: Number,",
      "});",
      "",
    ].join("\n"),
    "utf-8"
  );

  db.config({ file, database: uniqueName("collectionsdb"), collections: collectionsDir });

  await db.create(modelName, { id: "aa", name: "kilic", age: 5 });
  const data = await db.get(modelName, { id: "aa" });

  assert.equal(data.name, "kilic");
  assert.equal(data.age, 5);
});

test("deprecated path still works as a collections alias", async () => {
  const { directory, file } = await tempFile();
  const collectionsDir = path.join(directory, "models");
  const modelName = uniqueName("LegacyPathUser");

  await fs.mkdir(collectionsDir, { recursive: true });
  await fs.writeFile(
    path.join(collectionsDir, `${modelName}.js`),
    [
      `const db = require(${JSON.stringify(packageEntry)});`,
      `module.exports = new db.model(${JSON.stringify(modelName)}, { id: String });`,
      "",
    ].join("\n"),
    "utf-8"
  );

  db.config({ file, database: uniqueName("pathaliasdb"), path: collectionsDir });
  await db.create(modelName, { id: "legacy" });

  const data = await db.get(modelName, { id: "legacy" });
  assert.equal(data.id, "legacy");
});

test("model files that require mongoose get a helpful dependency error", async () => {
  const { directory } = await tempFile();
  const collectionsDir = path.join(directory, "collections");
  const modelName = uniqueName("NeedsMongoose");

  await fs.mkdir(collectionsDir, { recursive: true });
  await fs.writeFile(
    path.join(collectionsDir, `${modelName}.js`),
    [
      "const mongoose = require('mongoose');",
      `module.exports = mongoose.model(${JSON.stringify(modelName)}, new mongoose.Schema({ id: String }));`,
      "",
    ].join("\n"),
    "utf-8"
  );

  db.config({ collections: collectionsDir, cwd: directory });

  assert.throws(
    () => db.model(modelName),
    { code: "MODEL_DEPENDENCY_MISSING" }
  );
});

test("config return keeps newline IIFE code safe without a semicolon", async () => {
  const { directory, file } = await tempFile();
  const modelName = uniqueName("AsiUser");
  const script = [
    `const db = require(${JSON.stringify(packageEntry)});`,
    `new db.model(${JSON.stringify(modelName)}, { id: String, name: String });`,
    `db.config({ file: ${JSON.stringify(file)}, database: ${JSON.stringify(uniqueName("asidb"))} })`,
    "(async() => {",
    `  await db.create(${JSON.stringify(modelName)}, { id: "aa", name: "kilic" });`,
    `  const data = await db.get(${JSON.stringify(modelName)}, { id: "aa" });`,
    "  if (!data || data.name !== 'kilic') throw new Error('ASI flow did not run');",
    "  await db.disconnect();",
    "})().catch((err) => { console.error(err); process.exit(1); });",
    "",
  ].join("\n");

  const result = await runNodeScript(script, directory);
  assert.equal(result.code, 0, result.stderr);
});

test("stale file-store tmp files are cleaned", async () => {
  const { directory, file } = await tempFile();
  const modelName = uniqueName("TmpUser");
  const staleTmp = path.join(directory, ".datas.kd.4766.1780233834390.tmp");

  await fs.writeFile(staleTmp, "{\"collections\":", "utf-8");
  new db.model(modelName, { id: String });

  db.config({ file, database: uniqueName("tmpdb") });
  await db.create(modelName, { id: "tmp" });
  await db.disconnect();

  const entries = await fs.readdir(directory);
  assert.deepEqual(entries.filter((entry) => entry.endsWith(".tmp")), []);
});

test("SIGINT during local mode shutdown does not print MongoServerSelectionError", async () => {
  const { directory, file } = await tempFile();
  const modelName = uniqueName("SigintUser");
  const script = [
    `const db = require(${JSON.stringify(packageEntry)});`,
    `new db.model(${JSON.stringify(modelName)}, { id: String });`,
    `db.config({ file: ${JSON.stringify(file)}, database: ${JSON.stringify(uniqueName("sigintdb"))} });`,
    "console.log('configured');",
    "setTimeout(() => {}, 10000);",
    "",
  ].join("\n");

  const child = spawn(process.execPath, ["-e", script], {
    cwd: directory,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let configured;
  const configuredPromise = new Promise((resolve) => {
    configured = resolve;
  });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (stdout.includes("configured")) configured();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exitPromise = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });

  await Promise.race([
    configuredPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("child did not reach db.config()")), 5000)),
  ]);
  child.kill("SIGINT");

  const { code, signal } = await Promise.race([
    exitPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("child did not exit after SIGINT")), 5000)),
  ]);

  assert.equal(signal, null, stderr);
  assert.equal(code, 0, stderr);
  assert.doesNotMatch(stderr, /MongoServerSelectionError|ECONNREFUSED/);
});

test("config validates obviously invalid JavaScript inputs before connecting", () => {
  assert.throws(
    () => db.config(null),
    { code: "INVALID_CONFIG" }
  );

  assert.throws(
    () => db.config("local"),
    { code: "INVALID_CONFIG" }
  );

  assert.throws(
    () => db.config({ file: "" }),
    { code: "INVALID_CONFIG" }
  );

  assert.throws(
    () => db.config({ collections: "" }),
    { code: "INVALID_CONFIG" }
  );
});

test("model definition rejects array and null schemas", () => {
  assert.throws(
    () => new db.model(uniqueName("InvalidArrayModel"), []),
    { code: "INVALID_MODEL_SCHEMA" }
  );

  assert.throws(
    () => new db.model(uniqueName("InvalidNullModel"), null),
    { code: "INVALID_MODEL_SCHEMA" }
  );
});

test("collections and path conflict is explained before connecting", () => {
  assert.throws(
    () => db.config({ collections: "./collections", path: "./models" }),
    { code: "INVALID_CONFIG" }
  );
});

function runNodeScript(script, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", script], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("exit", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}
