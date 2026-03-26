import { Router } from "express";
import { z } from "zod";
import { pool } from "../db";
import { getActorContext } from "../auth";

const BodySchema = z.object({
  sensor_id: z.string().uuid(),
  start_time: z.string().datetime(),
  end_time: z.string().datetime(),
});

export const suppressionsRouter = Router();

suppressionsRouter.post("/", async (req, res) => {
  try {
    const ctx = await getActorContext(req);
    const body = BodySchema.parse(req.body);

    const authRes = await pool.query(
      `
      SELECT 1
      FROM sensors s
      WHERE s.id = $1
      AND (
        $2::text = 'supervisor'
        OR s.zone_id = ANY($3::uuid[])
      )
      `,
      [body.sensor_id, ctx.role, ctx.zoneIds]
    );
    if (authRes.rowCount !== 1) return res.status(403).json({ error: "Forbidden sensor" });

    const insertRes = await pool.query(
      `
      INSERT INTO suppressions(sensor_id, start_time, end_time, created_by_user_id)
      VALUES($1, $2, $3, $4)
      RETURNING id, sensor_id, start_time, end_time
      `,
      [body.sensor_id, new Date(body.start_time).toISOString(), new Date(body.end_time).toISOString(), ctx.actorId]
    );

    return res.status(201).json({ ok: true, suppression: insertRes.rows[0] });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "Bad request" });
  }
});

