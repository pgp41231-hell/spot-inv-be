import assert from "node:assert/strict";
import test from "node:test";
import { createEquipmentToken, equipmentTokenHash, verifyEquipmentToken } from "../src/equipment-tokens.js";

const secret = "test-only-secret-with-enough-entropy";

test("equipment QR tokens are opaque, signed, and verifiable", () => {
  const token = createEquipmentToken(secret);
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(verifyEquipmentToken(token, secret), token);
  assert.equal(equipmentTokenHash(token).length, 64);
});

test("equipment QR tokens reject edited signatures", () => {
  const token = createEquipmentToken(secret);
  const edited = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
  assert.throws(() => verifyEquipmentToken(edited, secret), /Invalid equipment QR token/);
});

test("equipment QR token hashes do not reveal the token", () => {
  const first = createEquipmentToken(secret);
  const second = createEquipmentToken(secret);
  assert.notEqual(first, second);
  assert.notEqual(equipmentTokenHash(first), equipmentTokenHash(second));
  assert.doesNotMatch(equipmentTokenHash(first), new RegExp(first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
