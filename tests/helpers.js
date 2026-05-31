const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const db = require("../dist");

async function cleanupDb() {
  await db.disconnect().catch(() => undefined);
  db.mongoose.deleteModel(/.+/);
}

async function tempFile(fileName = "datas.kd") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kilic-db-test-"));
  return {
    directory,
    file: path.join(directory, fileName),
  };
}

function uniqueName(prefix) {
  return `${prefix}_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function defineModel(modelName, collectionName, definition) {
  const mongoose = db.mongoose;
  if (mongoose.models[modelName]) mongoose.deleteModel(modelName);

  return mongoose.model(
    modelName,
    new mongoose.Schema(definition, {
      collection: collectionName,
      versionKey: false,
    })
  );
}

async function readStore(file) {
  return JSON.parse(await fs.readFile(file, "utf-8"));
}

function getCollection(store, collectionName) {
  const collection = store.collections?.[collectionName];
  assert.ok(Array.isArray(collection), `Expected collection '${collectionName}' in file store.`);
  return collection;
}

function ejsonNumber(value) {
  if (typeof value === "number") return value;
  if (value?.$numberInt !== undefined) return Number(value.$numberInt);
  if (value?.$numberLong !== undefined) return Number(value.$numberLong);
  if (value?.$numberDouble !== undefined) return Number(value.$numberDouble);
  return Number(value);
}

module.exports = {
  cleanupDb,
  db,
  defineModel,
  ejsonNumber,
  getCollection,
  readStore,
  tempFile,
  uniqueName,
};
