const SSL_QUERY_PARAMETERS = ["sslmode", "sslcert", "sslkey", "sslrootcert", "uselibpqcompat"];

export function postgresConnectionConfig(databaseUrl) {
  const url = new URL(databaseUrl);
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);

  // node-postgres lets SSL parameters in the URL replace the explicit `ssl`
  // object. Supabase URLs include sslmode=require, so remove URL-level SSL
  // parameters and use the explicit serverless-compatible setting below.
  for (const parameter of SSL_QUERY_PARAMETERS) url.searchParams.delete(parameter);

  return {
    connectionString: url.toString(),
    ssl: isLocal ? false : { rejectUnauthorized: false },
  };
}
