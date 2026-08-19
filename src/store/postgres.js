import pg from "pg";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../errors.js";
import { postgresConnectionConfig } from "../database-config.js";
import { BOOTSTRAP_ADMIN_EMAIL, DEFAULT_EMAIL_PATTERN, normalizeEmail } from "../password-auth.js";
import { HOLD_TTL_MINUTES } from "../holds.js";

const { Pool } = pg;

const camel = (row) => {
  if (!row) return row;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())] = value instanceof Date
      ? value.toISOString()
      : value;
  }
  return out;
};
const rows = (result) => result.map(camel);
const snake = (value) => value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

const CONTENT = {
  committee: {
    table: "committee_members",
    columns: ["name", "title", "email", "phone", "responsibilities", "display_order"],
  },
  gallery: {
    table: "gallery_items",
    columns: ["title", "event_name", "occurred_on", "media_url", "thumbnail_url", "caption"],
  },
  tournaments: {
    table: "tournaments",
    columns: ["name", "description", "starts_on", "ends_on", "status"],
  },
  matches: {
    table: "matches",
    columns: ["tournament_id", "sport", "home_team", "away_team", "venue_id", "starts_at", "status", "home_score", "away_score", "notes"],
  },
};

export class PostgresStore {
  constructor(databaseUrl) {
    // `pg` works with standard PostgreSQL URLs, including Supabase's Supavisor
    // transaction pooler URL that is appropriate for Vercel serverless functions.
    this.pool = new Pool({
      ...postgresConnectionConfig(databaseUrl),
      max: 1,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
    this.sql = {
      query: async (text, values = []) => (await this.pool.query(text, values)).rows,
    };
  }

  async close() {
    await this.pool.end();
  }

  async ensureUser(user) {
    const email = normalizeEmail(user.email);
    // Authentication input is identity data, not authorization. In particular,
    // never let a stale/demo header create a second administrator account.
    const requestedRole = user.role || "requester";
    const role = email === BOOTSTRAP_ADMIN_EMAIL
      ? "admin"
      : requestedRole === "admin" ? "requester" : requestedRole;
    const result = await this.sql.query(
      `INSERT INTO app_users (id,email,name,role) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email,name=EXCLUDED.name,
       role=CASE
         WHEN lower(EXCLUDED.email)=$5 THEN 'admin'
         WHEN app_users.role='admin' THEN 'requester'
         ELSE app_users.role
       END,updated_at=now()
       RETURNING *`,
      [user.id, email, user.name, role, BOOTSTRAP_ADMIN_EMAIL],
    );
    return camel(result[0]);
  }

  async listUsers() {
    return rows(await this.sql.query("SELECT * FROM app_users ORDER BY name"));
  }

  async getUser(id) {
    const result = await this.sql.query("SELECT * FROM app_users WHERE id=$1", [id]);
    if (!result[0]) throw notFound("User");
    return camel(result[0]);
  }

  async getUserByEmail(email) {
    const result = await this.sql.query("SELECT * FROM app_users WHERE lower(email)=lower($1) LIMIT 1", [normalizeEmail(email)]);
    return result[0] ? camel(result[0]) : null;
  }

  async clearMustChangePassword(id) {
    const result = await this.sql.query("UPDATE app_users SET must_change_password=false,updated_at=now() WHERE id=$1 RETURNING *", [id]);
    if (!result[0]) throw notFound("User");
    return camel(result[0]);
  }

  async markInventoryKiosk(email) {
    const result = await this.sql.query("UPDATE app_users SET role='inventory_kiosk',updated_at=now() WHERE lower(email)=lower($1) RETURNING *", [email]);
    if (!result[0]) throw notFound("Inventory kiosk profile");
    return camel(result[0]);
  }

  async getRoleAssignment(email) {
    const result = await this.sql.query("SELECT email,role,updated_at,updated_by FROM role_assignments WHERE email=lower($1)", [normalizeEmail(email)]);
    return result[0] ? camel(result[0]) : null;
  }

  async listRoleAssignments() {
    return rows(await this.sql.query("SELECT email,role,updated_at,updated_by FROM role_assignments ORDER BY email"));
  }

  async setRoleAssignment(email, role, actor) {
    const normalized = normalizeEmail(email);
    if (normalized === BOOTSTRAP_ADMIN_EMAIL) throw forbidden("The bootstrap administrator role is fixed");
    if (role === "requester") return this.deleteRoleAssignment(normalized, actor);
    const result = await this.sql.query(
      `INSERT INTO role_assignments(email,role,updated_by) VALUES($1,$2,$3)
       ON CONFLICT(email) DO UPDATE SET role=EXCLUDED.role,updated_by=EXCLUDED.updated_by,updated_at=now()
       RETURNING email,role,updated_at,updated_by`, [normalized, role, actor.id],
    );
    await this.sql.query("UPDATE app_users SET role=$2,updated_at=now() WHERE lower(email)=$1", [normalized, role]);
    await this.appendAudit(actor, "auth.role_assignment.updated", "role_assignment", normalized, null, { email: normalized, role });
    return camel(result[0]);
  }

  async deleteRoleAssignment(email, actor) {
    const normalized = normalizeEmail(email);
    if (normalized === BOOTSTRAP_ADMIN_EMAIL) throw forbidden("The bootstrap administrator role is fixed");
    await this.sql.query("DELETE FROM role_assignments WHERE email=$1", [normalized]);
    await this.sql.query("UPDATE app_users SET role='requester',updated_at=now() WHERE lower(email)=$1", [normalized]);
    await this.appendAudit(actor, "auth.role_assignment.removed", "role_assignment", normalized, null, { email: normalized, role: "requester" });
    return null;
  }

  async setPasswordHash(userId, passwordHash) {
    await this.sql.query(
      `INSERT INTO user_passwords(user_id,password_hash) VALUES($1,$2)
       ON CONFLICT(user_id) DO UPDATE SET password_hash=EXCLUDED.password_hash,updated_at=now()`,
      [userId, passwordHash],
    );
  }

  async getPasswordHash(userId) {
    const result = await this.sql.query("SELECT password_hash FROM user_passwords WHERE user_id=$1", [userId]);
    return result[0]?.password_hash || null;
  }

  async createAuthSession(session) {
    await this.sql.query(
      "INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4)",
      [session.id, session.userId, session.tokenHash, session.expiresAt],
    );
  }

  async getAuthSession(tokenHash) {
    const result = await this.sql.query(
      "SELECT id,user_id,token_hash,expires_at,created_at FROM auth_sessions WHERE token_hash=$1 AND expires_at>now()",
      [tokenHash],
    );
    return result[0] ? camel(result[0]) : null;
  }

  async deleteAuthSession(tokenHash) {
    await this.sql.query("DELETE FROM auth_sessions WHERE token_hash=$1", [tokenHash]);
  }

  async getAuthSettings() {
    const result = await this.sql.query("SELECT email_pattern,updated_at,updated_by FROM auth_settings WHERE id=true");
    return result[0] ? camel(result[0]) : { emailPattern: DEFAULT_EMAIL_PATTERN, updatedAt: null, updatedBy: null };
  }

  async setEmailPattern(emailPattern, actor) {
    const result = await this.sql.query(
      `INSERT INTO auth_settings(id,email_pattern,updated_by) VALUES(true,$1,$2)
       ON CONFLICT(id) DO UPDATE SET email_pattern=EXCLUDED.email_pattern,updated_by=EXCLUDED.updated_by,updated_at=now()
       RETURNING email_pattern,updated_at,updated_by`,
      [emailPattern, actor.id],
    );
    await this.appendAudit(actor, "auth.email_rule.updated", "auth_settings", "global", null, { emailPattern });
    return camel(result[0]);
  }

  async setUserRole(id, role) {
    const user = await this.getUser(id);
    if (user.email === BOOTSTRAP_ADMIN_EMAIL) throw forbidden("The bootstrap administrator role cannot be changed");
    if (role === "admin") throw forbidden("Only sportscomm@iiml.ac.in can be an administrator");
    const result = await this.sql.query(
      "UPDATE app_users SET role=$2,updated_at=now() WHERE id=$1 RETURNING *", [id, role],
    );
    if (!result[0]) throw notFound("User");
    return camel(result[0]);
  }

  resourceMeta(type) {
    return type === "venue"
      ? { table: "venues", json: ["amenities", "rules"], fields: ["name", "sportId", "category", "location", "locationId", "photoPath", "capacity", "amenities", "rules", "active"] }
      : { table: "equipment_items", json: ["metadata"], fields: ["name", "sportId", "photoPath", "quantity", "metadata", "tracking", "active"] };
  }

  async listResources(type, filters = {}) {
    const { table } = this.resourceMeta(type);
    const clauses = [];
    const values = [];
    const add = (sql, value) => { values.push(value); clauses.push(sql.replace("?", `$${values.length}`)); };
    if (filters.active !== undefined) add("active=?", filters.active);
    if (filters.category && type === "venue") add("category=?", filters.category);
    if (filters.minCapacity) add(type === "venue" ? "capacity>=?" : "quantity>=?", filters.minCapacity);
    if (filters.q) {
      values.push(filters.q);
      clauses.push(type === "venue"
        ? `(name ILIKE '%' || $${values.length} || '%' OR COALESCE(location,'') ILIKE '%' || $${values.length} || '%')`
        : `name ILIKE '%' || $${values.length} || '%'`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    if (type === "equipment") {
      return rows(await this.sql.query(
         `SELECT equipment_items.*,(SELECT name FROM sports s WHERE s.id=equipment_items.sport_id) AS sport_name,
          CASE WHEN tracking='ASSET' THEN (SELECT count(*) FROM equipment_assets a WHERE a.equipment_id=equipment_items.id AND a.state='IN_INVENTORY')
            ELSE GREATEST(0,quantity-COALESCE((SELECT casual_allocated_quantity FROM equipment_allocations x WHERE x.equipment_id=equipment_items.id),0)
              -COALESCE((SELECT sum(quantity) FROM equipment_custody c WHERE c.equipment_id=equipment_items.id AND c.state IN ('HELD_BY_TEAM','DAMAGED','MISSING')),0)) END::int AS in_inventory_quantity,
          CASE WHEN tracking='ASSET' THEN (SELECT count(*) FROM equipment_assets a WHERE a.equipment_id=equipment_items.id AND a.state='CASUAL_POOL')
            ELSE GREATEST(0,COALESCE((SELECT casual_allocated_quantity FROM equipment_allocations x WHERE x.equipment_id=equipment_items.id),0)
              -COALESCE((SELECT sum(quantity) FROM equipment_custody c WHERE c.equipment_id=equipment_items.id AND c.state='ISSUED_TO_STUDENT'),0)) END::int AS casual_pool_quantity,
          COALESCE((SELECT sum(quantity) FROM equipment_custody c WHERE c.equipment_id=equipment_items.id AND c.state='ISSUED_TO_STUDENT'),0)::int AS with_students_quantity,
          COALESCE((SELECT sum(quantity) FROM equipment_custody c WHERE c.equipment_id=equipment_items.id AND c.state='HELD_BY_TEAM'),0)::int AS with_teams_quantity,
          COALESCE((SELECT sum(quantity) FROM equipment_custody c WHERE c.equipment_id=equipment_items.id AND c.state='DAMAGED'),0)::int AS damaged_quantity,
          COALESCE((SELECT sum(quantity) FROM equipment_custody c WHERE c.equipment_id=equipment_items.id AND c.state='MISSING'),0)::int AS missing_quantity
         FROM equipment_items ${where} ORDER BY name`, values,
      ));
    }
    return rows(await this.sql.query(
      `SELECT ${table}.*,
       COALESCE((SELECT name FROM campus_locations cl WHERE cl.id=${table}.location_id),${table}.location) AS location,
       (SELECT name FROM sports s WHERE s.id=${table}.sport_id) AS sport_name
       FROM ${table} ${where} ORDER BY name`, values,
    ));
  }

  async getResource(type, id) {
    const { table } = this.resourceMeta(type);
    const result = await this.sql.query(`SELECT * FROM ${table} WHERE id=$1`, [id]);
    if (!result[0]) throw notFound(type === "venue" ? "Venue" : "Equipment item");
    return camel(result[0]);
  }

  async createResource(type, data, actor) {
    const meta = this.resourceMeta(type);
    const fields = meta.fields.filter((field) => data[field] !== undefined);
    const values = fields.map((field) => meta.json.includes(field) ? JSON.stringify(data[field]) : data[field]);
    const placeholders = fields.map((_, index) => `$${index + 1}`).join(",");
    const result = await this.sql.query(
      `INSERT INTO ${meta.table} (${fields.map(snake).join(",")}) VALUES (${placeholders}) RETURNING *`, values,
    );
    const record = camel(result[0]);
    await this.appendAudit(actor, `${type}.created`, type, record.id, null, record);
    return record;
  }

  async updateResource(type, id, data, actor) {
    const meta = this.resourceMeta(type);
    const before = await this.getResource(type, id);
    const fields = meta.fields.filter((field) => data[field] !== undefined);
    if (!fields.length) return before;
    const values = fields.map((field) => meta.json.includes(field) ? JSON.stringify(data[field]) : data[field]);
    values.push(id);
    const set = fields.map((field, index) => `${snake(field)}=$${index + 1}`).join(",");
    const result = await this.sql.query(
      `UPDATE ${meta.table} SET ${set},updated_at=now() WHERE id=$${values.length} RETURNING *`, values,
    );
    const after = camel(result[0]);
    await this.appendAudit(actor, `${type}.updated`, type, id, before, after);
    return after;
  }

  async deleteResource(type, id, actor) {
    return this.updateResource(type, id, { active: false }, actor);
  }

  async listBlackouts(resourceType, resourceId) {
    const result = await this.sql.query(
      `SELECT * FROM blackouts WHERE ($1::text IS NULL OR resource_type=$1)
       AND ($2::uuid IS NULL OR resource_id=$2) ORDER BY start_at`, [resourceType || null, resourceId || null],
    );
    return rows(result);
  }

  async createBlackout(data, actor) {
    const result = await this.sql.query(
      `INSERT INTO blackouts(resource_type,resource_id,start_at,end_at,reason,created_by)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [data.resourceType, data.resourceId || null, data.startAt, data.endAt, data.reason, actor.id],
    );
    const record = camel(result[0]);
    await this.appendAudit(actor, "blackout.created", "blackout", record.id, null, record);
    return record;
  }

  // `ignoreHoldsBy` lets a requester's own hold pass through: a hold must block
  // everyone else and never the person who took it.
  async hasConflict({ resourceType, resourceId, startAt, endAt, excludeBookingId, quantity = 1, ignoreHoldsBy, excludeHoldId, requesterId }) {
    const result = await this.sql.query(
      `SELECT 'booking' AS conflict_type,id,start_at,end_at,status,NULL::timestamptz AS expires_at
       FROM bookings WHERE $1='venue' AND resource_type=$1 AND resource_id=$2
       AND id <> COALESCE($5::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
       AND status NOT IN ('cancelled','rejected') AND start_at < $4 AND end_at > $3
       UNION ALL
       SELECT 'requester_booking' AS conflict_type,id,start_at,end_at,status,NULL::timestamptz AS expires_at
       FROM bookings WHERE $1='venue' AND resource_type='venue' AND requester_id=$8
       AND id <> COALESCE($5::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
       AND status NOT IN ('cancelled','rejected') AND start_at < $4 AND end_at > $3
       UNION ALL
       SELECT 'blackout' AS conflict_type,id,start_at,end_at,'blocked' AS status,NULL::timestamptz AS expires_at
       FROM blackouts WHERE resource_type=$1 AND (resource_id IS NULL OR resource_id=$2)
       AND start_at < $4 AND end_at > $3
       UNION ALL
       SELECT 'hold' AS conflict_type,id,start_at,end_at,'held' AS status,expires_at
       FROM slot_holds WHERE $1='venue' AND resource_type=$1 AND resource_id=$2
       AND id <> COALESCE($7::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
       AND held_by IS DISTINCT FROM $6 AND released_at IS NULL AND expires_at > now()
       AND start_at < $4 AND end_at > $3
       LIMIT 1`,
      [resourceType, resourceId, startAt, endAt, excludeBookingId || null, ignoreHoldsBy || null, excludeHoldId || null, requesterId || null],
    );
    if (result[0]) return camel(result[0]);
    if (resourceType === "equipment") {
      const stock = await this.sql.query("SELECT quantity FROM equipment_items WHERE id=$1 AND active", [resourceId]);
      if (!stock[0]) throw notFound("Equipment item");
      // Live holds reserve stock exactly like bookings do, otherwise two people
      // could each hold the last racquet and both reach the confirm step.
      const used = await this.sql.query(
        `SELECT (
           COALESCE((SELECT sum(quantity) FROM bookings
             WHERE resource_type='equipment' AND resource_id=$1
             AND id <> COALESCE($4::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
             AND status NOT IN ('cancelled','rejected') AND start_at < $3 AND end_at > $2),0)
           + COALESCE((SELECT sum(quantity) FROM slot_holds
             WHERE resource_type='equipment' AND resource_id=$1
             AND id <> COALESCE($6::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
             AND held_by IS DISTINCT FROM $5 AND released_at IS NULL AND expires_at > now()
             AND start_at < $3 AND end_at > $2),0)
         )::int AS used`,
        [resourceId, startAt, endAt, excludeBookingId || null, ignoreHoldsBy || null, excludeHoldId || null],
      );
      if (Number(used[0].used) + Number(quantity) > Number(stock[0].quantity)) {
        return { conflictType: "insufficient_stock", available: Number(stock[0].quantity) - Number(used[0].used) };
      }
    }
    return null;
  }

  // --- EPIC-03 / US-04B: temporary slot holds ---------------------------------

  async createHold(data, actor) {
    const existing = await this.hasConflict({ ...data, requesterId: actor.id, ignoreHoldsBy: actor.id });
    if (existing) throw conflict("That slot is no longer available to hold", { conflict: existing });
    const result = await this.sql.query(
      `INSERT INTO slot_holds(resource_type,resource_id,held_by,quantity,start_at,end_at,expires_at)
       VALUES($1,$2,$3,$4,$5,$6, now() + ($7 || ' minutes')::interval) RETURNING *`,
      [data.resourceType, data.resourceId, actor.id, Number(data.quantity || 1),
        data.startAt, data.endAt, String(HOLD_TTL_MINUTES)],
    );
    return camel(result[0]);
  }

  async getHold(id) {
    const result = await this.sql.query("SELECT * FROM slot_holds WHERE id=$1", [id]);
    if (!result[0]) throw notFound("Hold");
    return camel(result[0]);
  }

  async releaseHold(id, actor) {
    const hold = await this.getHold(id);
    if (hold.heldBy !== actor.id && actor.role !== "admin") {
      throw forbidden("Only the person holding this slot can release it");
    }
    const result = await this.sql.query(
      "UPDATE slot_holds SET released_at=COALESCE(released_at,now()) WHERE id=$1 RETURNING *", [id],
    );
    return camel(result[0]);
  }

  async listActiveHolds({ resourceType, resourceId, from, to } = {}) {
    return rows(await this.sql.query(
      `SELECT * FROM slot_holds
       WHERE released_at IS NULL AND expires_at > now()
       AND ($1::text IS NULL OR resource_type=$1)
       AND ($2::uuid IS NULL OR resource_id=$2)
       AND ($3::timestamptz IS NULL OR end_at > $3)
       AND ($4::timestamptz IS NULL OR start_at < $4)
       ORDER BY start_at`,
      [resourceType || null, resourceId || null, from || null, to || null],
    ));
  }

  async listHoldsForUser(userId) {
    return rows(await this.sql.query(
      `SELECT * FROM slot_holds WHERE held_by=$1 AND released_at IS NULL AND expires_at > now()
       ORDER BY start_at`, [userId],
    ));
  }

  async consumeHold(holdId, bookingId) {
    const result = await this.sql.query(
      "UPDATE slot_holds SET booking_id=$2,released_at=now() WHERE id=$1 RETURNING *", [holdId, bookingId],
    );
    if (!result[0]) throw notFound("Hold");
    return camel(result[0]);
  }

  async listBookings(filters = {}) {
    const clauses = [];
    const values = [];
    for (const [key, column] of Object.entries({ requesterId: "requester_id", resourceType: "resource_type", resourceId: "resource_id", status: "status" })) {
      if (filters[key]) { values.push(filters[key]); clauses.push(`${column}=$${values.length}`); }
    }
    if (filters.from) { values.push(filters.from); clauses.push(`end_at>$${values.length}`); }
    if (filters.to) { values.push(filters.to); clauses.push(`start_at<$${values.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return rows(await this.sql.query(`SELECT * FROM bookings ${where} ORDER BY start_at`, values));
  }

  async getBooking(id) {
    const result = await this.sql.query("SELECT * FROM bookings WHERE id=$1", [id]);
    if (!result[0]) throw notFound("Booking");
    return camel(result[0]);
  }

  async createBooking(data, actor) {
    const existing = await this.hasConflict({ ...data, requesterId: actor.id, ignoreHoldsBy: actor.id });
    if (existing) throw conflict(existing.conflictType === "requester_booking" ? "You already have another venue booked during this time" : "The resource is unavailable for that time", { conflict: existing });
    const steps = data.resourceType === "venue" ? [] : await this.resolveApprovalSteps(data.resourceType, data.resourceId);
    try {
      const result = await this.sql.query(
        `INSERT INTO bookings(requester_id,resource_type,resource_id,title,purpose,quantity,start_at,end_at,status,current_approval_order,metadata)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING *`,
        [actor.id, data.resourceType, data.resourceId, data.title, data.purpose || null, data.quantity || 1,
          data.startAt, data.endAt, steps.length ? "pending" : "approved", steps.length ? 1 : null,
          JSON.stringify(data.metadata || {})],
      );
      const record = camel(result[0]);
      await this.appendAudit(actor, "booking.created", "booking", record.id, null, record);
      return record;
    } catch (error) {
      if (error.constraint === "no_overlapping_requester_venue_booking") {
        throw conflict("You already have another venue booked during this time");
      }
      if (error.constraint === "no_overlapping_venue_booking") {
        throw conflict("The venue is unavailable for that time");
      }
      throw error;
    }
  }

  async updateBooking(id, data, actor) {
    const before = await this.getBooking(id);
    const next = { ...before, ...data };
    const existing = await this.hasConflict({ ...next, excludeBookingId: id, ignoreHoldsBy: actor.id });
    if (existing) throw conflict("The resource is unavailable for that time", { conflict: existing });
    const result = await this.sql.query(
      `UPDATE bookings SET title=$2,purpose=$3,quantity=$4,start_at=$5,end_at=$6,metadata=$7::jsonb,updated_at=now()
       WHERE id=$1 RETURNING *`,
      [id, next.title, next.purpose || null, next.quantity || 1, next.startAt, next.endAt, JSON.stringify(next.metadata || {})],
    );
    const after = camel(result[0]);
    await this.appendAudit(actor, "booking.updated", "booking", id, before, after);
    return after;
  }

  async setBookingStatus(id, status, actor, extra = {}) {
    const before = await this.getBooking(id);
    const result = await this.sql.query(
      `UPDATE bookings SET status=$2,current_approval_order=$3,updated_at=now() WHERE id=$1 RETURNING *`,
      [id, status, extra.currentApprovalOrder ?? before.currentApprovalOrder],
    );
    const after = camel(result[0]);
    await this.appendAudit(actor, `booking.${status}`, "booking", id, before, after);
    return after;
  }

  async listApprovalFlows() {
    const flows = rows(await this.sql.query("SELECT * FROM approval_flows ORDER BY resource_type,name"));
    for (const flow of flows) flow.steps = await this.stepsForFlow(flow.id);
    return flows;
  }

  async stepsForFlow(flowId) {
    return rows(await this.sql.query(
      `SELECT id,step_order AS "order",label,required_role AS role,approver_id
       FROM approval_flow_steps WHERE flow_id=$1 ORDER BY step_order`, [flowId],
    ));
  }

  async createApprovalFlow(data, actor) {
    const result = await this.sql.query(
      `INSERT INTO approval_flows(name,resource_type,resource_id,active) VALUES($1,$2,$3,$4) RETURNING *`,
      [data.name, data.resourceType, data.resourceId || null, data.active ?? true],
    );
    const flow = camel(result[0]);
    for (const [index, step] of data.steps.entries()) {
      await this.sql.query(
        `INSERT INTO approval_flow_steps(flow_id,step_order,label,required_role,approver_id)
         VALUES($1,$2,$3,$4,$5)`,
        [flow.id, index + 1, step.label || `Approval ${index + 1}`, step.role || "approver", step.approverId || null],
      );
    }
    flow.steps = await this.stepsForFlow(flow.id);
    await this.appendAudit(actor, "approval_flow.created", "approval_flow", flow.id, null, flow);
    return flow;
  }

  async resolveApprovalSteps(resourceType, resourceId) {
    const flows = await this.sql.query(
      `SELECT id FROM approval_flows WHERE active AND resource_type=$1 AND (resource_id=$2 OR resource_id IS NULL)
       ORDER BY (resource_id IS NOT NULL) DESC LIMIT 1`, [resourceType, resourceId],
    );
    return flows[0] ? this.stepsForFlow(flows[0].id) : [];
  }

  async getApprovalContext(bookingId) {
    const booking = await this.getBooking(bookingId);
    const steps = await this.resolveApprovalSteps(booking.resourceType, booking.resourceId);
    const decisions = rows(await this.sql.query(
      `SELECT id,booking_id,step_id,step_order,approver_id,decision,comment,decided_at
       FROM booking_approvals WHERE booking_id=$1 ORDER BY step_order`, [bookingId],
    ));
    return { booking, steps, decisions };
  }

  async listPendingApprovals(user) {
    return rows(await this.sql.query(
      `SELECT b.*,jsonb_build_object('id',s.id,'order',s.step_order,'label',s.label,'role',s.required_role,'approverId',s.approver_id) AS current_step
       FROM bookings b
       JOIN LATERAL (
         SELECT af.id FROM approval_flows af WHERE af.active AND af.resource_type=b.resource_type
         AND (af.resource_id=b.resource_id OR af.resource_id IS NULL)
         ORDER BY (af.resource_id IS NOT NULL) DESC LIMIT 1
       ) flow ON true
       JOIN approval_flow_steps s ON s.flow_id=flow.id AND s.step_order=b.current_approval_order
       WHERE b.status='pending' AND ($2='admin' OR s.approver_id=$1 OR (s.approver_id IS NULL AND s.required_role=$2))
       ORDER BY b.created_at`, [user.id, user.role],
    ));
  }

  async addDecision(bookingId, step, decision, comment, actor) {
    try {
      const result = await this.sql.query(
        `INSERT INTO booking_approvals(booking_id,step_id,step_order,approver_id,decision,comment)
         VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
        [bookingId, step.id, step.order, actor.id, decision, comment || null],
      );
      const record = camel(result[0]);
      await this.appendAudit(actor, `approval.${decision}`, "booking", bookingId, null, record);
      return record;
    } catch (error) {
      if (error.code === "23505") throw conflict("This approval step has already been decided");
      throw error;
    }
  }

  async listContent(type, filters = {}) {
    const meta = CONTENT[type];
    const values = [];
    let where = "";
    if (type === "matches" && filters.tournamentId) { values.push(filters.tournamentId); where = "WHERE tournament_id=$1"; }
    const order = type === "committee" ? "display_order,name" : type === "matches" ? "starts_at" : "created_at DESC";
    return rows(await this.sql.query(`SELECT * FROM ${meta.table} ${where} ORDER BY ${order}`, values));
  }

  async getContent(type, id) {
    const meta = CONTENT[type];
    const result = await this.sql.query(`SELECT * FROM ${meta.table} WHERE id=$1`, [id]);
    if (!result[0]) throw notFound("Content");
    return camel(result[0]);
  }

  async createContent(type, data, actor) {
    const meta = CONTENT[type];
    const fields = meta.columns.filter((field) => data[field.replace(/_([a-z])/g, (_, x) => x.toUpperCase())] !== undefined);
    const values = fields.map((field) => {
      const value = data[field.replace(/_([a-z])/g, (_, x) => x.toUpperCase())];
      return ["home_score", "away_score"].includes(field) ? JSON.stringify(value) : value;
    });
    const result = await this.sql.query(
      `INSERT INTO ${meta.table} (${fields.join(",")}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(",")}) RETURNING *`, values,
    );
    const record = camel(result[0]);
    await this.appendAudit(actor, `${type}.created`, type, record.id, null, record);
    return record;
  }

  async updateContent(type, id, data, actor) {
    const meta = CONTENT[type];
    const before = await this.getContent(type, id);
    const fields = meta.columns.filter((field) => data[field.replace(/_([a-z])/g, (_, x) => x.toUpperCase())] !== undefined);
    if (!fields.length) return before;
    const values = fields.map((field) => {
      const value = data[field.replace(/_([a-z])/g, (_, x) => x.toUpperCase())];
      return ["home_score", "away_score"].includes(field) ? JSON.stringify(value) : value;
    });
    values.push(id);
    const set = fields.map((field, i) => `${field}=$${i + 1}`).join(",");
    const result = await this.sql.query(
      `UPDATE ${meta.table} SET ${set},updated_at=now() WHERE id=$${values.length} RETURNING *`, values,
    );
    const after = camel(result[0]);
    await this.appendAudit(actor, `${type}.updated`, type, id, before, after);
    return after;
  }

  async createEquipmentAssets(equipmentId, assets, actor) {
    const equipment = await this.getResource("equipment", equipmentId);
    if (equipment.tracking !== "ASSET") throw badRequest("Asset tags can only be added to ASSET-tracked equipment");
    const created = [];
    for (const asset of assets) {
      const result = await this.sql.query(
        "INSERT INTO equipment_assets(equipment_id,asset_tag,serial_number,condition) VALUES($1,$2,$3,$4) RETURNING *",
        [equipmentId, asset.assetTag, asset.serialNumber || null, asset.condition || "good"],
      );
      created.push(camel(result[0]));
    }
    await this.appendAudit(actor, "equipment.assets.created", "equipment", equipmentId, null, created);
    return created;
  }

  async listEquipmentCatalog() {
    const [sports, locations] = await Promise.all([
      this.listSports(), this.sql.query("SELECT * FROM campus_locations ORDER BY name"),
    ]);
    return { sports, locations: rows(locations) };
  }

  async createCatalogEntry(kind, data, actor) {
    if (kind !== "location") throw badRequest("Unknown catalog type");
    const table = "campus_locations";
    const result = await this.sql.query(
      `INSERT INTO ${table}(name,active,created_by) VALUES($1,$2,$3) RETURNING *`,
      [data.name, data.active ?? true, actor.id],
    );
    await this.appendAudit(actor, `equipment_catalog.${kind}.created`, kind, result[0].id, null, result[0]);
    return camel(result[0]);
  }

  async updateCatalogEntry(kind, id, data, actor) {
    if (kind !== "location") throw badRequest("Unknown catalog type");
    const table = "campus_locations";
    const result = await this.sql.query(
      `UPDATE ${table} SET name=COALESCE($2,name),active=COALESCE($3,active),updated_at=now() WHERE id=$1 RETURNING *`,
      [id, data.name ?? null, data.active ?? null],
    );
    if (!result[0]) throw notFound("Campus location");
    await this.appendAudit(actor, `equipment_catalog.${kind}.updated`, kind, id, null, result[0]);
    return camel(result[0]);
  }

  async listEquipmentInventory(filters = {}) {
    const values = [];
    const clauses = [];
    for (const [key, column] of [["sportId", "e.sport_id"], ["tracking", "e.tracking"]]) {
      if (filters[key]) { values.push(filters[key]); clauses.push(`${column}=$${values.length}`); }
    }
    if (filters.q) { values.push(filters.q); clauses.push(`e.name ILIKE '%' || $${values.length} || '%'`); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    let items = rows(await this.sql.query(
      `SELECT e.id,e.name,e.quantity AS total_owned,e.tracking,e.photo_path,e.active,s.id AS sport_id,s.name AS sport_name,
       CASE WHEN e.tracking='ASSET' THEN count(a.id) FILTER (WHERE a.state='IN_INVENTORY')
        ELSE GREATEST(0,e.quantity-COALESCE(x.casual_allocated_quantity,0)-COALESCE(c.with_teams,0)-COALESCE(c.damaged,0)-COALESCE(c.missing,0)) END::int AS in_inventory_quantity,
       CASE WHEN e.tracking='ASSET' THEN count(a.id) FILTER (WHERE a.state='CASUAL_POOL')
        ELSE GREATEST(0,COALESCE(x.casual_allocated_quantity,0)-COALESCE(c.with_students,0)) END::int AS casual_pool_quantity,
       CASE WHEN e.tracking='ASSET' THEN count(a.id) FILTER (WHERE a.state='HELD_BY_TEAM') ELSE COALESCE(c.with_teams,0) END::int AS with_teams_quantity,
       CASE WHEN e.tracking='ASSET' THEN count(a.id) FILTER (WHERE a.state='ISSUED_TO_STUDENT') ELSE COALESCE(c.with_students,0) END::int AS with_students_quantity,
       CASE WHEN e.tracking='ASSET' THEN count(a.id) FILTER (WHERE a.state='DAMAGED') ELSE COALESCE(c.damaged,0) END::int AS damaged_quantity,
       CASE WHEN e.tracking='ASSET' THEN count(a.id) FILTER (WHERE a.state='MISSING') ELSE COALESCE(c.missing,0) END::int AS missing_quantity,
       COALESCE(jsonb_agg(DISTINCT jsonb_build_object('id',a.id,'assetTag',a.asset_tag,'serialNumber',a.serial_number,'condition',a.condition,'state',a.state)) FILTER (WHERE a.id IS NOT NULL),'[]'::jsonb) AS assets,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('custodyId',h.id,'state',h.state,'quantity',h.quantity,'studentId',h.student_id,
        'studentName',u.name,'studentEmail',u.email,'teamId',h.team_id,'teamName',t.name,'since',h.updated_at,'requestId',h.source_request_id,'note',h.note) ORDER BY h.updated_at)
        FROM equipment_custody h LEFT JOIN app_users u ON u.id=h.student_id LEFT JOIN teams t ON t.id=h.team_id WHERE h.equipment_id=e.id),'[]'::jsonb) AS holders
       FROM equipment_items e JOIN sports s ON s.id=e.sport_id
       LEFT JOIN equipment_allocations x ON x.equipment_id=e.id LEFT JOIN equipment_assets a ON a.equipment_id=e.id
       LEFT JOIN LATERAL (SELECT sum(quantity) FILTER (WHERE state='ISSUED_TO_STUDENT')::int AS with_students,
        sum(quantity) FILTER (WHERE state='HELD_BY_TEAM')::int AS with_teams,sum(quantity) FILTER (WHERE state='DAMAGED')::int AS damaged,
        sum(quantity) FILTER (WHERE state='MISSING')::int AS missing FROM equipment_custody WHERE equipment_id=e.id) c ON true
       ${where} GROUP BY e.id,s.id,x.casual_allocated_quantity,c.with_students,c.with_teams,c.damaged,c.missing ORDER BY s.name,e.name`, values,
    ));
    const stateField = { IN_INVENTORY: "inInventoryQuantity", CASUAL_POOL: "casualPoolQuantity", HELD_BY_TEAM: "withTeamsQuantity", ISSUED_TO_STUDENT: "withStudentsQuantity", DAMAGED: "damagedQuantity", MISSING: "missingQuantity" };
    if (filters.state && stateField[filters.state]) items = items.filter((item) => Number(item[stateField[filters.state]]) > 0);
    const summary = items.reduce((sum, item) => ({
      totalOwned: sum.totalOwned + Number(item.totalOwned), inInventory: sum.inInventory + Number(item.inInventoryQuantity),
      casualPool: sum.casualPool + Number(item.casualPoolQuantity), withTeams: sum.withTeams + Number(item.withTeamsQuantity),
      withStudents: sum.withStudents + Number(item.withStudentsQuantity), damagedOrMissing: sum.damagedOrMissing + Number(item.damagedQuantity) + Number(item.missingQuantity),
    }), { totalOwned: 0, inInventory: 0, casualPool: 0, withTeams: 0, withStudents: 0, damagedOrMissing: 0 });
    return { summary, sports: await this.listSports(), items };
  }

  async transferEquipmentState(equipmentId, data, actor) {
    if (data.fromState === data.toState) throw badRequest("Source and destination must be different");
    const storeStates = ["IN_INVENTORY", "CASUAL_POOL"];
    const allocationOnly = storeStates.includes(data.fromState) && storeStates.includes(data.toState);
    if (!allocationOnly && !data.reason) throw badRequest("Manual custody corrections require a reason");
    if (data.toState === "HELD_BY_TEAM" && !data.teamId) throw badRequest("Choose the team receiving this equipment");
    if (data.toState === "ISSUED_TO_STUDENT" && !data.studentId) throw badRequest("Choose the student receiving this equipment");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const equipment = (await client.query("SELECT * FROM equipment_items WHERE id=$1 FOR UPDATE", [equipmentId])).rows[0];
      if (!equipment) throw notFound("Equipment item");
      const quantity = Number(data.quantity);
      if (equipment.tracking === "ASSET") {
        if (data.assetIds.length !== quantity) throw badRequest("Select exactly one tracked unit for each unit transferred");
        const assets = (await client.query("SELECT * FROM equipment_assets WHERE equipment_id=$1 AND id=ANY($2::uuid[]) FOR UPDATE", [equipmentId, data.assetIds])).rows;
        if (assets.length !== quantity || assets.some((asset) => asset.state !== data.fromState)) throw conflict("One or more selected units are not in the source state");
        for (const asset of assets) {
          await client.query("DELETE FROM equipment_custody WHERE asset_id=$1", [asset.id]);
          if (!storeStates.includes(data.toState)) await client.query(
            `INSERT INTO equipment_custody(equipment_id,asset_id,quantity,state,student_id,team_id,source_request_id,note)
             VALUES($1,$2,1,$3,$4,$5,NULL,$6)`,
            [equipmentId, asset.id, data.toState, data.toState === "ISSUED_TO_STUDENT" ? data.studentId : null, data.toState === "HELD_BY_TEAM" ? data.teamId : null, data.reason || null],
          );
          await client.query("UPDATE equipment_assets SET state=$2,note=$3,updated_at=now() WHERE id=$1", [asset.id, data.toState, data.reason || null]);
          await client.query(
            `INSERT INTO equipment_state_audit(equipment_id,asset_id,quantity,from_state,to_state,actor_id,person_id,team_id,note,manual_override)
             VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9)`,
            [equipmentId, asset.id, data.fromState, data.toState, actor.id, data.studentId || null, data.teamId || null, data.reason || "Inventory allocation", !allocationOnly],
          );
        }
      } else {
        const counts = (await client.query(
          `SELECT e.quantity,COALESCE(x.casual_allocated_quantity,0)::int AS allocated,
           COALESCE(sum(c.quantity) FILTER (WHERE c.state='ISSUED_TO_STUDENT'),0)::int AS students,
           COALESCE(sum(c.quantity) FILTER (WHERE c.state='HELD_BY_TEAM'),0)::int AS teams,
           COALESCE(sum(c.quantity) FILTER (WHERE c.state='DAMAGED'),0)::int AS damaged,
           COALESCE(sum(c.quantity) FILTER (WHERE c.state='MISSING'),0)::int AS missing
           FROM equipment_items e LEFT JOIN equipment_allocations x ON x.equipment_id=e.id
           LEFT JOIN equipment_custody c ON c.equipment_id=e.id WHERE e.id=$1 GROUP BY e.id,x.casual_allocated_quantity`, [equipmentId],
        )).rows[0];
        const available = {
          IN_INVENTORY: Number(counts.quantity)-Number(counts.allocated)-Number(counts.teams)-Number(counts.damaged)-Number(counts.missing),
          CASUAL_POOL: Number(counts.allocated)-Number(counts.students), HELD_BY_TEAM: Number(counts.teams),
          ISSUED_TO_STUDENT: Number(counts.students), DAMAGED: Number(counts.damaged), MISSING: Number(counts.missing),
        };
        if (available[data.fromState] < quantity) throw conflict(`Only ${available[data.fromState]} units are available in ${data.fromState}`);
        const physical = ["HELD_BY_TEAM", "ISSUED_TO_STUDENT", "DAMAGED", "MISSING"];
        if (physical.includes(data.fromState)) {
          let remaining = quantity;
          const custody = (await client.query("SELECT * FROM equipment_custody WHERE equipment_id=$1 AND state=$2 ORDER BY updated_at FOR UPDATE", [equipmentId, data.fromState])).rows
            .filter((row) => !data.custodyIds.length || data.custodyIds.includes(row.id));
          for (const row of custody) {
            if (!remaining) break;
            const take = Math.min(remaining, Number(row.quantity));
            if (take === Number(row.quantity)) await client.query("DELETE FROM equipment_custody WHERE id=$1", [row.id]);
            else await client.query("UPDATE equipment_custody SET quantity=quantity-$2,updated_at=now() WHERE id=$1", [row.id, take]);
            remaining -= take;
          }
          if (remaining) throw conflict("The selected custody records do not contain enough quantity");
        }
        if (physical.includes(data.toState)) await client.query(
          `INSERT INTO equipment_custody(equipment_id,quantity,state,student_id,team_id,source_request_id,note)
           VALUES($1,$2,$3,$4,$5,NULL,$6)`,
          [equipmentId, quantity, data.toState, data.toState === "ISSUED_TO_STUDENT" ? data.studentId : null, data.toState === "HELD_BY_TEAM" ? data.teamId : null, data.reason || null],
        );
        const casualStates = ["CASUAL_POOL", "ISSUED_TO_STUDENT"];
        const allocationDelta = (casualStates.includes(data.toState) ? quantity : 0) - (casualStates.includes(data.fromState) ? quantity : 0);
        const nextAllocation = Number(counts.allocated) + allocationDelta;
        const nextStudents = Number(counts.students) + (data.toState === "ISSUED_TO_STUDENT" ? quantity : 0) - (data.fromState === "ISSUED_TO_STUDENT" ? quantity : 0);
        if (nextAllocation < nextStudents) throw conflict("The casual allocation cannot be reduced below equipment currently issued to students");
        if (allocationDelta) await client.query(
          `INSERT INTO equipment_allocations(equipment_id,casual_allocated_quantity,updated_by) VALUES($1,$2,$3)
           ON CONFLICT(equipment_id) DO UPDATE SET casual_allocated_quantity=EXCLUDED.casual_allocated_quantity,updated_by=EXCLUDED.updated_by,updated_at=now()`,
          [equipmentId, nextAllocation, actor.id],
        );
        await client.query(
          `INSERT INTO equipment_state_audit(equipment_id,quantity,from_state,to_state,actor_id,person_id,team_id,note,manual_override)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [equipmentId, quantity, data.fromState, data.toState, actor.id, data.studentId || null, data.teamId || null, data.reason || "Inventory allocation", !allocationOnly],
        );
      }
      await client.query("COMMIT");
      await this.appendAudit(actor, allocationOnly ? "equipment.allocation.transferred" : "equipment.custody.manual_override", "equipment", equipmentId, null, data);
      return { equipmentId, ...data, manualOverride: !allocationOnly };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async resolveEquipmentException(custodyId, action, actor) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const custody = (await client.query("SELECT * FROM equipment_custody WHERE id=$1 AND state IN ('DAMAGED','MISSING') FOR UPDATE", [custodyId])).rows[0];
      if (!custody) throw notFound("Damaged or missing custody record");
      if (action === "restore") {
        await client.query("DELETE FROM equipment_custody WHERE id=$1", [custodyId]);
        if (custody.asset_id) await client.query("UPDATE equipment_assets SET state='IN_INVENTORY',note=NULL,updated_at=now() WHERE id=$1", [custody.asset_id]);
        await client.query(
          `INSERT INTO equipment_state_audit(equipment_id,asset_id,quantity,from_state,to_state,actor_id,request_id,person_id,team_id,note)
           VALUES($1,$2,$3,$4,'IN_INVENTORY',$5,$6,$7,$8,'Restored to stock')`,
          [custody.equipment_id,custody.asset_id,custody.quantity,custody.state,actor.id,custody.source_request_id,custody.student_id,custody.team_id],
        );
      } else {
        await client.query("UPDATE equipment_items SET quantity=quantity-$2,active=(quantity-$2)>0,updated_at=now() WHERE id=$1 AND quantity>=$2", [custody.equipment_id,custody.quantity]);
        await client.query("DELETE FROM equipment_custody WHERE id=$1", [custodyId]);
        if (custody.asset_id) await client.query("DELETE FROM equipment_assets WHERE id=$1", [custody.asset_id]);
      }
      await client.query("COMMIT");
      await this.appendAudit(actor, `equipment.exception.${action}`, "equipment_custody", custodyId, custody, null);
      return { id: custodyId, action };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async listSports() {
    return rows(await this.sql.query(
      `SELECT s.*,p.primary_poc_id,p.secondary_poc_id,
       u1.name AS primary_poc_name,u1.email AS primary_poc_email,
       u2.name AS secondary_poc_name,u2.email AS secondary_poc_email
       FROM sports s LEFT JOIN sport_pocs p ON p.sport_id=s.id
       LEFT JOIN app_users u1 ON u1.id=p.primary_poc_id
       LEFT JOIN app_users u2 ON u2.id=p.secondary_poc_id ORDER BY s.name`,
    ));
  }

  async createSport(data, actor) {
    const result = await this.sql.query(
      "INSERT INTO sports(name,active,created_by) VALUES($1,$2,$3) RETURNING *",
      [data.name, data.active ?? true, actor.id],
    );
    await this.appendAudit(actor, "sport.created", "sport", result[0].id, null, result[0]);
    return camel(result[0]);
  }

  async updateSport(id, data, actor) {
    const result = await this.sql.query(
      "UPDATE sports SET name=COALESCE($2,name),active=COALESCE($3,active),updated_at=now() WHERE id=$1 RETURNING *",
      [id, data.name ?? null, data.active ?? null],
    );
    if (!result[0]) throw notFound("Sport");
    await this.appendAudit(actor, "sport.updated", "sport", id, null, result[0]);
    return camel(result[0]);
  }

  async setSportPocs(sportId, data, actor) {
    for (const userId of [data.primaryPocId, data.secondaryPocId].filter(Boolean)) {
      const user = await this.getUser(userId);
      if (user.role !== "approver") throw badRequest("A sport POC must be a SportComm member");
    }
    const result = await this.sql.query(
      `INSERT INTO sport_pocs(sport_id,primary_poc_id,secondary_poc_id,updated_by) VALUES($1,$2,$3,$4)
       ON CONFLICT(sport_id) DO UPDATE SET primary_poc_id=EXCLUDED.primary_poc_id,secondary_poc_id=EXCLUDED.secondary_poc_id,updated_by=EXCLUDED.updated_by,updated_at=now()
       RETURNING *`, [sportId, data.primaryPocId || null, data.secondaryPocId || null, actor.id],
    );
    await this.appendAudit(actor, "sport.pocs.updated", "sport", sportId, null, result[0]);
    return camel(result[0]);
  }

  async listTeams() {
    return rows(await this.sql.query(
      `SELECT t.*,s.name AS sport_name,u.name AS captain_name,u.email AS captain_email,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('id',m.id,'name',m.name,'email',m.email) ORDER BY m.name)
         FROM team_members tm JOIN app_users m ON m.id=tm.user_id WHERE tm.team_id=t.id),'[]'::jsonb) AS members
       FROM teams t JOIN sports s ON s.id=t.sport_id JOIN app_users u ON u.id=t.captain_id ORDER BY s.name,t.name`,
    ));
  }

  async assignSportCaptain(sportId, email, actor) {
    const captain = await this.getUserByEmail(email);
    if (!captain) throw notFound("Student account; ask the student to sign up before assigning them as captain");
    if (captain.role !== "requester") throw badRequest("A captain must have the Student role");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const sport = (await client.query("SELECT * FROM sports WHERE id=$1 FOR UPDATE", [sportId])).rows[0];
      if (!sport) throw notFound("Sport");
      const existing = (await client.query(
        "SELECT * FROM teams WHERE sport_id=$1 ORDER BY active DESC,created_at LIMIT 1 FOR UPDATE", [sportId],
      )).rows[0];
      let team;
      if (existing) {
        team = (await client.query(
          "UPDATE teams SET name=$2,captain_id=$3,active=true,updated_at=now() WHERE id=$1 RETURNING *",
          [existing.id, sport.name, captain.id],
        )).rows[0];
        await client.query("UPDATE teams SET active=false,updated_at=now() WHERE sport_id=$1 AND id<>$2", [sportId, existing.id]);
      } else {
        team = (await client.query(
          "INSERT INTO teams(name,sport_id,captain_id,active,created_by) VALUES($1,$2,$3,true,$4) RETURNING *",
          [sport.name, sportId, captain.id, actor.id],
        )).rows[0];
      }
      await client.query("INSERT INTO team_members(team_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [team.id, captain.id]);
      await client.query(
        `INSERT INTO audit_log(actor_id,action,entity_type,entity_id,before_state,after_state)
         VALUES($1,'sport.captain.assigned','sport',$2,$3::jsonb,$4::jsonb)`,
        [actor.id, String(sportId), existing ? JSON.stringify(existing) : null, JSON.stringify({ ...team, captainEmail: captain.email })],
      );
      await client.query("COMMIT");
      return camel({ ...team, sport_name: sport.name, captain_name: captain.name, captain_email: captain.email });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createTeam(data, actor) {
    await this.getUser(data.captainId);
    const result = await this.sql.query(
      "INSERT INTO teams(name,sport_id,captain_id,active,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [data.name, data.sportId, data.captainId, data.active ?? true, actor.id],
    );
    for (const memberId of [...new Set([data.captainId, ...(data.memberIds || [])])]) {
      await this.sql.query("INSERT INTO team_members(team_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [result[0].id, memberId]);
    }
    await this.appendAudit(actor, "team.created", "team", result[0].id, null, result[0]);
    return camel(result[0]);
  }

  async updateTeam(id, data, actor) {
    const result = await this.sql.query(
      "UPDATE teams SET name=COALESCE($2,name),sport_id=COALESCE($3,sport_id),captain_id=COALESCE($4,captain_id),active=COALESCE($5,active),updated_at=now() WHERE id=$1 RETURNING *",
      [id, data.name ?? null, data.sportId ?? null, data.captainId ?? null, data.active ?? null],
    );
    if (!result[0]) throw notFound("Team");
    if (data.memberIds) {
      await this.sql.query("DELETE FROM team_members WHERE team_id=$1", [id]);
      for (const memberId of [...new Set([result[0].captain_id, ...data.memberIds])]) {
        await this.sql.query("INSERT INTO team_members(team_id,user_id) VALUES($1,$2)", [id, memberId]);
      }
    }
    await this.appendAudit(actor, "team.updated", "team", id, null, result[0]);
    return camel(result[0]);
  }

  async listEquipmentRequests(user) {
    let values = [user.id];
    let visibility = "r.requester_id=$1";
    if (["admin", "inventory_kiosk", "approver"].includes(user.role)) {
      visibility = "true";
      values = [];
    }
    return rows(await this.sql.query(
      `SELECT r.*,u.name AS requester_name,u.email AS requester_email,t.name AS team_name,s.name AS sport_name,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('equipmentId',ri.equipment_id,'name',e.name,'quantity',ri.quantity) ORDER BY e.name)
        FROM equipment_request_items ri JOIN equipment_items e ON e.id=ri.equipment_id WHERE ri.request_id=r.id),'[]'::jsonb) AS items
       FROM equipment_requests r JOIN app_users u ON u.id=r.requester_id
       LEFT JOIN teams t ON t.id=r.team_id LEFT JOIN sports s ON s.id=r.sport_id
       WHERE ${visibility} ORDER BY r.created_at DESC`, values,
    ));
  }

  async getEquipmentRequest(id) {
    const result = await this.sql.query("SELECT * FROM equipment_requests WHERE id=$1", [id]);
    if (!result[0]) throw notFound("Equipment request");
    return camel(result[0]);
  }

  async createEquipmentRequest(data, actor) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      let sportId = null;
      let status = "PENDING";
      if (data.requestType === "TEAM") {
        const team = (await client.query("SELECT * FROM teams WHERE id=$1 AND active FOR SHARE", [data.teamId])).rows[0];
        if (!team) throw notFound("Team");
        if (team.captain_id !== actor.id) throw forbidden("Only this team's captain can request equipment");
        sportId = team.sport_id;
      } else if (data.requestType === "RETURN") {
        const parent = (await client.query("SELECT * FROM equipment_requests WHERE id=$1 FOR SHARE", [data.parentRequestId])).rows[0];
        if (!parent) throw notFound("Original equipment request");
        if (parent.requester_id !== actor.id) throw forbidden("Only the original requester can return this equipment");
        data.teamId = parent.team_id;
        sportId = parent.sport_id;
        status = "APPROVED";
      }
      for (const item of data.items) {
        const equipment = (await client.query(
          `SELECT e.*,
           CASE WHEN e.tracking='ASSET' THEN (SELECT count(*) FROM equipment_assets a WHERE a.equipment_id=e.id AND a.state='CASUAL_POOL')
            ELSE GREATEST(0,COALESCE((SELECT casual_allocated_quantity FROM equipment_allocations x WHERE x.equipment_id=e.id),0)
              -COALESCE((SELECT sum(quantity) FROM equipment_custody c WHERE c.equipment_id=e.id AND c.state='ISSUED_TO_STUDENT'),0)) END::int AS casual_available,
           CASE WHEN e.tracking='ASSET' THEN (SELECT count(*) FROM equipment_assets a WHERE a.equipment_id=e.id AND a.state='IN_INVENTORY')
            ELSE GREATEST(0,e.quantity-COALESCE((SELECT casual_allocated_quantity FROM equipment_allocations x WHERE x.equipment_id=e.id),0)
              -COALESCE((SELECT sum(quantity) FROM equipment_custody c WHERE c.equipment_id=e.id AND c.state IN ('HELD_BY_TEAM','DAMAGED','MISSING')),0)) END::int AS team_available
           FROM equipment_items e WHERE e.id=$1 AND e.active FOR SHARE`, [item.equipmentId],
        )).rows[0];
        if (!equipment) throw notFound("Equipment item");
        if (data.requestType === "CASUAL" && Number(equipment.casual_available) < item.quantity) throw conflict(`${equipment.name} does not have enough quantity in the casual pool`);
        if (data.requestType === "TEAM" && Number(equipment.team_available) < item.quantity) throw conflict(`${equipment.name} does not have enough unallocated inventory`);
      }
      const request = (await client.query(
        `INSERT INTO equipment_requests(request_type,requester_id,team_id,sport_id,parent_request_id,expected_return_at,status)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [data.requestType, actor.id, data.teamId || null, sportId, data.parentRequestId || null, data.expectedReturnAt || null, status],
      )).rows[0];
      for (const item of data.items) await client.query(
        "INSERT INTO equipment_request_items(request_id,equipment_id,quantity) VALUES($1,$2,$3)",
        [request.id, item.equipmentId, item.quantity],
      );
      await client.query("COMMIT");
      await this.appendAudit(actor, `equipment_request.${data.requestType.toLowerCase()}.created`, "equipment_request", request.id, null, request);
      return camel(request);
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async decideEquipmentRequest(id, decision, note, actor) {
    const request = (await this.sql.query("SELECT * FROM equipment_requests WHERE id=$1", [id]))[0];
    if (!request) throw notFound("Equipment request");
    if (request.status !== "PENDING") throw conflict("This equipment request has already been decided");
    let allowed = actor.role === "admin";
    if (actor.role === "approver" && request.request_type === "CASUAL") allowed = true;
    if (actor.role === "approver" && request.request_type === "TEAM") {
      const pocs = await this.sql.query("SELECT * FROM sport_pocs WHERE sport_id=$1", [request.sport_id]);
      allowed = Boolean(pocs[0] && [pocs[0].primary_poc_id, pocs[0].secondary_poc_id].includes(actor.id));
    }
    if (!allowed) throw forbidden("You can view this request but are not its assigned approver");
    const status = decision === "approve" ? "APPROVED" : "REJECTED";
    const override = actor.role === "admin";
    let result;
    try { result = await this.sql.query(
      `UPDATE equipment_requests SET status=$2,decision_note=$3,approved_by=$4,approved_at=now(),
       due_at=CASE WHEN request_type='CASUAL' AND $2='APPROVED' THEN expected_return_at ELSE due_at END,
       administrator_override=$5,updated_at=now() WHERE id=$1 RETURNING *`,
      [id, status, note || null, actor.id, override],
    ); } catch (error) {
      if (error.constraint === "one_active_casual_issue_per_student") throw conflict("This student already has an active casual equipment issue");
      throw error;
    }
    await this.appendAudit(actor, override ? `equipment_request.admin_override.${decision}` : `equipment_request.${decision}`, "equipment_request", id, request, result[0]);
    return camel(result[0]);
  }

  async createEquipmentQr(data) {
    const result = await this.sql.query(
      "INSERT INTO equipment_qr_tokens(request_id,purpose,token_hash,expires_at) VALUES($1,$2,$3,$4) RETURNING *",
      [data.requestId, data.purpose, data.tokenHash, data.expiresAt],
    );
    return camel(result[0]);
  }

  async inspectEquipmentQr(tokenHash) {
    const result = await this.sql.query(
      `SELECT q.*,r.request_type,r.status,r.requester_id,r.team_id,r.parent_request_id,
       u.name AS requester_name,u.email AS requester_email,t.name AS team_name,
       used.name AS used_by_name,used.email AS used_by_email
       FROM equipment_qr_tokens q JOIN equipment_requests r ON r.id=q.request_id
       JOIN app_users u ON u.id=r.requester_id LEFT JOIN teams t ON t.id=r.team_id
       LEFT JOIN app_users used ON used.id=q.used_by WHERE q.token_hash=$1`, [tokenHash],
    );
    if (!result[0]) throw unauthorized("Invalid equipment QR token");
    const token = camel(result[0]);
    if (token.usedAt) throw conflict(`Equipment QR token was already used at ${token.usedAt} by ${token.usedByName || token.usedByEmail || token.usedBy}`, { usedAt: token.usedAt, usedBy: token.usedBy, usedByName: token.usedByName });
    if (new Date(token.expiresAt) <= new Date()) throw badRequest("Equipment QR token has expired");
    const sourceState = token.requestType === "CASUAL" ? "CASUAL_POOL" : "IN_INVENTORY";
    const itemRows = await this.sql.query(
      `SELECT ri.equipment_id,ri.quantity,e.name,e.tracking
       FROM equipment_request_items ri JOIN equipment_items e ON e.id=ri.equipment_id
       WHERE ri.request_id=$1 ORDER BY e.name`, [token.requestId],
    );
    token.items = [];
    for (const row of itemRows) {
      const item = camel(row);
      item.assets = [];
      if (row.tracking === "ASSET") {
        const assets = token.purpose === "ISSUE"
          ? await this.sql.query(
            `SELECT id,asset_tag,serial_number,condition,state FROM equipment_assets
             WHERE equipment_id=$1 AND state=$2 ORDER BY asset_tag`, [row.equipment_id, sourceState],
          )
          : await this.sql.query(
            `SELECT a.id,a.asset_tag,a.serial_number,a.condition,c.state,c.created_at AS held_since
             FROM equipment_custody c JOIN equipment_assets a ON a.id=c.asset_id
             WHERE c.source_request_id=$1 AND c.equipment_id=$2
             AND c.state IN ('ISSUED_TO_STUDENT','HELD_BY_TEAM') ORDER BY a.asset_tag`,
            [token.parentRequestId, row.equipment_id],
          );
        item.assets = rows(assets);
      }
      token.items.push(item);
    }
    return token;
  }

  async redeemEquipmentQr(tokenHash, outcomes, assetScans, actor) {
    if (!["inventory_kiosk", "admin"].includes(actor.role)) throw forbidden("Only the inventory kiosk can scan equipment QR codes");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const token = (await client.query(
        `SELECT q.*,r.request_type,r.requester_id,r.team_id,r.parent_request_id,r.status
         FROM equipment_qr_tokens q JOIN equipment_requests r ON r.id=q.request_id WHERE q.token_hash=$1 FOR UPDATE OF q,r`, [tokenHash],
      )).rows[0];
      if (!token) throw unauthorized("Invalid equipment QR token");
      if (token.used_at) {
        const usedBy = (await client.query("SELECT name,email FROM app_users WHERE id=$1", [token.used_by])).rows[0];
        throw conflict(`Equipment QR token was already used at ${token.used_at.toISOString()} by ${usedBy?.name || usedBy?.email || token.used_by}`, { usedAt: token.used_at, usedBy: token.used_by, usedByName: usedBy?.name });
      }
      if (token.expires_at <= new Date()) throw badRequest("Equipment QR token has expired");
      const items = (await client.query("SELECT * FROM equipment_request_items WHERE request_id=$1", [token.request_id])).rows;
      const normalizedAssetScans = (assetScans || []).map((scan) => ({
        ...scan,
        assetTag: String(scan.assetTag || "").trim().replace(/^asset:/i, "").toLowerCase(),
      }));
      const duplicateTags = normalizedAssetScans.filter((scan, index, all) => all.findIndex((other) => other.assetTag === scan.assetTag) !== index);
      if (duplicateTags.length) throw badRequest(`Asset tag ${duplicateTags[0].assetTag} was scanned more than once`);
      if (normalizedAssetScans.some((scan) => !items.some((item) => item.equipment_id === scan.equipmentId))) {
        throw badRequest("A scanned asset does not belong to this request");
      }
      const scansFor = (equipmentId) => normalizedAssetScans.filter((scan) => scan.equipmentId === equipmentId);
      if (token.purpose === "ISSUE") {
        if (token.status !== "APPROVED") throw conflict("The approval is no longer valid");
        if (token.request_type === "CASUAL") {
          const activeIssue = (await client.query(
            `SELECT id FROM equipment_requests WHERE requester_id=$1 AND request_type='CASUAL'
             AND status IN ('ISSUED','RETURN_PENDING') AND id<>$2 LIMIT 1 FOR SHARE`,
            [token.requester_id, token.request_id],
          )).rows[0];
          if (activeIssue) throw conflict("This student already has equipment issued. Return it before collecting another approved request");
        }
        for (const item of items) {
          const sourceState = token.request_type === "CASUAL" ? "CASUAL_POOL" : "IN_INVENTORY";
          const stock = (await client.query(
            `SELECT e.tracking,CASE WHEN e.tracking='ASSET' THEN (SELECT count(*) FROM equipment_assets a WHERE a.equipment_id=e.id AND a.state=$2)
              WHEN $2='CASUAL_POOL' THEN GREATEST(0,COALESCE((SELECT casual_allocated_quantity FROM equipment_allocations x WHERE x.equipment_id=e.id),0)
                -COALESCE((SELECT sum(quantity) FROM equipment_custody c WHERE c.equipment_id=e.id AND c.state='ISSUED_TO_STUDENT'),0))
              ELSE GREATEST(0,e.quantity-COALESCE((SELECT casual_allocated_quantity FROM equipment_allocations x WHERE x.equipment_id=e.id),0)
                -COALESCE((SELECT sum(quantity) FROM equipment_custody c WHERE c.equipment_id=e.id AND c.state IN ('HELD_BY_TEAM','DAMAGED','MISSING')),0)) END AS available
             FROM equipment_items e WHERE e.id=$1 FOR UPDATE`, [item.equipment_id, sourceState],
          )).rows[0];
          const state = token.request_type === "CASUAL" ? "ISSUED_TO_STUDENT" : "HELD_BY_TEAM";
          if (!stock) throw notFound("Equipment item");
          if (stock.tracking === "ASSET") {
            const scans = scansFor(item.equipment_id);
            if (scans.length !== item.quantity) throw badRequest(`Scan exactly ${item.quantity} asset tag(s) for this tracked item`);
            const assets = (await client.query(
              `SELECT id,asset_tag FROM equipment_assets WHERE equipment_id=$1 AND state=$2
               AND lower(asset_tag)=ANY($3::text[]) ORDER BY asset_tag FOR UPDATE`,
              [item.equipment_id, sourceState, scans.map((scan) => scan.assetTag)],
            )).rows;
            if (assets.length !== item.quantity) throw conflict("One or more scanned asset tags are invalid or no longer available for this request");
            for (const asset of assets) {
              await client.query(
                `INSERT INTO equipment_custody(equipment_id,asset_id,quantity,state,student_id,team_id,source_request_id)
                 VALUES($1,$2,1,$3,$4,$5,$6)`,
                [item.equipment_id, asset.id, state, token.request_type === "CASUAL" ? token.requester_id : null, token.team_id, token.request_id],
              );
              await client.query("UPDATE equipment_assets SET state=$2,updated_at=now() WHERE id=$1", [asset.id, state]);
              await client.query(
                `INSERT INTO equipment_state_audit(equipment_id,asset_id,quantity,from_state,to_state,actor_id,request_id,person_id,team_id)
                 VALUES($1,$2,1,$3,$4,$5,$6,$7,$8)`,
                [item.equipment_id, asset.id, sourceState, state, actor.id, token.request_id, token.requester_id, token.team_id],
              );
            }
          } else {
            if (Number(stock.available) < item.quantity) throw conflict("Insufficient available equipment at issue time");
            await client.query(
              `INSERT INTO equipment_custody(equipment_id,quantity,state,student_id,team_id,source_request_id)
               VALUES($1,$2,$3,$4,$5,$6)`,
              [item.equipment_id, item.quantity, state, token.request_type === "CASUAL" ? token.requester_id : null, token.team_id, token.request_id],
            );
            await client.query(
              `INSERT INTO equipment_state_audit(equipment_id,quantity,from_state,to_state,actor_id,request_id,person_id,team_id)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
              [item.equipment_id, item.quantity, sourceState, state, actor.id, token.request_id, token.requester_id, token.team_id],
            );
          }
        }
        await client.query("UPDATE equipment_requests SET status='ISSUED',updated_at=now() WHERE id=$1", [token.request_id]);
      } else {
        if (token.status !== "APPROVED") throw conflict("This return is no longer valid");
        const parent = (await client.query("SELECT request_type FROM equipment_requests WHERE id=$1", [token.parent_request_id])).rows[0];
        const returnTarget = parent?.request_type === "CASUAL" ? "CASUAL_POOL" : "IN_INVENTORY";
        const outcomeMap = new Map((outcomes || []).map((item) => [item.equipmentId, item]));
        for (const item of items) {
          const tracking = (await client.query("SELECT tracking FROM equipment_items WHERE id=$1", [item.equipment_id])).rows[0]?.tracking;
          if (tracking === "ASSET") {
            const scans = scansFor(item.equipment_id);
            if (scans.length !== item.quantity) throw badRequest(`Account for exactly ${item.quantity} asset tag(s) for this tracked return`);
            if (scans.some((scan) => !scan.outcome)) throw badRequest("Select returned, damaged, or missing for every tracked asset");
            const custodyRows = (await client.query(
              `SELECT c.*,a.asset_tag FROM equipment_custody c JOIN equipment_assets a ON a.id=c.asset_id
               WHERE c.source_request_id=$1 AND c.equipment_id=$2
               AND c.state IN ('ISSUED_TO_STUDENT','HELD_BY_TEAM')
               AND lower(a.asset_tag)=ANY($3::text[]) FOR UPDATE OF c,a`,
              [token.parent_request_id, item.equipment_id, scans.map((scan) => scan.assetTag)],
            )).rows;
            if (custodyRows.length !== item.quantity) throw conflict("One or more asset tags do not belong to this issue, or have already been returned");
            for (const custody of custodyRows) {
              const scan = scans.find((entry) => entry.assetTag === custody.asset_tag.toLowerCase());
              const target = scan.outcome === "RETURNED" ? returnTarget : scan.outcome;
              const note = scan.note || null;
              if (["IN_INVENTORY", "CASUAL_POOL"].includes(target)) {
                await client.query("DELETE FROM equipment_custody WHERE id=$1", [custody.id]);
              } else {
                await client.query("UPDATE equipment_custody SET state=$2,note=$3,updated_at=now() WHERE id=$1", [custody.id, target, note]);
              }
              await client.query("UPDATE equipment_assets SET state=$2,note=$3,updated_at=now() WHERE id=$1", [custody.asset_id, target, note]);
              await client.query(
                `INSERT INTO equipment_state_audit(equipment_id,asset_id,quantity,from_state,to_state,actor_id,request_id,person_id,team_id,note)
                 VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9)`,
                [item.equipment_id, custody.asset_id, custody.state, target, actor.id, token.request_id, custody.student_id, custody.team_id, note],
              );
            }
            continue;
          }
          const custodyRows = (await client.query(
            `SELECT * FROM equipment_custody WHERE source_request_id=$1 AND equipment_id=$2
             AND state IN ('ISSUED_TO_STUDENT','HELD_BY_TEAM') ORDER BY asset_id NULLS LAST FOR UPDATE`, [token.parent_request_id, item.equipment_id],
          )).rows;
          if (custodyRows.reduce((sum, row) => sum + row.quantity, 0) < item.quantity) throw conflict("Return quantity exceeds current custody");
          const outcome = outcomeMap.get(item.equipment_id) || {};
          const damaged = Number(outcome.damaged || 0), missing = Number(outcome.missing || 0);
          if (damaged + missing > item.quantity) throw badRequest("Damaged and missing quantities exceed the return quantity");
          let remaining = item.quantity, damagedLeft = damaged, missingLeft = missing;
          for (const custody of custodyRows) {
            if (remaining <= 0) break;
            const take = Math.min(remaining, custody.quantity);
            const damagedTake = Math.min(take, damagedLeft); damagedLeft -= damagedTake;
            const missingTake = Math.min(take - damagedTake, missingLeft); missingLeft -= missingTake;
            const returnedTake = take - damagedTake - missingTake;
            if (custody.asset_id) {
              const target = damagedTake ? "DAMAGED" : missingTake ? "MISSING" : returnTarget;
              if (["IN_INVENTORY", "CASUAL_POOL"].includes(target)) await client.query("DELETE FROM equipment_custody WHERE id=$1", [custody.id]);
              else await client.query("UPDATE equipment_custody SET state=$2,note=$3,updated_at=now() WHERE id=$1", [custody.id, target, outcome.note || null]);
              await client.query("UPDATE equipment_assets SET state=$2,note=$3,updated_at=now() WHERE id=$1", [custody.asset_id, target, outcome.note || null]);
              await client.query(
                `INSERT INTO equipment_state_audit(equipment_id,asset_id,quantity,from_state,to_state,actor_id,request_id,person_id,team_id,note)
                 VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9)`,
                [item.equipment_id, custody.asset_id, custody.state, target, actor.id, token.request_id, custody.student_id, custody.team_id, outcome.note || null],
              );
            } else {
              if (custody.quantity === take) await client.query("DELETE FROM equipment_custody WHERE id=$1", [custody.id]);
              else await client.query("UPDATE equipment_custody SET quantity=quantity-$2,updated_at=now() WHERE id=$1", [custody.id, take]);
              for (const [quantity, state] of [[damagedTake, "DAMAGED"], [missingTake, "MISSING"]]) if (quantity > 0) await client.query(
                `INSERT INTO equipment_custody(equipment_id,quantity,state,student_id,team_id,source_request_id,note)
                 VALUES($1,$2,$3,$4,$5,$6,$7)`,
                [item.equipment_id, quantity, state, custody.student_id, custody.team_id, token.parent_request_id, outcome.note || null],
              );
              for (const [quantity, state] of [[returnedTake, returnTarget], [damagedTake, "DAMAGED"], [missingTake, "MISSING"]]) if (quantity > 0) await client.query(
                `INSERT INTO equipment_state_audit(equipment_id,quantity,from_state,to_state,actor_id,request_id,person_id,team_id,note)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                [item.equipment_id, quantity, custody.state, state, actor.id, token.request_id, custody.student_id, custody.team_id, outcome.note || null],
              );
            }
            remaining -= take;
          }
          if (parent?.request_type === "CASUAL" && (damaged + missing) > 0) await client.query(
            `UPDATE equipment_allocations SET casual_allocated_quantity=GREATEST(0,casual_allocated_quantity-$2),updated_by=$3,updated_at=now() WHERE equipment_id=$1`,
            [item.equipment_id, damaged + missing, actor.id],
          );
        }
        await client.query("UPDATE equipment_requests SET status='COMPLETED',updated_at=now() WHERE id=$1", [token.request_id]);
        const remaining = (await client.query(
          "SELECT count(*)::int AS count FROM equipment_custody WHERE source_request_id=$1 AND state IN ('ISSUED_TO_STUDENT','HELD_BY_TEAM')",
          [token.parent_request_id],
        )).rows[0].count;
        if (Number(remaining) === 0) await client.query("UPDATE equipment_requests SET status='COMPLETED',updated_at=now() WHERE id=$1", [token.parent_request_id]);
      }
      await client.query("UPDATE equipment_qr_tokens SET used_at=now(),used_by=$2 WHERE id=$1", [token.id, actor.id]);
      await client.query("COMMIT");
      return { requestId: token.request_id, purpose: token.purpose, status: "completed" };
    } catch (error) {
      await client.query("ROLLBACK");
      if (error.constraint === "one_active_casual_issue_per_student") throw conflict("This student already has equipment issued. Return it before collecting another approved request");
      throw error;
    } finally { client.release(); }
  }

  async listEquipmentAudit(filters = {}) {
    const values = [];
    const clauses = [];
    for (const [key, column] of [["equipmentId", "a.equipment_id"], ["personId", "a.person_id"]]) if (filters[key]) { values.push(filters[key]); clauses.push(`${column}=$${values.length}`); }
    if (filters.from) { values.push(filters.from); clauses.push(`a.created_at>=$${values.length}`); }
    if (filters.to) { values.push(filters.to); clauses.push(`a.created_at<$${values.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return rows(await this.sql.query(
      `SELECT a.*,e.name AS equipment_name,u.name AS person_name,actor.name AS actor_name,t.name AS team_name
       FROM equipment_state_audit a JOIN equipment_items e ON e.id=a.equipment_id
       LEFT JOIN app_users u ON u.id=a.person_id JOIN app_users actor ON actor.id=a.actor_id
       LEFT JOIN teams t ON t.id=a.team_id ${where} ORDER BY a.created_at DESC LIMIT 500`, values,
    ));
  }

  async utilization(from, to) {
    const totals = await this.sql.query(
      `SELECT count(*)::int AS booking_count,
       count(*) FILTER (WHERE status IN ('approved','completed'))::int AS approved_count
       FROM bookings WHERE end_at>$1 AND start_at<$2`, [from, to],
    );
    const usage = await this.sql.query(
      `SELECT resource_id::text,round(sum(extract(epoch FROM (least(end_at,$2)-greatest(start_at,$1)))/3600)::numeric,2) AS booked_hours
       FROM bookings WHERE status IN ('approved','completed') AND end_at>$1 AND start_at<$2 GROUP BY resource_id`, [from, to],
    );
    return {
      from, to, bookingCount: Number(totals[0].booking_count), approvedCount: Number(totals[0].approved_count),
      bookedHoursByResource: Object.fromEntries(usage.map((item) => [item.resource_id, Number(item.booked_hours)])),
    };
  }

  async appendAudit(actor, action, entityType, entityId, before, after) {
    await this.sql.query(
      `INSERT INTO audit_log(actor_id,action,entity_type,entity_id,before_state,after_state)
       VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
      [actor?.id || null, action, entityType, String(entityId), before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null],
    );
  }

  async listAudit(limit = 100) {
    return rows(await this.sql.query("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT $1", [limit]));
  }

  async enqueueNotification(data) {
    const result = await this.sql.query(
      `INSERT INTO notification_outbox(recipient,template,payload,send_after) VALUES($1,$2,$3::jsonb,$4) RETURNING *`,
      [data.recipient, data.template, JSON.stringify(data.payload || {}), data.sendAfter || new Date().toISOString()],
    );
    return camel(result[0]);
  }

  async listDueNotifications() {
    return rows(await this.sql.query(
      "SELECT * FROM notification_outbox WHERE (status='pending' OR (status='failed' AND attempts<3)) AND send_after<=now() ORDER BY send_after LIMIT 100",
    ));
  }

  async markNotification(id, status, error = null) {
    const result = await this.sql.query(
      `UPDATE notification_outbox SET status=$2,error=$3,attempts=attempts+1,updated_at=now() WHERE id=$1 RETURNING *`,
      [id, status, error],
    );
    if (!result[0]) throw notFound("Notification");
    return camel(result[0]);
  }
}
