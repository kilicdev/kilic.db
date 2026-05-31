const path = require("node:path");
const db = require("../dist");

new db.model("ExampleFileUser", {
  id: { type: String, unique: true },
  email: String,
  loginCount: Number,
}, {
  collection: "example_file_users",
});

async function main() {
  db.config({
    type: "local",
    file: path.join(__dirname, "data", "example.kd"),
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
