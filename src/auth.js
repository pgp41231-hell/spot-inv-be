import { createRemoteJWKSet, jwtVerify } from "jose";
import { forbidden, unauthorized } from "./errors.js";
import { ROLES } from "./domain.js";
import { sessionTokenHash } from "./password-auth.js";

function bearerToken(header) {
  const match = /^Bearer\s+(.+)$/i.exec(header || "");
  return match?.[1];
}

export function createAuthenticator(config, store) {
  const jwks = config.mode === "oidc"
    ? createRemoteJWKSet(new URL(config.jwksUri))
    : null;

  return async function authenticate(req) {
    const token = bearerToken(req.headers.authorization);
    if (token && config.mode === "supabase") {
      const response = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
        headers: { apikey: config.supabaseAnonKey, Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw unauthorized("Invalid or expired Supabase session");
      const user = await response.json();
      return {
        id: String(user.id),
        email: String(user.email || "").toLowerCase(),
        name: String(user.user_metadata?.name || user.email || user.id),
        role: "requester",
        authUpdatedAt: user.updated_at,
      };
    }
    if (token && config.mode === "password") {
      const session = await store.getAuthSession(sessionTokenHash(token));
      if (!session || new Date(session.expiresAt) <= new Date()) throw unauthorized("Session expired");
      return store.getUser(session.userId);
    }
    if (token && jwks) {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: config.issuer,
        audience: config.audience,
      });
      const role = ROLES.includes(payload.role) ? payload.role : "requester";
      return {
        id: String(payload.sub),
        email: String(payload.email || ""),
        name: String(payload.name || payload.email || payload.sub),
        role,
      };
    }

    if (config.mode !== "demo") throw unauthorized();

    // Temporary bootstrap mode for frontend development before institutional SSO is connected.
    // Never use this mode for a public production launch with real user data.
    const role = String(req.headers["x-user-role"] || "requester");
    if (!ROLES.includes(role)) throw new Error("Invalid demo role");
    return {
      id: String(req.headers["x-user-id"] || "demo-user"),
      email: String(req.headers["x-user-email"] || "demo-user@example.edu"),
      name: String(req.headers["x-user-name"] || "Demo User"),
      role,
    };
  };
}

export function requireRoles(...roles) {
  return (req, _res, next) => {
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}
