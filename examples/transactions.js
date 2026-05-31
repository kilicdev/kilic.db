const path = require("node:path");
const mongoose = require("mongoose");
const db = require("../dist");

mongoose.models.ExampleAccount || mongoose.model(
  "ExampleAccount",
  new mongoose.Schema({
    id: { type: String, unique: true },
    balance: Number,
  }, {
    collection: "example_accounts",
    versionKey: false,
  })
);

async function main() {
  db.config({
    file: path.join(__dirname, "data", "transactions.kd"),
    database: "kilic_transactions",
  });

  await db.create("ExampleAccount", [
    { id: "checking", balance: 100 },
    { id: "savings", balance: 50 },
  ]);

  const session = await db.mongoose.startSession();

  await session.withTransaction(async () => {
    await db.update("ExampleAccount", { $inc: { balance: -25 } }, { id: "checking" }, { session });
    await db.update("ExampleAccount", { $inc: { balance: 25 } }, { id: "savings" }, { session });
  });

  await session.endSession();

  const accounts = await db.find("ExampleAccount", {}, { sort: { id: 1 } });
  console.log(accounts);

  await db.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await db.disconnect().catch(() => undefined);
  process.exit(1);
});
