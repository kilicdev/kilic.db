const path = require("node:path");
const mongoose = require("mongoose");
const db = require("../dist");

mongoose.models.ExampleFileUser || mongoose.model(
  "ExampleFileUser",
  new mongoose.Schema({
    id: { type: String, unique: true },
    email: String,
    loginCount: Number,
  }, {
    collection: "example_file_users",
    versionKey: false,
  })
);

async function main() {
  db.config({
    file: path.join(__dirname, "data", "kilic.db.json"),
    database: "kilic_example",
  });

  await db.create("ExampleFileUser", {
    id: "u_1",
    email: "ada@example.com",
    loginCount: 1,
  });

  await db.update("ExampleFileUser", { $inc: { loginCount: 1 } }, { id: "u_1" });

  const user = await db.get("ExampleFileUser", { id: "u_1" });
  console.log(user);

  await db.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await db.disconnect().catch(() => undefined);
  process.exit(1);
});
