// Upload volume1.pdf / volume2.pdf into Postgres (table pdf_files).
// Usage: $env:DATABASE_URL="..."; npm run upload-pdfs
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const files = { vol1: "volume1.pdf", vol2: "volume2.pdf" };

(async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS pdf_files (
    name TEXT PRIMARY KEY, data BYTEA NOT NULL, etag TEXT NOT NULL,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  for (const [name, file] of Object.entries(files)) {
    const p = path.join(__dirname, "..", file);
    if (!fs.existsSync(p)) { console.log(`skip ${file} (not found)`); continue; }
    const data = fs.readFileSync(p);
    const etag = crypto.createHash("sha1").update(data).digest("hex");
    const cur = await pool.query("SELECT etag FROM pdf_files WHERE name=$1", [name]);
    if (cur.rows[0]?.etag === etag) { console.log(`${file}: unchanged`); continue; }
    await pool.query(
      `INSERT INTO pdf_files (name,data,etag) VALUES ($1,$2,$3)
       ON CONFLICT (name) DO UPDATE SET data=EXCLUDED.data, etag=EXCLUDED.etag, uploaded_at=now()`,
      [name, data, etag]);
    console.log(`${file}: uploaded ${(data.length / 1048576).toFixed(1)} MB`);
  }
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
