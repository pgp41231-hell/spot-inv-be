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
  const hasSupabaseSettings = Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY);
  const authMode = env.AUTH_MODE || (hasSupabaseSettings ? "supabase" : hasOidcSettings ? "oidc" : "demo");

  if (!["demo", "password", "supabase", "oidc"].includes(authMode)) {
    throw new Error("AUTH_MODE must be demo, password, supabase, or oidc");
  }
  if (authMode === "oidc" && !hasOidcSettings) {
    throw new Error("AUTH_MODE=oidc requires AUTH_ISSUER, AUTH_AUDIENCE, and AUTH_JWKS_URI");
  }
  if (authMode === "supabase" && (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY)) {
    throw new Error("AUTH_MODE=supabase requires SUPABASE_URL and SUPABASE_ANON_KEY");
  }
  if ((env.VERCEL || env.REQUIRE_DATABASE === "true") && !databaseUrl) {
    throw new Error("Persistent database is required, but no Supabase/PostgreSQL connection URL is available");
  }
  if (env.VERCEL && ["demo", "password"].includes(authMode)) {
    throw new Error("Vercel deployments require AUTH_MODE=supabase (or fully configured oidc); demo/password authentication is local-only");
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
      supabaseUrl: String(env.SUPABASE_URL || "").replace(/\/$/, ""),
      supabaseAnonKey: env.SUPABASE_ANON_KEY || "",
      supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY || "",
      adminSeedPassword: env.ADMIN_SEED_PASSWORD || "sportscomm@iiml.ac.in",
    },
    cronSecret: env.CRON_SECRET || "",
    email: {
      webhookUrl: env.EMAIL_WEBHOOK_URL || "",
      webhookToken: env.EMAIL_WEBHOOK_TOKEN || "",
    },
    qr: {
      secret: env.QR_TOKEN_SECRET || "",
      ttlHours: Number(env.QR_TOKEN_TTL_HOURS || 6),
    },
  };
}
