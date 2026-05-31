const assert = require("node:assert/strict");
const test = require("node:test");

const {
  cleanupDb,
  db,
  defineModel,
  tempFile,
  uniqueName,
} = require("./helpers");

test.afterEach(cleanupDb);

// --- delete() validation ---

test("delete rejects empty filter object", async () => {
  const { file } = await tempFile();
  const modelName = uniqueName("DelEmptyUser");

  defineModel(modelName, "del_empty_users", {
    id: { type: String, unique: true },
  });

  db.config({ file, database: uniqueName("delemptydb") });
  await db.ready();

  await assert.rejects(
    db.delete(modelName, {}),
    { code: "MISSING_FILTER" }
  );
});

test("delete rejects empty filter in array", async () => {
  const { file } = await tempFile();
  const modelName = uniqueName("DelArrUser");

  defineModel(modelName, "del_arr_users", {
    id: { type: String, unique: true },
  });

  db.config({ file, database: uniqueName("delarrdb") });
  await db.ready();

  await assert.rejects(
    db.delete(modelName, [{}]),
    { code: "MISSING_FILTER" }
  );
});

test("delete rejects empty array of filters", async () => {
  const { file } = await tempFile();
  const modelName = uniqueName("DelNoFilterUser");

  defineModel(modelName, "del_nofilter_users", {
    id: { type: String, unique: true },
  });

  db.config({ file, database: uniqueName("delnofilterdb") });
  await db.ready();

  await assert.rejects(
    db.delete(modelName, []),
    { code: "EMPTY_ARRAY" }
  );
});

// --- create() validation ---

test("create rejects empty data object", async () => {
  const { file } = await tempFile();
  const modelName = uniqueName("CreateEmptyUser");

  defineModel(modelName, "create_empty_users", {
    id: { type: String, unique: true },
  });

  db.config({ file, database: uniqueName("createemptydb") });
  await db.ready();

  await assert.rejects(
    db.create(modelName, {}),
    { code: "EMPTY_OBJECT" }
  );
});

test("create rejects data with update operators", async () => {
  const { file } = await tempFile();
  const modelName = uniqueName("CreateOpUser");

  defineModel(modelName, "create_op_users", {
    id: { type: String, unique: true },
    count: Number,
  });

  db.config({ file, database: uniqueName("createopdb") });
  await db.ready();

  await assert.rejects(
    db.create(modelName, { $inc: { count: 1 } }),
    { code: "INVALID_PAYLOAD" }
  );
});

test("create rejects empty array", async () => {
  const { file } = await tempFile();
  const modelName = uniqueName("CreateArrUser");

  defineModel(modelName, "create_arr_users", {
    id: { type: String, unique: true },
  });

  db.config({ file, database: uniqueName("createarrdb") });
  await db.ready();

  await assert.rejects(
    db.create(modelName, []),
    { code: "EMPTY_ARRAY" }
  );
});

test("create rejects array data with shared static filter", async () => {
  const { file } = await tempFile();
  const modelName = uniqueName("CreateSharedUser");

  defineModel(modelName, "create_shared_users", {
    id: { type: String, unique: true },
    email: String,
  });

  db.config({ file, database: uniqueName("createshareddb") });
  await db.ready();

  await assert.rejects(
    db.create(
      modelName,
      [{ id: "a", email: "a@x.com" }, { id: "b", email: "b@x.com" }],
      { filter: { email: "shared@x.com" } }
    ),
    { code: "UNSAFE_SHARED_FILTER" }
  );
});

// --- update() validation ---

test("update rejects empty data object", async () => {
  const { file } = await tempFile();
  const modelName = uniqueName("UpdEmptyUser");

  defineModel(modelName, "upd_empty_users", {
    id: { type: String, unique: true },
  });

  db.config({ file, database: uniqueName("updemptydb") });
  await db.ready();

  await assert.rejects(
    db.update(modelName, {}, { id: "x" }),
    { code: "EMPTY_OBJECT" }
  );
});

test("update rejects array data with shared static filter", async () => {
  const { file } = await tempFile();
  const modelName = uniqueName("UpdSharedUser");

  defineModel(modelName, "upd_shared_users", {
    id: { type: String, unique: true },
    name: String,
  });

  db.config({ file, database: uniqueName("updshareddb") });
  await db.ready();

  await assert.rejects(
    db.update(
      modelName,
      [{ id: "a", name: "A" }, { id: "b", name: "B" }],
      { id: "shared" }
    ),
    { code: "UNSAFE_SHARED_FILTER" }
  );
});

test("update multi rejects array or function filter", async () => {
  const { file } = await tempFile();
  const modelName = uniqueName("UpdMultiUser");

  defineModel(modelName, "upd_multi_users", {
    id: { type: String, unique: true },
    active: Boolean,
  });

  db.config({ file, database: uniqueName("updmultidb") });
  await db.ready();

  await assert.rejects(
    db.update(modelName, { active: false }, [{ id: "x" }], { multi: true }),
    { code: "INVALID_FILTER" }
  );

  await assert.rejects(
    db.update(modelName, { active: false }, () => ({ id: "x" }), { multi: true }),
    { code: "INVALID_FILTER" }
  );
});

// --- aggregate() validation ---

test("aggregate rejects non-array stages", async () => {
  const { file } = await tempFile();
  const modelName = uniqueName("AggUser");

  defineModel(modelName, "agg_users", {
    id: { type: String, unique: true },
  });

  db.config({ file, database: uniqueName("aggdb") });
  await db.ready();

  await assert.rejects(
    db.aggregate(modelName, { $match: {} }),
    { code: "INVALID_PIPELINE" }
  );
});

// --- model() validation ---

test("model rejects empty or non-string name", async () => {
  assert.throws(
    () => db.model(""),
    { code: "INVALID_MODEL_NAME" }
  );

  assert.throws(
    () => db.model(null),
    { code: "INVALID_MODEL_NAME" }
  );
});

test("model throws for unregistered model", async () => {
  assert.throws(
    () => db.model("NonExistentModel_" + Date.now()),
    { code: "MODEL_NOT_FOUND" }
  );
});

// --- create idempotency ---

test("create returns existing document on duplicate", async () => {
  const { file } = await tempFile();
  const modelName = uniqueName("IdempUser");
  const collectionName = "idemp_users";

  defineModel(modelName, collectionName, {
    id: { type: String, unique: true },
    name: String,
  });

  db.config({ file, database: uniqueName("idempdb") });

  const first = await db.create(modelName, { id: "dup_1", name: "Ada" });
  const second = await db.create(modelName, { id: "dup_1", name: "Grace" });

  assert.equal(first.id, "dup_1");
  assert.equal(first.name, "Ada");
  assert.equal(second.id, "dup_1");
  assert.equal(second.name, "Ada"); // not overwritten
});

// --- find, get, count with invalid filter ---

test("get rejects non-object filter", async () => {
  const { file } = await tempFile();
  const modelName = uniqueName("GetInvUser");

  defineModel(modelName, "get_inv_users", {
    id: { type: String, unique: true },
  });

  db.config({ file, database: uniqueName("getinvdb") });
  await db.ready();

  await assert.rejects(
    db.get(modelName, "not-an-object"),
    { code: "INVALID_OBJECT" }
  );
});

test("find rejects non-object filter", async () => {
  const { file } = await tempFile();
  const modelName = uniqueName("FindInvUser");

  defineModel(modelName, "find_inv_users", {
    id: { type: String, unique: true },
  });

  db.config({ file, database: uniqueName("findinvdb") });
  await db.ready();

  await assert.rejects(
    db.find(modelName, "not-an-object"),
    { code: "INVALID_OBJECT" }
  );
});

test("count rejects non-object filter", async () => {
  const { file } = await tempFile();
  const modelName = uniqueName("CountInvUser");

  defineModel(modelName, "count_inv_users", {
    id: { type: String, unique: true },
  });

  db.config({ file, database: uniqueName("countinvdb") });
  await db.ready();

  await assert.rejects(
    db.count(modelName, "not-an-object"),
    { code: "INVALID_OBJECT" }
  );
});

// --- delete with multi ---

test("delete multi removes all matching documents", async () => {
  const { file } = await tempFile();
  const modelName = uniqueName("DelMultiUser");

  defineModel(modelName, "del_multi_users", {
    id: { type: String, unique: true },
    active: Boolean,
  });

  db.config({ file, database: uniqueName("delmultidb") });

  await db.create(modelName, [
    { id: "a", active: false },
    { id: "b", active: false },
    { id: "c", active: true },
  ]);

  const result = await db.delete(modelName, { active: false }, { multi: true });
  assert.equal(result.success, true);
  assert.equal(result.deletedCount, 2);

  const remaining = await db.find(modelName);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, "c");
});

// --- update multi returns counts ---

test("update multi returns matchedCount and modifiedCount", async () => {
  const { file } = await tempFile();
  const modelName = uniqueName("UpdMultiCountUser");

  defineModel(modelName, "upd_multi_count_users", {
    id: { type: String, unique: true },
    active: Boolean,
    archived: Boolean,
  });

  db.config({ file, database: uniqueName("updmulticountdb") });

  await db.create(modelName, [
    { id: "a", active: true, archived: false },
    { id: "b", active: true, archived: false },
    { id: "c", active: false, archived: false },
  ]);

  const result = await db.update(
    modelName,
    { archived: true },
    { active: true },
    { multi: true }
  );

  assert.equal(result.success, true);
  assert.equal(result.matchedCount, 2);
  assert.equal(result.modifiedCount, 2);
});

// --- prototype pollution guard ---

test("create rejects __proto__ key in data", async () => {
  const { file } = await tempFile();
  const modelName = uniqueName("ProtoUser");

  defineModel(modelName, "proto_users", {
    id: { type: String, unique: true },
  });

  db.config({ file, database: uniqueName("protodb") });
  await db.ready();

  // Object.create(null) allows __proto__ as a real own key
  const malicious = Object.create(null);
  malicious.__proto__ = { admin: true };
  malicious.id = "x";

  await assert.rejects(
    db.create(modelName, malicious),
    { code: "PROTOTYPE_POLLUTION" }
  );
});

test("get rejects constructor key in filter", async () => {
  const { file } = await tempFile();
  const modelName = uniqueName("CtorUser");

  defineModel(modelName, "ctor_users", {
    id: { type: String, unique: true },
  });

  db.config({ file, database: uniqueName("ctordb") });
  await db.ready();

  await assert.rejects(
    db.get(modelName, { constructor: { prototype: {} } }),
    { code: "PROTOTYPE_POLLUTION" }
  );
});

// --- filter array length mismatch ---

test("create rejects filter array shorter than data array", async () => {
  const { file } = await tempFile();
  const modelName = uniqueName("FilterLenUser");

  defineModel(modelName, "filterlen_users", {
    id: { type: String, unique: true },
    name: String,
  });

  db.config({ file, database: uniqueName("filterlendb") });
  await db.ready();

  await assert.rejects(
    db.create(
      modelName,
      [{ id: "a", name: "A" }, { id: "b", name: "B" }],
      { filter: [{ id: "a" }] }  // only 1 filter for 2 data items
    ),
    { code: "FILTER_LENGTH_MISMATCH" }
  );
});

test("update rejects filter array shorter than data array", async () => {
  const { file } = await tempFile();
  const modelName = uniqueName("UpdFilterLenUser");

  defineModel(modelName, "updfilterlen_users", {
    id: { type: String, unique: true },
    name: String,
  });

  db.config({ file, database: uniqueName("updfilterlendb") });
  await db.ready();

  await assert.rejects(
    db.update(
      modelName,
      [{ id: "a", name: "A" }, { id: "b", name: "B" }],
      [{ id: "a" }]  // only 1 filter for 2 data items
    ),
    { code: "FILTER_LENGTH_MISMATCH" }
  );
});

// --- update upsert ---

test("update with upsert creates document when not found", async () => {
  const { file } = await tempFile();
  const modelName = uniqueName("UpsertUser");

  defineModel(modelName, "upsert_users", {
    id: { type: String, unique: true },
    name: String,
    score: Number,
  });

  db.config({ file, database: uniqueName("upsertdb") });

  const result = await db.update(
    modelName,
    { name: "Ada", score: 100 },
    { id: "u_new" },
    { upsert: true }
  );

  assert.ok(result);
  assert.equal(result.id, "u_new");
  assert.equal(result.name, "Ada");
  assert.equal(result.score, 100);

  const found = await db.get(modelName, { id: "u_new" });
  assert.equal(found.name, "Ada");
});
