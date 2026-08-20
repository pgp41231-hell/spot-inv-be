import { randomUUID } from "node:crypto";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../errors.js";
import { holdExpiryFrom, isHoldActive } from "../holds.js";
import { BOOTSTRAP_ADMIN_EMAIL, DEFAULT_EMAIL_PATTERN, normalizeEmail } from "../password-auth.js";

const now = () => new Date().toISOString();
const clone = (value) => structuredClone(value);
const CATALOG_SPORTS = ["Cricket","Football","Basketball","Badminton","Table Tennis","Volleyball","Tennis","Squash","Chess","Athletics","General"];
const CATALOG_LOCATIONS = ["Sports Complex","Main Ground","Indoor Hall","Equipment Store","Gymnasium"];
const catalogRows = (prefix, names) => names.map((name) => ({ id: `${prefix}-${name.toLowerCase().replace(/[^a-z0-9]+/g,"-")}`, name, active: true }));
const equipmentSeedRows = [
  ["Badminton racquets",20,"Badminton","Racquets","CASUAL","BULK"],["Shuttlecocks",60,"Badminton","Balls","CASUAL","BULK"],
  ["Table tennis bats",12,"Table Tennis","Racquets","CASUAL","BULK"],["Table tennis balls",50,"Table Tennis","Balls","CASUAL","BULK"],
  ["Footballs",8,"Football","Balls","CASUAL","BULK"],["Basketballs",8,"Basketball","Balls","CASUAL","BULK"],
  ["Volleyballs",6,"Volleyball","Balls","CASUAL","BULK"],["Tennis racquets",10,"Tennis","Racquets","CASUAL","BULK"],
  ["Tennis balls",40,"Tennis","Balls","CASUAL","BULK"],["Chess sets",15,"Chess","Kit","CASUAL","BULK"],
  ["Training cones",30,"General","Training aids","CASUAL","BULK"],["Training bibs",25,"General","Kit","CASUAL","BULK"],
  ["Cricket kit bags",4,"Cricket","Kit","TEAM","ASSET"],["Cricket bats",10,"Cricket","Kit","TEAM","ASSET"],
  ["Cricket balls",30,"Cricket","Balls","TEAM","BULK"],["Batting pads (pairs)",8,"Cricket","Protective gear","TEAM","ASSET"],
  ["Batting gloves (pairs)",8,"Cricket","Protective gear","TEAM","BULK"],["Wicket keeping set",2,"Cricket","Protective gear","TEAM","ASSET"],
  ["Match footballs",6,"Football","Balls","TEAM","BULK"],["Football goal nets",4,"Football","Nets and posts","TEAM","ASSET"],
  ["Basketball match balls",4,"Basketball","Balls","TEAM","BULK"],["Volleyball net",2,"Volleyball","Nets and posts","TEAM","ASSET"],
  ["Badminton match shuttles",40,"Badminton","Balls","TEAM","BULK"],
];
export const MEMORY_EQUIPMENT_SEED = equipmentSeedRows.map(([name,quantity,sport,_category,pool,tracking],index) => ({
  id: `seed-equipment-${index + 1}`, name, quantity, sportId: `sport-${sport.toLowerCase().replace(/[^a-z0-9]+/g,"-")}`,
  sportName: sport, tracking, casualAllocatedQuantity: pool === "CASUAL" ? quantity : 0,
  metadata: {}, active: true, createdAt: now(), updatedAt: now(),
}));

export const MEMORY_VENUE_SEED = [
  { id: "seed-venue-volleyball-court-1", name: "Volleyball Court", sportId: "sport-volleyball", sportName: "Volleyball", category: "Volleyball", location: "Near H10" },
  { id: "seed-venue-volleyball-court-2", name: "Volleyball Court 2", sportId: "sport-volleyball", sportName: "Volleyball", category: "Volleyball", location: "Near H10" },
  { id: "seed-venue-football-field", name: "Football Field", sportId: "sport-football", sportName: "Football", category: "Football", location: "In front of Mess" },
].map((venue) => ({ ...venue, locationId: null, capacity: 1, amenities: [], rules: {}, active: true, createdAt: now(), updatedAt: now() }));

export class MemoryStore {
  constructor(seed = {}) {
    this.users = new Map();
    this.passwordHashes = new Map();
    this.authSessions = new Map();
    this.roleAssignments = new Map();
    this.authSettings = { emailPattern: DEFAULT_EMAIL_PATTERN, updatedAt: now(), updatedBy: null };
    this.venues = new Map();
    this.equipment = new Map();
    this.equipmentAssets = new Map();
    this.equipmentRequests = new Map();
    this.equipmentQrTokens = new Map();
    this.equipmentCustody = new Map();
    this.equipmentStateAudit = [];
    this.sports = catalogRows("sport", CATALOG_SPORTS);
    this.teams = [];
    this.campusLocations = catalogRows("location", CATALOG_LOCATIONS);
    this.bookings = new Map();
    this.blackouts = new Map();
    this.holds = new Map();
    this.approvalFlows = new Map();
    this.decisions = new Map();
    this.committee = new Map();
    this.gallery = new Map();
    this.tournaments = new Map();
    this.matches = new Map();
    this.standings = new Map();
    this.notifications = new Map();
    this.audit = [];

    for (const venue of seed.venues || []) this.venues.set(venue.id, clone(venue));
    for (const item of seed.equipment || []) {
      const normalized = { ...clone(item), casualAllocatedQuantity: item.casualAllocatedQuantity ?? (item.pool === "CASUAL" ? Number(item.quantity) : 0), stateQuantities: clone(item.stateQuantities || {}) };
      delete normalized.pool; delete normalized.category; delete normalized.categoryId; delete normalized.location; delete normalized.locationId; delete normalized.condition;
      this.equipment.set(item.id, normalized);
      if (normalized.tracking === "ASSET") for (let index = 0; index < normalized.quantity; index += 1) {
        const asset = { id: `${item.id}-asset-${index + 1}`, equipmentId: item.id, assetTag: `${item.id.toUpperCase()}-${String(index + 1).padStart(3,"0")}`, state: index < normalized.casualAllocatedQuantity ? "CASUAL_POOL" : "IN_INVENTORY", condition: "good" };
        this.equipmentAssets.set(asset.id, asset);
      }
    }
    for (const flow of seed.approvalFlows || []) this.approvalFlows.set(flow.id, clone(flow));
  }

  async close() {}

  async ensureUser(user) {
    const existing = this.users.get(user.id);
    const email = normalizeEmail(user.email);
    const role = email === BOOTSTRAP_ADMIN_EMAIL ? "admin" : (existing?.role || user.role || "requester");
    const record = { ...existing, ...user, email, role, updatedAt: now(), createdAt: existing?.createdAt || now() };
    this.users.set(user.id, record);
    return clone(record);
  }

  async listUsers() {
    return clone([...this.users.values()]);
  }

  async getUser(id) {
    const user = this.users.get(id);
    if (!user) throw notFound("User");
    return clone(user);
  }

  async getUserByEmail(email) {
    const normalized = normalizeEmail(email);
    const user = [...this.users.values()].find((item) => item.email === normalized);
    return user ? clone(user) : null;
  }

  async clearMustChangePassword(id) {
    const user = this.users.get(id);
    if (!user) throw notFound("User");
    user.mustChangePassword = false;
    user.updatedAt = now();
    return clone(user);
  }

  async getRoleAssignment(email) {
    const assignment = this.roleAssignments.get(normalizeEmail(email));
    return assignment ? clone(assignment) : null;
  }

  async listRoleAssignments() {
    return clone([...this.roleAssignments.values()].sort((a, b) => a.email.localeCompare(b.email)));
  }

  async setRoleAssignment(email, role, actor) {
    const normalized = normalizeEmail(email);
    if (normalized === BOOTSTRAP_ADMIN_EMAIL) throw forbidden("The bootstrap administrator role is fixed");
    if (role === "requester") {
      this.roleAssignments.delete(normalized);
    } else {
      this.roleAssignments.set(normalized, { email: normalized, role, updatedAt: now(), updatedBy: actor.id });
    }
    const user = [...this.users.values()].find((item) => item.email === normalized);
    if (user) { user.role = role; user.updatedAt = now(); }
    return role === "requester" ? null : clone(this.roleAssignments.get(normalized));
  }

  async deleteRoleAssignment(email, actor) {
    return this.setRoleAssignment(email, "requester", actor);
  }

  async setPasswordHash(userId, passwordHash) {
    this.passwordHashes.set(userId, passwordHash);
  }

  async getPasswordHash(userId) {
    return this.passwordHashes.get(userId) || null;
  }

  async createAuthSession(session) {
    this.authSessions.set(session.tokenHash, { ...session, createdAt: now() });
  }

  async getAuthSession(tokenHash) {
    const session = this.authSessions.get(tokenHash);
    return session ? clone(session) : null;
  }

  async deleteAuthSession(tokenHash) {
    this.authSessions.delete(tokenHash);
  }

  async getAuthSettings() {
    return clone(this.authSettings);
  }

  async setEmailPattern(emailPattern, actor) {
    this.authSettings = { emailPattern, updatedAt: now(), updatedBy: actor.id };
    return clone(this.authSettings);
  }

  async setUserRole(id, role) {
    const user = this.users.get(id);
    if (!user) throw notFound("User");
    if (user.email === BOOTSTRAP_ADMIN_EMAIL) throw forbidden("The bootstrap administrator role cannot be changed");
    if (role === "admin") throw forbidden("Only sports@iiml.ac.in can be an administrator");
    user.role = role;
    user.updatedAt = now();
    return clone(user);
  }

  collection(type) {
    if (type === "venue") return this.venues;
    if (type === "equipment") return this.equipment;
    throw new Error(`Unknown resource type: ${type}`);
  }

  async listResources(type, filters = {}) {
    let values = [...this.collection(type).values()];
    if (filters.active !== undefined) values = values.filter((x) => x.active === filters.active);
    if (filters.category) values = values.filter((x) => x.category === filters.category);
    if (filters.minCapacity) values = values.filter((x) => (x.capacity || x.quantity || 0) >= filters.minCapacity);
    if (filters.q) {
      const q = filters.q.toLowerCase();
      values = values.filter((x) => `${x.name} ${x.location || ""}`.toLowerCase().includes(q));
    }
    if (type === "venue") values = values.map((item) => ({
      ...item,
      sportName: this.sports.find((sport) => sport.id === item.sportId || sport.name.toLowerCase() === String(item.category || "").toLowerCase())?.name || null,
    }));
    if (type === "equipment") values = values.map((item) => {
      const { assets: _assets, holders: _holders, ...publicItem } = this.equipmentBreakdown(item);
      return publicItem;
    });
    return clone(values);
  }

  async getResource(type, id) {
    const item = this.collection(type).get(id);
    if (!item) throw notFound(type === "venue" ? "Venue" : "Equipment item");
    return clone(item);
  }

  async createResource(type, data, actor) {
    const id = randomUUID();
    const record = {
      id,
      ...clone(data),
      active: data.active ?? true,
      createdAt: now(),
      updatedAt: now(),
    };
    if (type === "equipment") { record.casualAllocatedQuantity = 0; record.stateQuantities = {}; }
    this.collection(type).set(id, record);
    await this.appendAudit(actor, `${type}.created`, type, id, null, record);
    return clone(record);
  }

  async updateResource(type, id, data, actor) {
    const before = await this.getResource(type, id);
    const after = { ...before, ...clone(data), id, updatedAt: now() };
    this.collection(type).set(id, after);
    await this.appendAudit(actor, `${type}.updated`, type, id, before, after);
    return clone(after);
  }

  async deleteResource(type, id, actor) {
    const before = await this.getResource(type, id);
    const after = { ...before, active: false, updatedAt: now() };
    this.collection(type).set(id, after);
    await this.appendAudit(actor, `${type}.deactivated`, type, id, before, after);
    return clone(after);
  }

  async listSports() { return clone(this.sports); }

  async createSport(data, actor) {
    if (this.sports.some((sport) => sport.name.toLowerCase() === data.name.toLowerCase())) throw conflict("That sport already exists");
    const record = { id: randomUUID(), name: data.name.trim(), active: data.active ?? true, primaryPocId: null, secondaryPocId: null, createdAt: now(), updatedAt: now() };
    this.sports.push(record);
    await this.appendAudit(actor, "sport.created", "sport", record.id, null, record);
    return clone(record);
  }

  async updateSport(id, data, actor) {
    const index = this.sports.findIndex((sport) => sport.id === id);
    if (index < 0) throw notFound("Sport");
    const before = clone(this.sports[index]);
    this.sports[index] = { ...this.sports[index], ...clone(data), updatedAt: now() };
    await this.appendAudit(actor, "sport.updated", "sport", id, before, this.sports[index]);
    return clone(this.sports[index]);
  }

  async setSportPocs(sportId, data, actor) {
    return this.updateSport(sportId, { primaryPocId: data.primaryPocId || null, secondaryPocId: data.secondaryPocId || null }, actor);
  }

  async listTeams() { return clone(this.teams); }

  async assignSportCaptain(sportId, email, actor) {
    const sport = this.sports.find((item) => item.id === sportId);
    if (!sport) throw notFound("Sport");
    const captain = await this.getUserByEmail(email);
    if (!captain) throw notFound("Student account; ask the student to sign up before assigning them as captain");
    if (captain.role !== "requester") throw badRequest("A captain must have the Student role");
    for (const team of this.teams) if (team.sportId === sportId) team.active = false;
    let team = this.teams.find((item) => item.sportId === sportId);
    if (team) Object.assign(team, { name: sport.name, captainId: captain.id, captainName: captain.name, captainEmail: captain.email, active: true, updatedAt: now() });
    else {
      team = { id: randomUUID(), name: sport.name, sportId, sportName: sport.name, captainId: captain.id, captainName: captain.name, captainEmail: captain.email, members: [captain], active: true, createdBy: actor.id, createdAt: now(), updatedAt: now() };
      this.teams.push(team);
    }
    await this.appendAudit(actor, "sport.captain.assigned", "sport", sportId, null, { captainId: captain.id, captainEmail: captain.email, teamId: team.id });
    return clone(team);
  }
  async listEquipmentRequests(user) {
    const requests = [...this.equipmentRequests.values()];
    const visible = ["admin", "approver", "inventory_kiosk"].includes(user.role)
      ? requests
      : requests.filter((request) => request.requesterId === user.id);
    return clone(visible.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }

  async getEquipmentRequest(id) {
    const request = this.equipmentRequests.get(id);
    if (!request) throw notFound("Equipment request");
    return clone(request);
  }

  async createEquipmentRequest(data, actor) {
    let team = null;
    let parent = null;
    if (data.requestType === "TEAM") {
      team = this.teams.find((item) => item.id === data.teamId && item.active);
      if (!team) throw notFound("Team");
      if (team.captainId !== actor.id) throw forbidden("Only this team's captain can request equipment");
    }
    if (data.requestType === "RETURN") {
      parent = this.equipmentRequests.get(data.parentRequestId);
      if (!parent) throw notFound("Original equipment request");
      if (parent.requesterId !== actor.id) throw forbidden("Only the original requester can return this equipment");
      if (parent.status !== "ISSUED") throw conflict("Only currently issued equipment can be returned");
    }
    const items = data.items.map((requested) => {
      const equipment = this.equipment.get(requested.equipmentId);
      if (!equipment || !equipment.active) throw notFound("Equipment item");
      const available = this.equipmentBreakdown(equipment);
      if (data.requestType === "CASUAL" && available.casualPoolQuantity < requested.quantity) throw conflict(`${equipment.name} does not have enough quantity in the casual pool`);
      if (data.requestType === "TEAM" && available.inInventoryQuantity < requested.quantity) throw conflict(`${equipment.name} does not have enough unallocated inventory`);
      if (data.requestType === "RETURN") {
        const held = [...this.equipmentCustody.values()].filter((entry) => entry.sourceRequestId === parent.id && entry.equipmentId === requested.equipmentId && ["ISSUED_TO_STUDENT", "HELD_BY_TEAM"].includes(entry.state)).reduce((sum, entry) => sum + entry.quantity, 0);
        if (held < requested.quantity) throw conflict("Return quantity exceeds current custody");
      }
      return { equipmentId: equipment.id, name: equipment.name, quantity: Number(requested.quantity), tracking: equipment.tracking };
    });
    const request = {
      id: randomUUID(), requestType: data.requestType, requesterId: actor.id, requesterName: actor.name,
      requesterEmail: actor.email, teamId: team?.id || parent?.teamId || null, teamName: team?.name || parent?.teamName || null,
      sportId: team?.sportId || parent?.sportId || null, parentRequestId: parent?.id || null,
      expectedReturnAt: data.expectedReturnAt || null, dueAt: null,
      status: data.requestType === "RETURN" ? "APPROVED" : "PENDING", allowConcurrentIssue: false, items, createdAt: now(), updatedAt: now(),
    };
    this.equipmentRequests.set(request.id, request);
    await this.appendAudit(actor, `equipment_request.${data.requestType.toLowerCase()}.created`, "equipment_request", request.id, null, request);
    return clone(request);
  }

  async decideEquipmentRequest(id, decision, note, actor, confirmConcurrentIssue = false) {
    const request = this.equipmentRequests.get(id);
    if (!request) throw notFound("Equipment request");
    if (request.status !== "PENDING") throw conflict("This equipment request has already been decided");
    const sport = this.sports.find((item) => item.id === request.sportId);
    const allowed = actor.role === "admin" || (actor.role === "approver" && (request.requestType === "CASUAL" || [sport?.primaryPocId, sport?.secondaryPocId].includes(actor.id)));
    if (!allowed) throw forbidden("You can view this request but are not its assigned approver");
    const activeIssue = decision === "approve" && request.requestType === "CASUAL"
      ? [...this.equipmentRequests.values()].find((item) => item.id !== request.id && item.requesterId === request.requesterId && item.requestType === "CASUAL" && ["ISSUED", "RETURN_PENDING"].includes(item.status))
      : null;
    if (activeIssue && !confirmConcurrentIssue) {
      throw conflict(
        "This student already has equipment issued. Confirm approval again to allow another handover.",
        { requiresConfirmation: true, activeIssue: clone(activeIssue) },
      );
    }
    const before = clone(request);
    Object.assign(request, { status: decision === "approve" ? "APPROVED" : "REJECTED", decisionNote: note || null, approvedBy: actor.id, approvedAt: now(), dueAt: decision === "approve" && request.requestType === "CASUAL" ? request.expectedReturnAt : null, administratorOverride: actor.role === "admin", allowConcurrentIssue: Boolean(activeIssue && confirmConcurrentIssue), updatedAt: now() });
    const auditAction = request.allowConcurrentIssue ? "equipment_request.concurrent_issue_override.approve" : actor.role === "admin" ? `equipment_request.admin_override.${decision}` : `equipment_request.${decision}`;
    await this.appendAudit(actor, auditAction, "equipment_request", id, before, request);
    return clone(request);
  }

  async createEquipmentQr(data) {
    const token = { id: randomUUID(), requestId: data.requestId, purpose: data.purpose, tokenHash: data.tokenHash, expiresAt: data.expiresAt, usedAt: null, usedBy: null, createdAt: now() };
    this.equipmentQrTokens.set(token.tokenHash, token);
    return clone(token);
  }

  async inspectEquipmentQr(tokenHash) {
    const token = this.equipmentQrTokens.get(tokenHash);
    if (!token) throw unauthorized("Invalid equipment QR token");
    if (token.usedAt) throw conflict(`Equipment QR token was already used at ${token.usedAt} by ${token.usedByName || token.usedBy}`);
    if (new Date(token.expiresAt) <= new Date()) throw badRequest("Equipment QR token has expired");
    const request = this.equipmentRequests.get(token.requestId);
    if (!request) throw notFound("Equipment request");
    const items = request.items.map((item) => {
      const equipment = this.equipment.get(item.equipmentId);
      const sourceState = request.requestType === "CASUAL" ? "CASUAL_POOL" : "IN_INVENTORY";
      const assets = equipment.tracking !== "ASSET" ? [] : token.purpose === "ISSUE"
        ? [...this.equipmentAssets.values()].filter((asset) => asset.equipmentId === equipment.id && asset.state === sourceState)
        : [...this.equipmentCustody.values()].filter((entry) => entry.sourceRequestId === request.parentRequestId && entry.equipmentId === equipment.id && entry.assetId && ["ISSUED_TO_STUDENT", "HELD_BY_TEAM"].includes(entry.state)).map((entry) => this.equipmentAssets.get(entry.assetId));
      return { ...item, tracking: equipment.tracking, assets: clone(assets.filter(Boolean)) };
    });
    const activeIssue = token.purpose === "ISSUE" && request.requestType === "CASUAL"
      ? [...this.equipmentRequests.values()].find((item) => item.id !== request.id && item.requesterId === request.requesterId && item.requestType === "CASUAL" && ["ISSUED", "RETURN_PENDING"].includes(item.status))
      : null;
    return clone({ ...token, ...request, purpose: token.purpose, items, concurrentIssueWarning: activeIssue || null });
  }

  async redeemEquipmentQr(tokenHash, outcomes = [], assetScans = [], actor, confirmConcurrentIssue = false) {
    if (!["inventory_kiosk", "admin"].includes(actor.role)) throw forbidden("Only the inventory kiosk can scan equipment QR codes");
    const preview = await this.inspectEquipmentQr(tokenHash);
    const request = this.equipmentRequests.get(preview.requestId);
    if (request.status !== "APPROVED") throw conflict(preview.purpose === "ISSUE" ? "The approval is no longer valid" : "This return is no longer valid");
    const outcomeMap = new Map(outcomes.map((item) => [item.equipmentId, item]));
    const scansFor = (equipmentId) => assetScans.filter((scan) => scan.equipmentId === equipmentId);
    if (preview.purpose === "ISSUE") {
      if (request.requestType === "CASUAL") {
        const activeIssue = [...this.equipmentRequests.values()].find((item) => item.id !== request.id && item.requesterId === request.requesterId && item.requestType === "CASUAL" && ["ISSUED", "RETURN_PENDING"].includes(item.status));
        if (activeIssue && !confirmConcurrentIssue) {
          throw conflict(
            "This student already has equipment issued. Confirm the additional handover to continue.",
            { requiresIssuerConfirmation: true, activeIssueId: activeIssue.id },
          );
        }
        if (activeIssue) {
          request.allowConcurrentIssue = true;
          await this.appendAudit(actor, "equipment_request.kiosk_concurrent_issue_confirmed", "equipment_request", request.id, null, { activeIssueId: activeIssue.id, confirmedBy: actor.id });
        }
      }
      for (const item of request.items) {
        const equipment = this.equipment.get(item.equipmentId);
        const sourceState = request.requestType === "CASUAL" ? "CASUAL_POOL" : "IN_INVENTORY";
        const target = request.requestType === "CASUAL" ? "ISSUED_TO_STUDENT" : "HELD_BY_TEAM";
        if (equipment.tracking === "ASSET") {
          const scans = scansFor(item.equipmentId);
          if (scans.length !== item.quantity) throw badRequest(`Scan exactly ${item.quantity} asset tag(s) for this tracked item`);
          const assets = scans.map((scan) => [...this.equipmentAssets.values()].find((asset) => asset.equipmentId === item.equipmentId && asset.assetTag.toLowerCase() === String(scan.assetTag).replace(/^asset:/i, "").toLowerCase() && asset.state === sourceState));
          if (assets.some((asset) => !asset) || new Set(assets.map((asset) => asset.id)).size !== item.quantity) throw conflict("One or more scanned asset tags are invalid or no longer available for this request");
          for (const asset of assets) {
            asset.state = target;
            this.recordMemoryCustody(equipment, asset.id, 1, target, request);
            this.recordMemoryEquipmentAudit(equipment.id, asset.id, 1, sourceState, target, actor, request);
          }
        } else {
          if (this.equipmentBreakdown(equipment)[sourceState === "CASUAL_POOL" ? "casualPoolQuantity" : "inInventoryQuantity"] < item.quantity) throw conflict("Insufficient available equipment at issue time");
          equipment.stateQuantities[target] = Number(equipment.stateQuantities[target] || 0) + item.quantity;
          this.recordMemoryCustody(equipment, null, item.quantity, target, request);
          this.recordMemoryEquipmentAudit(equipment.id, null, item.quantity, sourceState, target, actor, request);
        }
      }
      request.status = "ISSUED";
    } else {
      const parent = this.equipmentRequests.get(request.parentRequestId);
      const returnTarget = parent.requestType === "CASUAL" ? "CASUAL_POOL" : "IN_INVENTORY";
      for (const item of request.items) {
        const equipment = this.equipment.get(item.equipmentId);
        const active = [...this.equipmentCustody.values()].filter((entry) => entry.sourceRequestId === parent.id && entry.equipmentId === item.equipmentId && ["ISSUED_TO_STUDENT", "HELD_BY_TEAM"].includes(entry.state));
        if (equipment.tracking === "ASSET") {
          const scans = scansFor(item.equipmentId);
          if (scans.length !== item.quantity) throw badRequest(`Account for exactly ${item.quantity} asset tag(s) for this tracked return`);
          for (const scan of scans) {
            const asset = [...this.equipmentAssets.values()].find((candidate) => candidate.equipmentId === item.equipmentId && candidate.assetTag.toLowerCase() === String(scan.assetTag).replace(/^asset:/i, "").toLowerCase());
            const custody = active.find((entry) => entry.assetId === asset?.id);
            if (!asset || !custody) throw conflict("One or more asset tags do not belong to this issue, or have already been returned");
            const target = scan.outcome === "RETURNED" ? returnTarget : scan.outcome;
            const fromState = custody.state;
            asset.state = target; asset.note = scan.note || null;
            if (["IN_INVENTORY", "CASUAL_POOL"].includes(target)) this.equipmentCustody.delete(custody.id); else { custody.state = target; custody.note = scan.note || null; }
            this.recordMemoryEquipmentAudit(equipment.id, asset.id, 1, fromState, target, actor, request, scan.note);
          }
        } else {
          const outcome = outcomeMap.get(item.equipmentId) || {};
          const damaged = Number(outcome.damaged || 0), missing = Number(outcome.missing || 0);
          if (damaged + missing > item.quantity) throw badRequest("Damaged and missing quantities exceed the return quantity");
          let remaining = item.quantity, damagedLeft = damaged, missingLeft = missing;
          for (const custody of active) {
            if (!remaining) break;
            const take = Math.min(remaining, custody.quantity);
            const damagedTake = Math.min(take, damagedLeft); damagedLeft -= damagedTake;
            const missingTake = Math.min(take - damagedTake, missingLeft); missingLeft -= missingTake;
            equipment.stateQuantities[custody.state] = Math.max(0, Number(equipment.stateQuantities[custody.state] || 0) - take);
            equipment.stateQuantities.DAMAGED = Number(equipment.stateQuantities.DAMAGED || 0) + damagedTake;
            equipment.stateQuantities.MISSING = Number(equipment.stateQuantities.MISSING || 0) + missingTake;
            if (custody.quantity === take) this.equipmentCustody.delete(custody.id); else custody.quantity -= take;
            for (const [quantity, target] of [[take - damagedTake - missingTake, returnTarget], [damagedTake, "DAMAGED"], [missingTake, "MISSING"]]) if (quantity) this.recordMemoryEquipmentAudit(equipment.id, null, quantity, custody.state, target, actor, request, outcome.note);
            remaining -= take;
          }
          if (parent.requestType === "CASUAL") equipment.casualAllocatedQuantity = Math.max(0, equipment.casualAllocatedQuantity - damaged - missing);
        }
      }
      request.status = "COMPLETED";
      if (![...this.equipmentCustody.values()].some((entry) => entry.sourceRequestId === parent.id && ["ISSUED_TO_STUDENT", "HELD_BY_TEAM"].includes(entry.state))) parent.status = "COMPLETED";
    }
    request.updatedAt = now();
    const token = this.equipmentQrTokens.get(tokenHash);
    Object.assign(token, { usedAt: now(), usedBy: actor.id, usedByName: actor.name });
    return { requestId: request.id, purpose: preview.purpose, status: "completed" };
  }

  recordMemoryCustody(equipment, assetId, quantity, state, request) {
    const custody = { id: randomUUID(), equipmentId: equipment.id, assetId, quantity, state, studentId: request.requestType === "CASUAL" ? request.requesterId : null, teamId: request.teamId, sourceRequestId: request.id, createdAt: now(), updatedAt: now() };
    this.equipmentCustody.set(custody.id, custody);
    return custody;
  }

  recordMemoryEquipmentAudit(equipmentId, assetId, quantity, fromState, toState, actor, request, note = null) {
    this.equipmentStateAudit.push({ id: randomUUID(), equipmentId, assetId, quantity, fromState, toState, actorId: actor.id, actorName: actor.name, requestId: request.id, personId: request.requesterId, personName: request.requesterName, teamId: request.teamId, teamName: request.teamName, note: note || null, createdAt: now() });
  }

  async listEquipmentAudit(filters = {}) {
    return clone(this.equipmentStateAudit.filter((entry) => (!filters.equipmentId || entry.equipmentId === filters.equipmentId) && (!filters.personId || entry.personId === filters.personId) && (!filters.from || entry.createdAt >= filters.from) && (!filters.to || entry.createdAt < filters.to)).map((entry) => ({ ...entry, equipmentName: this.equipment.get(entry.equipmentId)?.name || "Equipment" })).reverse());
  }

  async listEquipmentCatalog() {
    return clone({ sports: this.sports, locations: this.campusLocations });
  }

  async createCatalogEntry(kind, data) {
    if (kind !== "location") throw badRequest("Unknown catalog type");
    const collection = this.campusLocations;
    if (collection.some((item) => item.name.toLowerCase() === data.name.toLowerCase())) throw conflict("That catalog entry already exists");
    const record = { id: randomUUID(), name: data.name, active: data.active ?? true, createdAt: now(), updatedAt: now() };
    collection.push(record);
    return clone(record);
  }

  async updateCatalogEntry(kind, id, data) {
    if (kind !== "location") throw badRequest("Unknown catalog type");
    const collection = this.campusLocations;
    const index = collection.findIndex((item) => item.id === id);
    if (index < 0) throw notFound("Catalog entry");
    collection[index] = { ...collection[index], ...clone(data), updatedAt: now() };
    return clone(collection[index]);
  }

  async createEquipmentAssets(equipmentId, assets) {
    await this.getResource("equipment", equipmentId);
    const created = assets.map((asset) => ({ id: randomUUID(), equipmentId, state: "IN_INVENTORY", condition: asset.condition || "good", ...clone(asset) }));
    for (const asset of created) this.equipmentAssets.set(asset.id, asset);
    return clone(created);
  }

  equipmentBreakdown(item) {
    const sportName = this.sports.find((sport) => sport.id === item.sportId)?.name || "General";
    if (item.tracking === "ASSET") {
      const assets = [...this.equipmentAssets.values()].filter((asset) => asset.equipmentId === item.id);
      const count = (state) => assets.filter((asset) => asset.state === state).length;
      return { ...clone(item), sportName, totalOwned: item.quantity, assets: clone(assets), holders: [], inInventoryQuantity: count("IN_INVENTORY"), casualPoolQuantity: count("CASUAL_POOL"), withTeamsQuantity: count("HELD_BY_TEAM"), withStudentsQuantity: count("ISSUED_TO_STUDENT"), damagedQuantity: count("DAMAGED"), missingQuantity: count("MISSING") };
    }
    const q = item.stateQuantities || {};
    const students = Number(q.ISSUED_TO_STUDENT || 0), teams = Number(q.HELD_BY_TEAM || 0), damaged = Number(q.DAMAGED || 0), missing = Number(q.MISSING || 0);
    const allocated = Number(item.casualAllocatedQuantity || 0);
    return { ...clone(item), sportName, totalOwned: item.quantity, assets: [], holders: clone(item.holders || []), inInventoryQuantity: Math.max(0, Number(item.quantity)-allocated-teams-damaged-missing), casualPoolQuantity: Math.max(0,allocated-students), withTeamsQuantity: teams, withStudentsQuantity: students, damagedQuantity: damaged, missingQuantity: missing };
  }

  async listEquipmentInventory(filters = {}) {
    let items = [...this.equipment.values()].map((item) => this.equipmentBreakdown(item)).filter((item) =>
      (!filters.sportId || item.sportId === filters.sportId) && (!filters.tracking || item.tracking === filters.tracking) &&
      (!filters.q || item.name.toLowerCase().includes(String(filters.q).toLowerCase()))
    );
    const field = { IN_INVENTORY: "inInventoryQuantity", CASUAL_POOL: "casualPoolQuantity", HELD_BY_TEAM: "withTeamsQuantity", ISSUED_TO_STUDENT: "withStudentsQuantity", DAMAGED: "damagedQuantity", MISSING: "missingQuantity" }[filters.state];
    if (field) items = items.filter((item) => Number(item[field]) > 0);
    const summary = items.reduce((sum,item) => ({ totalOwned: sum.totalOwned+Number(item.totalOwned), inInventory: sum.inInventory+item.inInventoryQuantity, casualPool: sum.casualPool+item.casualPoolQuantity, withTeams: sum.withTeams+item.withTeamsQuantity, withStudents: sum.withStudents+item.withStudentsQuantity, damagedOrMissing: sum.damagedOrMissing+item.damagedQuantity+item.missingQuantity }), { totalOwned:0,inInventory:0,casualPool:0,withTeams:0,withStudents:0,damagedOrMissing:0 });
    return clone({ summary, sports: this.sports, items });
  }

  async transferEquipmentState(equipmentId, data, actor) {
    const item = this.equipment.get(equipmentId);
    if (!item) throw notFound("Equipment item");
    const allocationOnly = [data.fromState,data.toState].every((state) => ["IN_INVENTORY","CASUAL_POOL"].includes(state));
    if (!allocationOnly && !data.reason) throw badRequest("Manual custody corrections require a reason");
    const before = this.equipmentBreakdown(item);
    const field = { IN_INVENTORY:"inInventoryQuantity",CASUAL_POOL:"casualPoolQuantity",HELD_BY_TEAM:"withTeamsQuantity",ISSUED_TO_STUDENT:"withStudentsQuantity",DAMAGED:"damagedQuantity",MISSING:"missingQuantity" }[data.fromState];
    if (Number(before[field]) < data.quantity) throw conflict(`Only ${before[field]} units are available in ${data.fromState}`);
    if (item.tracking === "ASSET") {
      if (data.assetIds.length !== data.quantity) throw badRequest("Select exactly one tracked unit for each unit transferred");
      const assets = data.assetIds.map((id) => this.equipmentAssets.get(id));
      if (assets.some((asset) => !asset || asset.equipmentId !== equipmentId || asset.state !== data.fromState)) throw conflict("One or more selected units are not in the source state");
      assets.forEach((asset) => { asset.state = data.toState; asset.note = data.reason || null; });
    } else {
      const casualStates = ["CASUAL_POOL","ISSUED_TO_STUDENT"];
      item.casualAllocatedQuantity += (casualStates.includes(data.toState) ? data.quantity : 0) - (casualStates.includes(data.fromState) ? data.quantity : 0);
      item.stateQuantities ||= {};
      for (const state of [data.fromState,data.toState]) if (!["IN_INVENTORY","CASUAL_POOL"].includes(state)) item.stateQuantities[state] = Number(item.stateQuantities[state] || 0) + (state === data.toState ? data.quantity : -data.quantity);
    }
    item.updatedAt = now();
    await this.appendAudit(actor, allocationOnly ? "equipment.allocation.transferred" : "equipment.custody.manual_override", "equipment", equipmentId, before, { ...this.equipmentBreakdown(item), reason: data.reason || "Inventory allocation" });
    return clone({ equipmentId, ...data, manualOverride: !allocationOnly });
  }

  async resolveEquipmentException() { throw notFound("Damaged or missing custody record"); }

  async listBlackouts(resourceType, resourceId) {
    return clone([...this.blackouts.values()].filter((item) =>
      (!resourceType || item.resourceType === resourceType) &&
      (!resourceId || item.resourceId === resourceId),
    ));
  }

  async createBlackout(data, actor) {
    const record = { id: randomUUID(), ...clone(data), createdAt: now() };
    this.blackouts.set(record.id, record);
    await this.appendAudit(actor, "blackout.created", "blackout", record.id, null, record);
    return clone(record);
  }

  async hasConflict(args) {
    return this.conflictFor(args);
  }

  // Deliberately synchronous. Callers that commit (createBooking, createHold) run
  // this and their write in one uninterrupted block, so two simultaneous requests
  // cannot both pass the check before either writes. Postgres gets the same
  // guarantee from the `no_overlapping_venue_booking` exclusion constraint.
  //
  // `ignoreHoldsBy` lets a requester's own hold pass through: a hold must block
  // everyone else and never the person who took it.
  conflictFor({ resourceType, resourceId, startAt, endAt, excludeBookingId, quantity = 1, ignoreHoldsBy, excludeHoldId, requesterId }) {
    const overlap = (item) => item.startAt < endAt && item.endAt > startAt;
    const overlappingBookings = [...this.bookings.values()].filter((item) =>
      item.id !== excludeBookingId &&
      item.resourceType === resourceType &&
      item.resourceId === resourceId &&
      !["cancelled", "rejected"].includes(item.status) &&
      overlap(item),
    );
    const overlappingHolds = [...this.holds.values()].filter((item) =>
      item.id !== excludeHoldId &&
      item.resourceType === resourceType &&
      item.resourceId === resourceId &&
      item.heldBy !== ignoreHoldsBy &&
      isHoldActive(item) &&
      overlap(item),
    );
    const blackout = [...this.blackouts.values()].find((item) =>
      item.resourceType === resourceType &&
      (item.resourceId === null || item.resourceId === resourceId) &&
      overlap(item),
    );
    if (blackout) return { ...clone(blackout), conflictType: "blackout" };
    if (resourceType === "venue") {
      const requesterBooking = requesterId && [...this.bookings.values()].find((item) =>
        item.id !== excludeBookingId &&
        item.resourceType === "venue" &&
        item.requesterId === requesterId &&
        !["cancelled", "rejected"].includes(item.status) &&
        overlap(item),
      );
      if (requesterBooking) return { ...clone(requesterBooking), conflictType: "requester_booking" };
      if (overlappingBookings[0]) return { ...clone(overlappingBookings[0]), conflictType: "booking" };
      if (overlappingHolds[0]) {
        return { conflictType: "hold", startAt: overlappingHolds[0].startAt, endAt: overlappingHolds[0].endAt, expiresAt: overlappingHolds[0].expiresAt };
      }
      return null;
    }
    const item = this.equipment.get(resourceId);
    if (!item) throw notFound("Equipment item");
    const sumQuantity = (total, entry) => total + Number(entry.quantity || 1);
    const used = overlappingBookings.reduce(sumQuantity, 0) + overlappingHolds.reduce(sumQuantity, 0);
    if (used + Number(quantity) > Number(item.quantity)) {
      return { conflictType: "insufficient_stock", available: Math.max(0, Number(item.quantity) - used) };
    }
    return null;
  }

  // --- EPIC-03 / US-04B: temporary slot holds ---------------------------------

  async createHold(data, actor) {
    const existing = this.conflictFor({ ...data, requesterId: actor.id, ignoreHoldsBy: actor.id });
    if (existing) throw conflict("That slot is no longer available to hold", { conflict: existing });
    const record = {
      id: randomUUID(),
      resourceType: data.resourceType,
      resourceId: data.resourceId,
      startAt: data.startAt,
      endAt: data.endAt,
      quantity: Number(data.quantity || 1),
      heldBy: actor.id,
      expiresAt: holdExpiryFrom(),
      releasedAt: null,
      bookingId: null,
      createdAt: now(),
    };
    this.holds.set(record.id, record);
    return clone(record);
  }

  async getHold(id) {
    const hold = this.holds.get(id);
    if (!hold) throw notFound("Hold");
    return clone(hold);
  }

  async releaseHold(id, actor) {
    const hold = this.holds.get(id);
    if (!hold) throw notFound("Hold");
    if (hold.heldBy !== actor.id && actor.role !== "admin") {
      throw forbidden("Only the person holding this slot can release it");
    }
    hold.releasedAt = hold.releasedAt || now();
    return clone(hold);
  }

  async listActiveHolds({ resourceType, resourceId, from, to } = {}) {
    return clone([...this.holds.values()].filter((item) =>
      isHoldActive(item) &&
      (!resourceType || item.resourceType === resourceType) &&
      (!resourceId || item.resourceId === resourceId) &&
      (!from || item.endAt > from) &&
      (!to || item.startAt < to),
    ).sort((a, b) => a.startAt.localeCompare(b.startAt)));
  }

  async listHoldsForUser(userId) {
    return clone([...this.holds.values()]
      .filter((item) => item.heldBy === userId && isHoldActive(item))
      .sort((a, b) => a.startAt.localeCompare(b.startAt)));
  }

  async consumeHold(holdId, bookingId) {
    const hold = this.holds.get(holdId);
    if (!hold) throw notFound("Hold");
    hold.bookingId = bookingId;
    hold.releasedAt = now();
    return clone(hold);
  }

  async listBookings(filters = {}) {
    let values = [...this.bookings.values()];
    for (const key of ["requesterId", "resourceType", "resourceId", "status"]) {
      if (filters[key]) values = values.filter((item) => item[key] === filters[key]);
    }
    if (filters.from) values = values.filter((item) => item.endAt > filters.from);
    if (filters.to) values = values.filter((item) => item.startAt < filters.to);
    return clone(values.sort((a, b) => a.startAt.localeCompare(b.startAt)));
  }

  async getBooking(id) {
    const booking = this.bookings.get(id);
    if (!booking) throw notFound("Booking");
    return clone(booking);
  }

  async createBooking(data, actor) {
    // Venue reservations confirm immediately when the slot is free. Legacy
    // non-venue bookings may still use a configured approval flow.
    const steps = data.resourceType === "venue" ? [] : await this.resolveApprovalSteps(data.resourceType, data.resourceId);
    const existing = this.conflictFor({ ...data, requesterId: actor.id, ignoreHoldsBy: actor.id });
    if (existing) throw conflict(existing.conflictType === "requester_booking" ? "You already have another venue booked during this time" : "The resource is unavailable for that time", { conflict: existing });
    const record = {
      id: randomUUID(),
      ...clone(data),
      requesterId: actor.id,
      status: steps.length ? "pending" : "approved",
      currentApprovalOrder: steps.length ? 1 : null,
      createdAt: now(),
      updatedAt: now(),
    };
    this.bookings.set(record.id, record);
    this.decisions.set(record.id, []);
    await this.appendAudit(actor, "booking.created", "booking", record.id, null, record);
    return clone(record);
  }

  async updateBooking(id, data, actor) {
    const before = await this.getBooking(id);
    const candidate = { ...before, ...clone(data), id, updatedAt: now() };
    const existing = this.conflictFor({ ...candidate, excludeBookingId: id, ignoreHoldsBy: actor.id });
    if (existing) throw conflict("The resource is unavailable for that time", { conflict: existing });
    this.bookings.set(id, candidate);
    await this.appendAudit(actor, "booking.updated", "booking", id, before, candidate);
    return clone(candidate);
  }

  async setBookingStatus(id, status, actor, extra = {}) {
    const before = await this.getBooking(id);
    const after = { ...before, ...extra, status, updatedAt: now() };
    this.bookings.set(id, after);
    await this.appendAudit(actor, `booking.${status}`, "booking", id, before, after);
    return clone(after);
  }

  async listApprovalFlows() {
    return clone([...this.approvalFlows.values()]);
  }

  async createApprovalFlow(data, actor) {
    const record = {
      id: randomUUID(),
      name: data.name,
      resourceType: data.resourceType,
      resourceId: data.resourceId ?? null,
      active: data.active ?? true,
      steps: data.steps.map((step, index) => ({
        id: randomUUID(),
        order: index + 1,
        role: step.role || "approver",
        approverId: step.approverId || null,
        label: step.label || `Approval ${index + 1}`,
      })),
      createdAt: now(),
      updatedAt: now(),
    };
    this.approvalFlows.set(record.id, record);
    await this.appendAudit(actor, "approval_flow.created", "approval_flow", record.id, null, record);
    return clone(record);
  }

  async resolveApprovalSteps(resourceType, resourceId) {
    const candidates = [...this.approvalFlows.values()].filter((flow) =>
      flow.active && flow.resourceType === resourceType &&
      (flow.resourceId === resourceId || flow.resourceId === null),
    );
    const flow = candidates.find((item) => item.resourceId === resourceId) || candidates[0];
    return clone(flow?.steps || []);
  }

  async getApprovalContext(bookingId) {
    const booking = await this.getBooking(bookingId);
    const steps = await this.resolveApprovalSteps(booking.resourceType, booking.resourceId);
    return { booking, steps, decisions: clone(this.decisions.get(bookingId) || []) };
  }

  async listPendingApprovals(user) {
    const pending = [];
    for (const booking of this.bookings.values()) {
      if (booking.status !== "pending") continue;
      const steps = await this.resolveApprovalSteps(booking.resourceType, booking.resourceId);
      const step = steps.find((item) => item.order === booking.currentApprovalOrder);
      if (step && (user.role === "admin" || step.approverId === user.id || (!step.approverId && step.role === user.role))) {
        pending.push({ ...clone(booking), currentStep: clone(step) });
      }
    }
    return pending;
  }

  async addDecision(bookingId, step, decision, comment, actor) {
    const decisions = this.decisions.get(bookingId) || [];
    if (decisions.some((item) => item.stepId === step.id)) {
      throw conflict("This approval step has already been decided");
    }
    const record = {
      id: randomUUID(), bookingId, stepId: step.id, stepOrder: step.order,
      approverId: actor.id, decision, comment: comment || null, decidedAt: now(),
    };
    decisions.push(record);
    this.decisions.set(bookingId, decisions);
    await this.appendAudit(actor, `approval.${decision}`, "booking", bookingId, null, record);
    return clone(record);
  }

  async listContent(type, filters = {}) {
    const map = this[type];
    let values = [...map.values()];
    if (filters.tournamentId) values = values.filter((item) => item.tournamentId === filters.tournamentId);
    return clone(values);
  }

  async getContent(type, id) {
    const record = this[type].get(id);
    if (!record) throw notFound("Content");
    return clone(record);
  }

  async createContent(type, data, actor) {
    const record = { id: randomUUID(), ...clone(data), createdAt: now(), updatedAt: now() };
    this[type].set(record.id, record);
    await this.appendAudit(actor, `${type}.created`, type, record.id, null, record);
    return clone(record);
  }

  async updateContent(type, id, data, actor) {
    const before = await this.getContent(type, id);
    const after = { ...before, ...clone(data), id, updatedAt: now() };
    this[type].set(id, after);
    await this.appendAudit(actor, `${type}.updated`, type, id, before, after);
    return clone(after);
  }

  async deleteContent(type, id, actor) {
    const before = await this.getContent(type, id);
    this[type].delete(id);
    await this.appendAudit(actor, `${type}.deleted`, type, id, before, null);
  }

  async utilization(from, to) {
    const bookings = await this.listBookings({ from, to });
    const approved = bookings.filter((item) => ["approved", "completed"].includes(item.status));
    const byResource = {};
    for (const item of approved) {
      const hours = (new Date(item.endAt) - new Date(item.startAt)) / 3_600_000;
      byResource[item.resourceId] = (byResource[item.resourceId] || 0) + hours;
    }
    return { from, to, bookingCount: bookings.length, approvedCount: approved.length, bookedHoursByResource: byResource };
  }

  async appendAudit(actor, action, entityType, entityId, before, after) {
    this.audit.push({
      id: randomUUID(), actorId: actor?.id || null, action, entityType, entityId,
      before: clone(before), after: clone(after), createdAt: now(),
    });
  }

  async listAudit(limit = 100) {
    return clone(this.audit.slice(-limit).reverse());
  }

  async enqueueNotification(data) {
    const record = { id: randomUUID(), status: "pending", attempts: 0, ...clone(data), createdAt: now() };
    this.notifications.set(record.id, record);
    return clone(record);
  }

  async listDueNotifications() {
    return clone([...this.notifications.values()].filter((item) =>
      (item.status === "pending" || (item.status === "failed" && item.attempts < 3)) &&
      (!item.sendAfter || item.sendAfter <= now()),
    ));
  }

  async markNotification(id, status, error = null) {
    const record = this.notifications.get(id);
    if (!record) throw notFound("Notification");
    Object.assign(record, { status, error, attempts: record.attempts + 1, updatedAt: now() });
    return clone(record);
  }
}
