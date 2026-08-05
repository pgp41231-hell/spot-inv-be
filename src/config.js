const splitCsv = (value) =>
  String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || "development";
  const allowedOrigins = splitCsv(env.ALLOWED_ORIGINS);
  const databaseUrl = [
    env.DATABASE_URL,
    env.POSTGRES_URL,
    env.POSTGRES_PRISMA_URL,
    env.POSTGRES_URL_NON_POOLING,
    env.SUPABASE_DB_URL,
  ].find((value) => String(value || "").trim()) || "";
  const hasOidcSettings = Boolean(env.AUTH_ISSUER && env.AUTH_AUDIENCE && env.AUTH_JWKS_URI);
  const authMode = env.AUTH_MODE || (hasOidcSettings ? "oidc" : "demo");

  if (!["demo", "oidc"].includes(authMode)) {
    throw new Error("AUTH_MODE must be either demo or oidc");
  }
  if (authMode === "oidc" && !hasOidcSettings) {
    throw new Error("AUTH_MODE=oidc requires AUTH_ISSUER, AUTH_AUDIENCE, and AUTH_JWKS_URI");
  }
  if ((env.VERCEL || env.REQUIRE_DATABASE === "true") && !databaseUrl) {
    throw new Error("Persistent database is required, but no Supabase/PostgreSQL connection URL is available");
  }

  return {
    nodeEnv,
    port: Number(env.PORT || 3000),
    allowedOrigins,
    databaseUrl,
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
