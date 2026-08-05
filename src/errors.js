export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) =>
  new AppError(400, "BAD_REQUEST", message, details);
export const unauthorized = (message = "Authentication required") =>
  new AppError(401, "UNAUTHORIZED", message);
export const forbidden = (message = "Insufficient permissions") =>
  new AppError(403, "FORBIDDEN", message);
export const notFound = (resource = "Resource") =>
  new AppError(404, "NOT_FOUND", `${resource} not found`);
export const conflict = (message, details) =>
  new AppError(409, "CONFLICT", message, details);
