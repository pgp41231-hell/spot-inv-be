const splitCsv = (value) =>
  String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || "development";
  const allowDevAuth = env.ALLOW_DEV_AUTH === "true";
  const allowedOrigins = splitCsv(env.ALLOWED_ORIGINS);

  if (nodeEnv === "production" && allowDevAuth) {
    throw new Error("ALLOW_DEV_AUTH must be disabled in production");
  }
  if (nodeEnv === "production") {
    const required = ["DATABASE_URL", "AUTH_ISSUER", "AUTH_AUDIENCE", "AUTH_JWKS_URI", "ALLOWED_ORIGINS", "CRON_SECRET"];
    const missing = required.filter((key) => !env[key]);
    if (missing.length) throw new Error(`Missing production environment variables: ${missing.join(", ")}`);
  }

  return {
    nodeEnv,
    port: Number(env.PORT || 3000),
    allowedOrigins,
    databaseUrl: env.DATABASE_URL || "",
    auth: {
      issuer: env.AUTH_ISSUER || "",
      audience: env.AUTH_AUDIENCE || "",
      jwksUri: env.AUTH_JWKS_URI || "",
      allowDevAuth,
    },
    cronSecret: env.CRON_SECRET || "",
    email: {
      webhookUrl: env.EMAIL_WEBHOOK_URL || "",
      webhookToken: env.EMAIL_WEBHOOK_TOKEN || "",
    },
  };
}
