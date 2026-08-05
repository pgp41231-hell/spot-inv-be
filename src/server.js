import app from "./app.js";
import { loadConfig } from "./config.js";

const { port } = loadConfig();
const server = app.listen(port, () => {
  console.log(`Sports Operations API listening on http://localhost:${port}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
