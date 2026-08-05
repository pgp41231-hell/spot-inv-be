import { createRemoteJWKSet, jwtVerify } from "jose";
import { forbidden, unauthorized } from "./errors.js";
import { ROLES } from "./domain.js";

function bearerToken(header) {
  const match = /^Bearer\s+(.+)$/i.exec(header || "");
  return match?.[1];
}

export function createAuthenticator(config) {
  const jwks = config.jwksUri
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

    if (config.allowDevAuth) {
      const role = String(req.headers["x-user-role"] || "requester");
      if (!ROLES.includes(role)) throw unauthorized("Invalid development role");
      return {
        id: String(req.headers["x-user-id"] || "local-user"),
        email: String(req.headers["x-user-email"] || "local-user@example.edu"),
        name: String(req.headers["x-user-name"] || "Local User"),
        role,
      };
    }

    throw unauthorized();
  };
}

export function requireRoles(...roles) {
  return (req, _res, next) => {
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}
