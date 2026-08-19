import app from "./app.js";
import { loadConfig } from "./config.js";
import { ensureLocalAdmin, ensureLocalTestAccounts } from "./password-auth.js";

const config = loadConfig();
const { port } = config;
if (config.auth.mode === "password" && !config.databaseUrl) {
  await ensureLocalAdmin(app.locals.store, config.auth.adminSeedPassword);
  await ensureLocalTestAccounts(app.locals.store);
}
const server = app.listen(port, () => {
  console.log(`Sports Operations API listening on http://localhost:${port}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
