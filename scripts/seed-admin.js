import "dotenv/config";

const email = "sportscomm@iiml.ac.in";
const supabaseUrl = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const password = process.env.ADMIN_SEED_PASSWORD || email;

if (!supabaseUrl || !serviceKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required to seed the administrator");
}

const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
const list = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=1&per_page=1000`, { headers });
if (!list.ok) throw new Error(`Unable to inspect Supabase Auth users (${list.status})`);
const payload = await list.json();
const users = Array.isArray(payload) ? payload : (payload.users || []);

if (users.some((user) => String(user.email).toLowerCase() === email)) {
  console.log(`Administrator ${email} already exists; no changes made.`);
  process.exit(0);
}

const created = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
  method: "POST",
  headers,
  body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { name: "Sports Committee" } }),
});
if (!created.ok) throw new Error(`Unable to create the administrator (${created.status})`);
console.log(`Administrator ${email} created. A password change is required at first login.`);
