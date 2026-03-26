import { Pool } from "pg";
import { env } from "../src/env";

async function main() {
  const pool = new Pool({ connectionString: env.databaseUrl });
  try {
    const res = await pool.query(`SELECT 1 AS ok`);
    // eslint-disable-next-line no-console
    console.log({ ok: res.rows[0].ok === 1, databaseUrl: env.databaseUrl });
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("DB check failed", e);
  process.exit(1);
});

