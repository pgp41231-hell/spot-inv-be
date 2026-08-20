import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStore, MEMORY_VENUE_SEED } from "../src/store/memory.js";

test("default venue seed includes both volleyball courts and the football field", async () => {
  const store = new MemoryStore({ venues: MEMORY_VENUE_SEED });
  const venues = await store.listResources("venue", { active: true });
  assert.deepEqual(venues.map(({ name, location, sportName }) => ({ name, location, sportName })), [
    { name: "Volleyball Court", location: "Near H10", sportName: "Volleyball" },
    { name: "Volleyball Court 2", location: "Near H10", sportName: "Volleyball" },
    { name: "Football Field", location: "In front of Mess", sportName: "Football" },
  ]);
});

test("equipment catalog exposes live sports without equipment category management", async () => {
  const store = new MemoryStore();
  const catalog = await store.listEquipmentCatalog();
  assert.equal(catalog.sports.length, 11);
  assert.equal("categories" in catalog, false);
  assert.ok(catalog.sports.some((item) => item.name === "General"));
});

test("inventory reports unallocated and casual quantities separately", async () => {
  const store = new MemoryStore({ equipment: [
    { id: "balls", name: "Balls", sportId: "sport-general", quantity: 8, active: true, casualAllocatedQuantity: 8, tracking: "BULK" },
    { id: "kits", name: "Kits", sportId: "sport-cricket", quantity: 4, active: true, casualAllocatedQuantity: 0, tracking: "ASSET" },
  ] });
  const inventory = await store.listEquipmentInventory();
  assert.deepEqual(inventory.summary, { totalOwned: 12, inInventory: 4, casualPool: 8, withStudents: 0, withTeams: 0, damagedOrMissing: 0 });
  assert.equal(inventory.items.find((item) => item.id === "balls").casualPoolQuantity, 8);
  assert.equal(inventory.items.find((item) => item.id === "kits").inInventoryQuantity, 4);
});

test("admin allocation moves stock both ways and rejects over-transfer", async () => {
  const store = new MemoryStore({ equipment: [
    { id: "balls", name: "Balls", sportId: "sport-general", quantity: 8, active: true, casualAllocatedQuantity: 0, tracking: "BULK" },
  ] });
  const admin = { id: "admin", role: "admin" };
  await store.transferEquipmentState("balls", { fromState: "IN_INVENTORY", toState: "CASUAL_POOL", quantity: 5, assetIds: [], custodyIds: [] }, admin);
  let item = (await store.listEquipmentInventory()).items[0];
  assert.equal(item.inInventoryQuantity, 3); assert.equal(item.casualPoolQuantity, 5);
  await store.transferEquipmentState("balls", { fromState: "CASUAL_POOL", toState: "IN_INVENTORY", quantity: 2, assetIds: [], custodyIds: [] }, admin);
  item = (await store.listEquipmentInventory()).items[0];
  assert.equal(item.inInventoryQuantity, 5); assert.equal(item.casualPoolQuantity, 3);
  await assert.rejects(() => store.transferEquipmentState("balls", { fromState: "CASUAL_POOL", toState: "IN_INVENTORY", quantity: 4, assetIds: [], custodyIds: [] }, admin), /Only 3 units/);
});

test("memory mode supports the casual request, approval, issue, and return lifecycle", async () => {
  const store = new MemoryStore({ equipment: [
    { id: "racquets", name: "Badminton racquets", sportId: "sport-badminton", quantity: 20, active: true, casualAllocatedQuantity: 20, tracking: "BULK" },
  ] });
  const student = { id: "student", name: "Student", email: "pgp10001@iiml.ac.in", role: "requester" };
  const approver = { id: "approver", name: "SportComm", email: "pgp10002@iiml.ac.in", role: "approver" };
  const kiosk = { id: "kiosk", name: "Inventory Kiosk", email: "inventory@iiml.ac.in", role: "inventory_kiosk" };
  const request = await store.createEquipmentRequest({ requestType: "CASUAL", expectedReturnAt: new Date(Date.now() + 3_600_000).toISOString(), items: [{ equipmentId: "racquets", quantity: 4 }] }, student);
  assert.equal((await store.listEquipmentRequests(student))[0].status, "PENDING");
  await store.decideEquipmentRequest(request.id, "approve", null, approver);
  await store.createEquipmentQr({ requestId: request.id, purpose: "ISSUE", tokenHash: "issue-hash", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  await store.redeemEquipmentQr("issue-hash", [], [], kiosk);
  assert.equal((await store.listEquipmentInventory()).items[0].withStudentsQuantity, 4);

  const secondRequest = await store.createEquipmentRequest({ requestType: "CASUAL", expectedReturnAt: new Date(Date.now() + 7_200_000).toISOString(), items: [{ equipmentId: "racquets", quantity: 2 }] }, student);
  await assert.rejects(
    () => store.decideEquipmentRequest(secondRequest.id, "approve", null, approver),
    /Confirm approval again/,
  );
  await store.decideEquipmentRequest(secondRequest.id, "approve", null, approver, true);
  assert.equal((await store.getEquipmentRequest(secondRequest.id)).allowConcurrentIssue, true);
  await store.createEquipmentQr({ requestId: secondRequest.id, purpose: "ISSUE", tokenHash: "second-issue-hash", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  assert.equal((await store.inspectEquipmentQr("second-issue-hash")).concurrentIssueWarning.id, request.id);
  await assert.rejects(
    () => store.redeemEquipmentQr("second-issue-hash", [], [], kiosk),
    /Confirm the additional handover/,
  );
  await store.redeemEquipmentQr("second-issue-hash", [], [], kiosk, true);
  assert.equal((await store.listEquipmentInventory()).items[0].withStudentsQuantity, 6);
  const returned = await store.createEquipmentRequest({ requestType: "RETURN", parentRequestId: request.id, items: [{ equipmentId: "racquets", quantity: 4 }] }, student);
  await store.createEquipmentQr({ requestId: returned.id, purpose: "RETURN", tokenHash: "return-hash", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  await store.redeemEquipmentQr("return-hash", [], [], kiosk);
  const inventory = (await store.listEquipmentInventory()).items[0];
  assert.equal(inventory.withStudentsQuantity, 2);
  assert.equal(inventory.casualPoolQuantity, 18);
  assert.equal((await store.listEquipmentAudit()).length, 3);
});
