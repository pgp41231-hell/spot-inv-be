import { neon } from "@neondatabase/serverless";
import { conflict, notFound } from "../errors.js";

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
    this.sql = neon(databaseUrl);
  }

  async close() {}

  async ensureUser(user) {
    const result = await this.sql.query(
      `INSERT INTO app_users (id,email,name,role) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email,name=EXCLUDED.name,updated_at=now()
       RETURNING *`,
      [user.id, user.email, user.name, user.role],
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

  async setUserRole(id, role) {
    const result = await this.sql.query(
      "UPDATE app_users SET role=$2,updated_at=now() WHERE id=$1 RETURNING *", [id, role],
    );
    if (!result[0]) throw notFound("User");
    return camel(result[0]);
  }

  resourceMeta(type) {
    return type === "venue"
      ? { table: "venues", json: ["amenities", "rules"], fields: ["name", "category", "location", "capacity", "amenities", "rules", "active"] }
      : { table: "equipment_items", json: ["metadata"], fields: ["name", "category", "location", "quantity", "condition", "metadata", "active"] };
  }

  async listResources(type, filters = {}) {
    const { table } = this.resourceMeta(type);
    const clauses = [];
    const values = [];
    const add = (sql, value) => { values.push(value); clauses.push(sql.replace("?", `$${values.length}`)); };
    if (filters.active !== undefined) add("active=?", filters.active);
    if (filters.category) add("category=?", filters.category);
    if (filters.minCapacity) add(type === "venue" ? "capacity>=?" : "quantity>=?", filters.minCapacity);
    if (filters.q) {
      values.push(filters.q);
      clauses.push(`(name ILIKE '%' || $${values.length} || '%' OR COALESCE(location,'') ILIKE '%' || $${values.length} || '%')`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return rows(await this.sql.query(`SELECT * FROM ${table} ${where} ORDER BY name`, values));
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
      `INSERT INTO ${meta.table} (${fields.join(",")}) VALUES (${placeholders}) RETURNING *`, values,
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
    const set = fields.map((field, index) => `${field}=$${index + 1}`).join(",");
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

  async hasConflict({ resourceType, resourceId, startAt, endAt, excludeBookingId, quantity = 1 }) {
    const result = await this.sql.query(
      `SELECT 'booking' AS conflict_type,id,start_at,end_at,status
       FROM bookings WHERE $1='venue' AND resource_type=$1 AND resource_id=$2
       AND id <> COALESCE($5::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
       AND status NOT IN ('cancelled','rejected') AND start_at < $4 AND end_at > $3
       UNION ALL
       SELECT 'blackout' AS conflict_type,id,start_at,end_at,'blocked' AS status
       FROM blackouts WHERE resource_type=$1 AND (resource_id IS NULL OR resource_id=$2)
       AND start_at < $4 AND end_at > $3 LIMIT 1`,
      [resourceType, resourceId, startAt, endAt, excludeBookingId || null],
    );
    if (result[0]) return camel(result[0]);
    if (resourceType === "equipment") {
      const stock = await this.sql.query("SELECT quantity FROM equipment_items WHERE id=$1 AND active", [resourceId]);
      if (!stock[0]) throw notFound("Equipment item");
      const used = await this.sql.query(
        `SELECT COALESCE(sum(quantity),0)::int AS used FROM bookings
         WHERE resource_type='equipment' AND resource_id=$1
         AND id <> COALESCE($4::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
         AND status NOT IN ('cancelled','rejected') AND start_at < $3 AND end_at > $2`,
        [resourceId, startAt, endAt, excludeBookingId || null],
      );
      if (Number(used[0].used) + Number(quantity) > Number(stock[0].quantity)) {
        return { conflictType: "insufficient_stock", available: Number(stock[0].quantity) - Number(used[0].used) };
      }
    }
    return null;
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
    const existing = await this.hasConflict(data);
    if (existing) throw conflict("The resource is unavailable for that time", { conflict: existing });
    const steps = await this.resolveApprovalSteps(data.resourceType, data.resourceId);
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
      if (error.constraint === "no_overlapping_venue_booking") {
        throw conflict("The venue is unavailable for that time");
      }
      throw error;
    }
  }

  async updateBooking(id, data, actor) {
    const before = await this.getBooking(id);
    const next = { ...before, ...data };
    const existing = await this.hasConflict({ ...next, excludeBookingId: id });
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
