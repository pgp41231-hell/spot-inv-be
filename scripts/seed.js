import { PostgresStore } from "../src/store/postgres.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const store = new PostgresStore(process.env.DATABASE_URL);
const admin = {
  id: process.env.SEED_ADMIN_SUB || "seed-admin",
  email: process.env.SEED_ADMIN_EMAIL || "sports.committee@example.edu",
  name: process.env.SEED_ADMIN_NAME || "Sports Committee Admin",
  role: "admin",
};
await store.ensureUser(admin);
await store.setUserRole(admin.id, "admin");

const venues = await store.listResources("venue");
if (venues.length === 0) {
  await store.createResource("venue", {
    name: "Main Football Ground", category: "ground", location: "Sports Complex",
    capacity: 80, amenities: ["floodlights"], rules: {}, active: true,
  }, admin);
  await store.createResource("venue", {
    name: "Badminton Court 1", category: "court", location: "Indoor Sports Hall",
    capacity: 8, amenities: ["indoor", "lighting"], rules: {}, active: true,
  }, admin);
}

const equipment = await store.listResources("equipment");
if (equipment.length === 0) {
  await store.createResource("equipment", {
    name: "Badminton Racquet", category: "racquet", location: "Equipment Desk",
    quantity: 12, condition: "good", metadata: {}, active: true,
  }, admin);
  await store.createResource("equipment", {
    name: "Football", category: "ball", location: "Equipment Desk",
    quantity: 8, condition: "good", metadata: {}, active: true,
  }, admin);
}

const flows = await store.listApprovalFlows();
if (flows.length === 0) {
  await store.createApprovalFlow({
    name: "Default venue approval", resourceType: "venue", resourceId: null, active: true,
    steps: [{ label: "Sports Committee review", role: "approver" }],
  }, admin);
}

console.log("Seed data is ready");
