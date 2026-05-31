# kilic.db examples

Run these from the repository after building:

```bash
npm run build
node examples/file-backed-memory.js
```

In an installed application, replace `require("../dist")` with:

```js
const db = require("kilic.db");
```

## Files

- `file-backed-memory.js` uses kilic.db without a MongoDB URL and persists data to a `.kd` file.
- `mongodb-url.js` uses a normal MongoDB connection string.
- `transactions.js` shows the same session and transaction style in file-backed memory mode.
