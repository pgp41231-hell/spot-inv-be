import { loadConfig } from "../../src/config.js";

export default function health(_request, response) {
  const config = loadConfig();
  response.status(200).json({
    status: "ok",
    service: "IIM Lucknow Sports Operations API",
    authMode: config.auth.mode,
    storage: config.databaseUrl ? "postgres" : "memory",
    timestamp: new Date().toISOString(),
  });
}
