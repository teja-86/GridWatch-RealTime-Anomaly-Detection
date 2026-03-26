import { Router } from "express";
import { z } from "zod";
import { pool } from "../db";
import { getActorContext } from "../auth";

const QuerySchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  page: z.string().optional(),
  pageSize: z.string().optional(),
});

export const historyRouter = Router();

historyRouter.get("/:id/history", async (req, res) => {
  try {
    const ctx = await getActorContext(req);
    const sensorId = req.params.id;
    const q = QuerySchema.parse(req.query);

    const page = Math.max(1, Number(q.page ?? "1"));
    const pageSize = Math.min(100, Math.max(1, Number(q.pageSize ?? "100")));
    const offset = (page - 1) * pageSize;

    const authRes = await pool.query(
      `SELECT s.id, s.zone_id
       FROM sensors s
       WHERE s.id = $1
       AND (
         $2::text = 'supervisor'
         OR s.zone_id = ANY($3::uuid[])
       )`,
      [sensorId, ctx.role, ctx.zoneIds]
    );
    if (authRes.rowCount !== 1) return res.status(403).json({ error: "Forbidden sensor" });

    const fromTs = new Date(q.from).toISOString();
    const toTs = new Date(q.to).toISOString();

    const totalRes = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM readings
       WHERE sensor_id = $1 AND timestamp >= $2 AND timestamp <= $3`,
      [sensorId, fromTs, toTs]
    );
    const total = totalRes.rows[0].total as number;

    const readingsRes = await pool.query(
      `
      SELECT
        r.id,
        r.timestamp,
        r.voltage,
        r.current,
        r.temperature,
        r.status_code
      FROM readings r
      WHERE r.sensor_id = $1 AND r.timestamp >= $2 AND r.timestamp <= $3
      ORDER BY r.timestamp DESC
      LIMIT $4 OFFSET $5
      `,
      [sensorId, fromTs, toTs, pageSize, offset]
    );

    const readings = readingsRes.rows;
    const readingIds = readings.map((r: any) => r.id as string);

    const anomaliesRes =
      readingIds.length === 0
        ? { rows: [] }
        : await pool.query(
            `
            SELECT
              a.reading_id,
              a.id AS anomaly_id,
              a.rule_type,
              a.metric,
              a.value,
              al.id AS alert_id,
              al.current_status,
              al.severity,
              al.suppressed
            FROM anomalies a
            LEFT JOIN alerts al ON al.anomaly_id = a.id
            WHERE a.reading_id = ANY($1::uuid[])
            `,
            [readingIds]
          );

    const byReading: Record<string, any[]> = {};
    for (const row of anomaliesRes.rows as any[]) {
      const rid = row.reading_id as string;
      if (!byReading[rid]) byReading[rid] = [];
      byReading[rid].push({
        anomalyId: row.anomaly_id,
        ruleType: row.rule_type,
        metric: row.metric,
        value: row.value,
        alert: row.alert_id
          ? {
              alertId: row.alert_id,
              status: row.current_status,
              severity: row.severity,
              suppressed: row.suppressed,
            }
          : null,
      });
    }

    return res.json({
      page,
      pageSize,
      total,
      data: readings.map((r: any) => {
        const anomalies = byReading[r.id] ?? [];
        return {
          readingId: r.id,
          timestamp: r.timestamp,
          voltage: r.voltage,
          current: r.current,
          temperature: r.temperature,
          statusCode: r.status_code,
          triggeredAnomaly: anomalies.length > 0,
          anomalies,
        };
      }),
    });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "Bad request" });
  }
});

