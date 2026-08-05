import { createRemoteJWKSet, jwtVerify } from "jose";
import { forbidden } from "./errors.js";
import { ROLES } from "./domain.js";

function bearerToken(header) {
  const match = /^Bearer\s+(.+)$/i.exec(header || "");
  return match?.[1];
}

export function createAuthenticator(config) {
  const jwks = config.mode === "oidc"
    ? createRemoteJWKSet(new URL(config.jwksUri))
    : null;

  return async function authenticate(req) {
    const token = bearerToken(req.headers.authorization);
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

    // Temporary bootstrap mode for frontend development before institutional SSO is connected.
    // Never use this mode for a public production launch with real user data.
    const role = String(req.headers["x-user-role"] || "admin");
    if (!ROLES.includes(role)) throw new Error("Invalid demo role");
    return {
      id: String(req.headers["x-user-id"] || "demo-admin"),
      email: String(req.headers["x-user-email"] || "demo-admin@example.edu"),
      name: String(req.headers["x-user-name"] || "Demo Admin"),
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
