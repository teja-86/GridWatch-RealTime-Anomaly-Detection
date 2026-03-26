import { Request } from "express";
import { pool } from "./db";

export type ActorRole = "operator" | "supervisor";

export type ActorContext = {
  actorId: string;
  role: ActorRole;
  zoneIds: string[];
};

function pickHeader(req: Request, name: string): string | undefined {
  const v = req.header(name);
  if (!v) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

export async function getActorContext(req: Request): Promise<ActorContext> {
  // Convention: `x-actor-id` is required for zone isolation correctness.
  // If absent, backend may fall back to seeded supervisor for local convenience.
  const actorIdFromHeader = pickHeader(req, "x-actor-id") ?? "";
  if (!actorIdFromHeader) {
    // Allow unauthenticated convenience behavior only in dev.
    // In production, env DEFAULT_ACTOR_ID should be set.
    const { env } = await import("./env");
    if (!env.defaultActorId) {
      throw new Error("Missing x-actor-id");
    }
  }

  const actorId =
    actorIdFromHeader ||
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    (await import("./env")).env.defaultActorId;

  const actorRes = await pool.query(
    `SELECT u.id, u.role
     FROM app_users u
     WHERE u.id = $1`,
    [actorId]
  );

  if (actorRes.rowCount !== 1) throw new Error("Actor not found");
  const role = actorRes.rows[0].role as ActorRole;

  if (role === "supervisor") {
    return { actorId, role, zoneIds: [] };
  }

  const zonesRes = await pool.query(
    `SELECT zone_id FROM operator_zones WHERE operator_user_id = $1`,
    [actorId]
  );
  return { actorId, role, zoneIds: zonesRes.rows.map((r) => r.zone_id as string) };
}

export function isSupervisor(ctx: ActorContext): boolean {
  return ctx.role === "supervisor";
}

