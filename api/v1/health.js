/**
 * Standalone Vercel health function.
 * It deliberately has no application imports so deployment checks do not depend
 * on database, identity-provider, or Express configuration.
 */
export default function health(_request, response) {
  response.status(200).json({
    status: "ok",
    service: "IIM Lucknow Sports Operations API",
    mode: "demo",
    timestamp: new Date().toISOString(),
  });
}
