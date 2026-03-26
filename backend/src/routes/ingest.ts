import { Router } from "express";
import { z } from "zod";
import { pool } from "../db";
import { getActorContext } from "../auth";

const ReadingSchema = z.object({
  sensor_id: z.string().uuid(),
  timestamp: z.string().datetime(),
  voltage: z.number(),
  current: z.number(),
  temperature: z.number(),
  status_code: z.number().int(),
});

const IngestSchema = z.object({
  batchId: z.string().uuid().optional(),
  readings: z.array(ReadingSchema).min(1).max(1000),
});

export const ingestRouter = Router();

ingestRouter.post("/", async (req, res) => {
  try {
    const body = IngestSchema.parse(req.body);
    const ctx = await getActorContext(req);

    const readings = body.readings;
    const sensorIds = Array.from(new Set(readings.map((r) => r.sensor_id)));

    // Zone isolation: operators can only ingest for sensors in their zones.
    if (ctx.role === "operator") {
      const allowed = await pool.query(
        `SELECT id FROM sensors WHERE id = ANY($1::uuid[]) AND zone_id = ANY($2::uuid[])`,
        [sensorIds, ctx.zoneIds]
      );
      const allowedSet = new Set(allowed.rows.map((r) => r.id as string));
      for (const sid of sensorIds) {
        if (!allowedSet.has(sid)) return res.status(403).json({ error: "Forbidden sensor in zone" });
      }
    }

    const batchId = body.batchId ?? cryptoRandomUuid();
    const sensor_id = readings.map((r) => r.sensor_id);
    const timestamp = readings.map((r) => new Date(r.timestamp).toISOString());
    const voltage = readings.map((r) => r.voltage);
    const current = readings.map((r) => r.current);
    const temperature = readings.map((r) => r.temperature);
    const status_code = readings.map((r) => r.status_code);

    // Durably store before responding; anomaly detection is async via workers.
    await pool.query(
      `
      WITH input AS (
        SELECT
          UNNEST($1::uuid[]) AS sensor_id,
          UNNEST($2::timestamptz[]) AS ts,
          UNNEST($3::numeric[]) AS voltage,
          UNNEST($4::numeric[]) AS current,
          UNNEST($5::numeric[]) AS temperature,
          UNNEST($6::int[]) AS status_code
      )
      INSERT INTO readings(sensor_id, timestamp, voltage, current, temperature, status_code, processing_state, retry_count)
      SELECT
        sensor_id, ts, voltage, current, temperature, status_code, 'queued'::processing_state, 0
      FROM input
      `,
      [sensor_id, timestamp, voltage, current, temperature, status_code]
    );

    // Update last reading for rule C detection.
    await pool.query(
      `
      WITH input AS (
        SELECT * FROM UNNEST($1::uuid[], $2::timestamptz[]) AS t(sensor_id, ts)
      ),
      latest AS (
        SELECT sensor_id, MAX(ts) AS last_timestamp
        FROM input
        GROUP BY sensor_id
      )
      INSERT INTO sensor_last_reading(sensor_id, last_timestamp)
      SELECT sensor_id, last_timestamp FROM latest
      ON CONFLICT (sensor_id) DO UPDATE SET
        last_timestamp = GREATEST(sensor_last_reading.last_timestamp, EXCLUDED.last_timestamp),
        updated_at = now()
      `,
      [sensor_id, timestamp]
    );

    res.status(200).json({ ok: true, batchId, accepted: readings.length });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "Bad request" });
  }
});

function cryptoRandomUuid(): string {
  // crypto.randomUUID is available in Node >= 14
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require("crypto");
  return crypto.randomUUID();
}

