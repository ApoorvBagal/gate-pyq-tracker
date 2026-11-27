const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { Pool } = require("pg");

const { DATABASE_URL, APP_PASSWORD, SESSION_SECRET, PORT = 3000 } = process.env;
if (!DATABASE_URL || !APP_PASSWORD || !SESSION_SECRET) {
  console.error("Missing env: DATABASE_URL, APP_PASSWORD and SESSION_SECRET are required");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});

const STATUSES = ["Unsolved", "Solved", "Wrong", "Shaky"];

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS questions (
      id SERIAL PRIMARY KEY,
      qid TEXT NOT NULL,
      volume TEXT NOT NULL,
      subject TEXT NOT NULL,
      topic TEXT NOT NULL,
      exam TEXT,
      pdf_page INT,
      difficulty TEXT,
      status TEXT NOT NULL DEFAULT 'Unsolved',
      important BOOLEAN NOT NULL DEFAULT FALSE,
      last_attempted DATE,
      notes TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (volume, qid)
    )`);
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM questions");
  if (rows[0].n === 0) {
    const qs = require("./data/questions.json");
    console.log(`Seeding ${qs.length} questions...`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (let i = 0; i < qs.length; i += 500) {
        const chunk = qs.slice(i, i + 500);
        const vals = [], params = [];
        chunk.forEach((q, j) => {
          const b = j * 9;
          vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`);
          params.push(q.qid, q.volume, q.subject, q.topic, q.exam, q.pdf_page, q.difficulty, q.status, q.important);
        });
        await client.query(
          `INSERT INTO questions (qid,volume,subject,topic,exam,pdf_page,difficulty,status,important)
           VALUES ${vals.join(",")} ON CONFLICT DO NOTHING`, params);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
}

// ---- auth: one shared password -> signed cookie (90 days) ----
const COOKIE = "gate_sess";
const sign = (v) => crypto.createHmac("sha256", SESSION_SECRET).update(v).digest("hex");
function makeToken() {
  const exp = String(Date.now() + 90 * 864e5);
  return `${exp}.${sign(exp)}`;
}
function validToken(t) {
  if (!t) return false;
  const [exp, sig] = t.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = sign(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
function getCookie(req, name) {
  const m = (req.headers.cookie || "").match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : null;
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json());

app.post("/api/login", (req, res) => {
  const pw = String(req.body?.password || "");
  const a = Buffer.from(sign(pw)), b = Buffer.from(sign(APP_PASSWORD));
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "Wrong password" });
  res.setHeader("Set-Cookie",
    `${COOKIE}=${makeToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${90 * 86400}` +
    (req.secure ? "; Secure" : ""));
  res.json({ ok: true });
});
app.post("/api/logout", (req, res) => {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get("/healthz", (req, res) => res.send("ok"));

app.use("/api", (req, res, next) =>
  validToken(getCookie(req, COOKIE)) ? next() : res.status(401).json({ error: "Not logged in" }));

app.get("/api/questions", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id,qid,volume,subject,topic,exam,pdf_page,difficulty,status,important,
              to_char(last_attempted,'YYYY-MM-DD') AS last_attempted,notes
       FROM questions ORDER BY id`);
    res.json(rows);
  } catch (e) { next(e); }
});

app.patch("/api/questions/:id", async (req, res, next) => {
  try {
    const sets = [], params = [];
    const b = req.body || {};
    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status)) return res.status(400).json({ error: "Bad status" });
      params.push(b.status); sets.push(`status=$${params.length}`);
      // auto-stamp attempt date when marking attempted
      if (b.status !== "Unsolved" && b.last_attempted === undefined) sets.push("last_attempted=CURRENT_DATE");
    }
    if (b.important !== undefined) { params.push(!!b.important); sets.push(`important=$${params.length}`); }
    if (b.notes !== undefined) { params.push(String(b.notes).slice(0, 5000)); sets.push(`notes=$${params.length}`); }
    if (b.last_attempted !== undefined) { params.push(b.last_attempted || null); sets.push(`last_attempted=$${params.length}`); }
    if (!sets.length) return res.status(400).json({ error: "Nothing to update" });
    params.push(Number(req.params.id));
    const { rows } = await pool.query(
      `UPDATE questions SET ${sets.join(",")}, updated_at=now() WHERE id=$${params.length}
       RETURNING id,status,important,to_char(last_attempted,'YYYY-MM-DD') AS last_attempted,notes`, params);
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (e) { next(e); }
});

app.get("/api/export.csv", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT qid,volume,subject,topic,exam,pdf_page,difficulty,status,important,
              to_char(last_attempted,'YYYY-MM-DD') AS last_attempted,notes FROM questions ORDER BY id`);
    const esc = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const cols = Object.keys(rows[0] || {});
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=gate_pyq_progress.csv");
    res.send([cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n"));
  } catch (e) { next(e); }
});

app.use(express.static(path.join(__dirname, "public")));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: "Server error" }); });

init().then(() => app.listen(PORT, () => console.log(`Listening on ${PORT}`)))
  .catch((e) => { console.error("Init failed", e); process.exit(1); });
