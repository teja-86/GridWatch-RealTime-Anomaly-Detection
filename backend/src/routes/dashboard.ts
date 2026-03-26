import { Router } from "express";
import { pool } from "../db";
import { getActorContext } from "../auth";

export const dashboardRouter = Router();

dashboardRouter.get("/sensors", async (req, res) => {
  try {
    const ctx = await getActorContext(req);

    const rowsRes = await pool.query(
      `
      SELECT
        s.id AS sensor_id,
        z.name AS zone_name,
        COALESCE(st.state::text, 'healthy') AS state
      FROM sensors s
      JOIN zones z ON z.id = s.zone_id
      LEFT JOIN sensor_state st ON st.sensor_id = s.id
      WHERE (
        $1::text = 'supervisor'
        OR s.zone_id = ANY($2::uuid[])
      )
      ORDER BY z.name, s.id
      `,
      [ctx.role, ctx.zoneIds]
    );

    res.json({
      sensors: rowsRes.rows.map((r: any) => ({
        sensorId: r.sensor_id,
        zoneName: r.zone_name,
        state: r.state,
      })),
    });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "Bad request" });
  }
});

