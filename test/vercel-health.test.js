import test from "node:test";
import assert from "node:assert/strict";
import health from "../api/v1/health.js";

test("standalone Vercel health function reports its storage mode", () => {
  const result = {};
  const response = {
    status(code) { result.status = code; return this; },
    json(body) { result.body = body; },
  };
  health({}, response);
  assert.equal(result.status, 200);
  assert.equal(result.body.status, "ok");
  assert.equal(result.body.authMode, "demo");
  assert.equal(result.body.storage, "memory");
});
