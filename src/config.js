const splitCsv = (value) =>
  String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || "development";
  const allowedOrigins = splitCsv(env.ALLOWED_ORIGINS);
  const hasOidcSettings = Boolean(env.AUTH_ISSUER && env.AUTH_AUDIENCE && env.AUTH_JWKS_URI);
  const authMode = env.AUTH_MODE || (hasOidcSettings ? "oidc" : "demo");

  if (!["demo", "oidc"].includes(authMode)) {
    throw new Error("AUTH_MODE must be either demo or oidc");
  }
  if (authMode === "oidc" && !hasOidcSettings) {
    throw new Error("AUTH_MODE=oidc requires AUTH_ISSUER, AUTH_AUDIENCE, and AUTH_JWKS_URI");
  }

  return {
    nodeEnv,
    port: Number(env.PORT || 3000),
    allowedOrigins,
    databaseUrl: env.DATABASE_URL || "",
    auth: {
      mode: authMode,
      issuer: env.AUTH_ISSUER || "",
      audience: env.AUTH_AUDIENCE || "",
      jwksUri: env.AUTH_JWKS_URI || "",
    },
    cronSecret: env.CRON_SECRET || "",
    email: {
      webhookUrl: env.EMAIL_WEBHOOK_URL || "",
      webhookToken: env.EMAIL_WEBHOOK_TOKEN || "",
    },
  };
}
