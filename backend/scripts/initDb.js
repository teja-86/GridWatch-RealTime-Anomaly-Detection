"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const db_1 = require("../src/db");
async function main() {
    const schemaPath = path_1.default.join(__dirname, "..", "db", "schema.sql");
    const schema = fs_1.default.readFileSync(schemaPath, "utf8");
    // Simple idempotency: if zones exists, assume schema was already loaded.
    const check = await db_1.pool.query(`SELECT to_regclass('public.zones') as exists`);
    const exists = check.rows[0]?.exists;
    if (exists) {
        // eslint-disable-next-line no-console
        console.log("Schema already present; skipping load.");
        return;
    }
    // eslint-disable-next-line no-console
    console.log("Loading schema.sql into PostgreSQL...");
    await db_1.pool.query(schema);
    // eslint-disable-next-line no-console
    console.log("Schema loaded.");
}
main()
    .then(() => {
    db_1.pool.end().catch(() => { });
})
    .catch((e) => {
    // eslint-disable-next-line no-console
    console.error("DB init failed", e);
    db_1.pool.end().catch(() => { });
    process.exit(1);
});
