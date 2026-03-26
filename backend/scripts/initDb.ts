import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { env } from "../src/env";

async function main() {
  // Ensure target database exists (helps local dev without docker-compose).
  // We connect to the admin database first (usually "postgres") to create the DB if missing.
  const url = new URL(env.databaseUrl);
  const targetDb = url.pathname.replace(/^\//, "");
  const adminUrl = new URL(env.databaseUrl);
  adminUrl.pathname = "/postgres";

  const adminPool = new Pool({ connectionString: adminUrl.toString() });
  try {
    const existsRes = await adminPool.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [targetDb]
    );
    if (existsRes.rowCount === 0) {
      // eslint-disable-next-line no-console
      console.log(`Creating database "${targetDb}"...`);
      // Database name cannot be a bind parameter in CREATE DATABASE.
      await adminPool.query(`CREATE DATABASE "${targetDb.replace(/"/g, "\"\"")}"`);
      // eslint-disable-next-line no-console
      console.log(`Database "${targetDb}" created.`);
    }
  } finally {
    await adminPool.end().catch(() => {});
  }

  const pool = new Pool({ connectionString: env.databaseUrl });
  const schemaPath = path.join(__dirname, "..", "db", "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf8");

  // Simple idempotency: if zones exists, assume schema was already loaded.
  const check = await pool.query(`SELECT to_regclass('public.zones') as exists`);
  const exists = check.rows[0]?.exists;
  if (exists) {
    // eslint-disable-next-line no-console
    console.log("Schema already present; skipping load.");
    return;
  }

  // eslint-disable-next-line no-console
  console.log("Loading schema.sql into PostgreSQL...");
  await pool.query(schema);
  // eslint-disable-next-line no-console
  console.log("Schema loaded.");

  await pool.end().catch(() => {});
}

main()
  .then(() => {
  })
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error("DB init failed", e);
    process.exit(1);
  });

