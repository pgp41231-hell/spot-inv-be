import assert from "node:assert/strict";
import test from "node:test";
import { PostgresStore } from "../src/store/postgres.js";

test("equipment request creation writes its audit entry on the active transaction", async () => {
  const calls = [];
  const client = {
    query: async (text) => {
      calls.push(text);
      if (text.includes("FROM equipment_items")) {
        return { rows: [{ id: "equipment-1", name: "Table tennis balls", casual_available: 50, team_available: 0 }] };
      }
      if (text.includes("INSERT INTO equipment_requests")) {
        return { rows: [{ id: "request-1", request_type: "CASUAL", requester_id: "student-1", status: "PENDING" }] };
      }
      return { rows: [] };
    },
    release: () => calls.push("RELEASE"),
  };
  const store = Object.create(PostgresStore.prototype);
  store.pool = { connect: async () => client };
  store.appendAudit = async () => assert.fail("must not acquire a second pool connection");

  await store.createEquipmentRequest({
    requestType: "CASUAL",
    expectedReturnAt: new Date(Date.now() + 3_600_000).toISOString(),
    items: [{ equipmentId: "equipment-1", quantity: 10 }],
  }, { id: "student-1" });

  const auditIndex = calls.findIndex((query) => query.includes("INSERT INTO audit_log"));
  const commitIndex = calls.indexOf("COMMIT");
  assert.ok(auditIndex > -1, "audit insert should be present");
  assert.ok(auditIndex < commitIndex, "audit insert should commit atomically with the request");
  assert.equal(calls.at(-1), "RELEASE");
});

