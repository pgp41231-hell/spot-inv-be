import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import { badRequest, forbidden, unauthorized } from "./errors.js";

const scrypt = promisify(scryptCallback);

export const BOOTSTRAP_ADMIN_EMAIL = "sports@iiml.ac.in";
export const INVENTORY_KIOSK_EMAIL = "inventory@iiml.ac.in";
export const DEFAULT_EMAIL_PATTERN = String.raw`^pgp\d{5}@iiml\.ac\.in$`;
export const SESSION_TTL_DAYS = 7;

export const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

export function compileEmailPattern(pattern) {
  try {
    return new RegExp(pattern, "i");
  } catch {
    throw badRequest("The email rule must be a valid regular expression");
  }
}

export function assertEmailAllowed(email, pattern) {
  const normalized = normalizeEmail(email);
  if ([BOOTSTRAP_ADMIN_EMAIL, INVENTORY_KIOSK_EMAIL].includes(normalized)) return normalized;
  const expression = compileEmailPattern(pattern);
  expression.lastIndex = 0;
  if (!expression.test(normalized)) {
    throw forbidden("This email address is not eligible to use the sports portal");
  }
  return normalized;
}

export async function hashPassword(password) {
  if (String(password || "").length < 8) throw badRequest("Password must contain at least 8 characters");
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(String(password), salt, 64);
  return `scrypt$${salt}$${Buffer.from(derived).toString("hex")}`;
}

export async function verifyPassword(password, encoded) {
  const [, salt, storedHex] = String(encoded || "").split("$");
  if (!salt || !storedHex) return false;
  const stored = Buffer.from(storedHex, "hex");
  const derived = Buffer.from(await scrypt(String(password || ""), salt, stored.length));
  return stored.length === derived.length && timingSafeEqual(stored, derived);
}

export const sessionTokenHash = (token) => createHash("sha256").update(String(token)).digest("hex");

export async function createPasswordSession(store, user) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await store.createAuthSession({ id: randomUUID(), userId: user.id, tokenHash: sessionTokenHash(token), expiresAt });
  return { token, expiresAt };
}

export async function signupWithPassword(store, input) {
  const settings = await store.getAuthSettings();
  const email = assertEmailAllowed(input.email, settings.emailPattern);
  if (await store.getUserByEmail(email)) throw badRequest("An account already exists for this email address");
  const assignment = await store.getRoleAssignment(email);
  const role = email === BOOTSTRAP_ADMIN_EMAIL ? "admin" : (assignment?.role || "requester");
  const user = await store.ensureUser({ id: randomUUID(), email, name: input.name.trim(), role });
  await store.setPasswordHash(user.id, await hashPassword(input.password));
  return { user, ...(await createPasswordSession(store, user)) };
}

export async function loginWithPassword(store, input) {
  const email = normalizeEmail(input.email);
  const settings = await store.getAuthSettings();
  assertEmailAllowed(email, settings.emailPattern);
  const user = await store.getUserByEmail(email);
  const passwordHash = user ? await store.getPasswordHash(user.id) : null;
  if (!user || !passwordHash || !(await verifyPassword(input.password, passwordHash))) {
    throw unauthorized("Invalid email or password");
  }
  return { user, ...(await createPasswordSession(store, user)) };
}

export async function ensureLocalAdmin(store, password = BOOTSTRAP_ADMIN_EMAIL) {
  let user = await store.getUserByEmail(BOOTSTRAP_ADMIN_EMAIL);
  if (!user) user = await store.ensureUser({
    id: "local-bootstrap-admin", email: BOOTSTRAP_ADMIN_EMAIL,
    name: "Sports Committee Administrator", role: "admin", mustChangePassword: false,
  });
  if (!(await store.getPasswordHash(user.id))) {
    await store.setPasswordHash(user.id, await hashPassword(password));
  }
  return user;
}

export const LOCAL_TEST_ACCOUNTS = [
  { id: "local-student", name: "Test Student", email: "pgp10001@iiml.ac.in", role: "requester" },
  { id: "local-sportcomm", name: "Test SportComm Member", email: "pgp10002@iiml.ac.in", role: "approver" },
  { id: "local-scorekeeper", name: "Test Scorekeeper", email: "pgp10003@iiml.ac.in", role: "scorekeeper" },
  { id: "local-inventory-kiosk", name: "Inventory Kiosk", email: INVENTORY_KIOSK_EMAIL, role: "inventory_kiosk" },
];

export async function ensureLocalTestAccounts(store) {
  const created = [];
  for (const account of LOCAL_TEST_ACCOUNTS) {
    let user = await store.getUserByEmail(account.email);
    if (!user) user = await store.ensureUser({ ...account, mustChangePassword: false });
    if (!(await store.getPasswordHash(user.id))) {
      await store.setPasswordHash(user.id, await hashPassword(account.email));
    }
    created.push(user);
  }
  return created;
}
