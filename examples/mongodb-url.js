const mongoose = require("mongoose");
const db = require("../dist");

const mongoUrl = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/kilic_example";

mongoose.models.ExampleUrlUser || mongoose.model(
  "ExampleUrlUser",
  new mongoose.Schema({
    id: { type: String, unique: true },
    name: String,
    role: String,
  }, {
    collection: "example_url_users",
    versionKey: false,
  })
);

async function main() {
  db.config({ url: mongoUrl });

  await db.create("ExampleUrlUser", {
    id: "u_1",
    name: "Ada",
    role: "admin",
  });

  const admins = await db.find("ExampleUrlUser", { role: "admin" }, {
    sort: { name: 1 },
  });

  console.log(admins);

  await db.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await db.disconnect().catch(() => undefined);
  process.exit(1);
});
