import type { Server as SocketIOServer } from "socket.io";
import { pool, withTx } from "../db";
import { refreshSensorState } from "../services/sensorState";
import { broadcastAlertCreated } from "../realtime";

type ReadingRow = {
  id: string;
  sensor_id: string;
  timestamp: string;
  voltage: number;
  current: number;
  temperature: number;
};

let running = false;

export async function anomalyWorkerTick(io: SocketIOServer) {
  if (running) return;
  running = true;
  try {
    const maxRetries = 5;
    const batchSize = 50;

    const readingRowsRes = await pool.query(
      `
      WITH cte AS (
        SELECT r.id
        FROM readings r
        WHERE (r.processing_state = 'queued' OR r.processing_state = 'failed')
          AND r.retry_count < $1
        ORDER BY r.timestamp ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      UPDATE readings r
      SET processing_state = 'processing'
      FROM cte
      WHERE r.id = cte.id
      RETURNING
        r.id,
        r.sensor_id,
        r.timestamp,
        r.voltage,
        r.current,
        r.temperature
      `,
      [maxRetries, batchSize]
    );

    const readings = readingRowsRes.rows as ReadingRow[];
    if (readings.length === 0) return;

    const impactedSensors = new Set<string>();

    for (const reading of readings) {
      try {
        await withTx(async (client) => {
          const [operatorRes, suppressedRes] = await Promise.all([
            client.query(
            `
            SELECT zo.operator_user_id
            FROM sensors s
            JOIN zone_operators zo ON zo.zone_id = s.zone_id
            WHERE s.id = $1
            `,
              [reading.sensor_id]
            ),
            client.query(
            `
            SELECT EXISTS(
              SELECT 1
              FROM suppressions sp
              WHERE sp.sensor_id = $1
                AND sp.start_time <= $2
                AND sp.end_time >= $2
            ) AS suppressed
            `,
              [reading.sensor_id, reading.timestamp]
            ),
          ]);

          const operator_user_id =
            operatorRes.rows[0]?.operator_user_id as string | undefined;
          if (!operator_user_id) throw new Error("Zone operator not configured");

          const suppressed = suppressedRes.rows[0]?.suppressed as boolean;
          const notifications_enabled = !suppressed;

          // Rule A: threshold breach for voltage and temperature
          const thrRes = await client.query(
          `
          SELECT metric, min_value, max_value, severity
          FROM threshold_configs
          WHERE sensor_id = $1
          `,
            [reading.sensor_id]
          );

          for (const row of thrRes.rows as any[]) {
            const metric = row.metric as "voltage" | "temperature";
            const min = Number(row.min_value);
            const max = Number(row.max_value);
            const severity = row.severity as "warning" | "critical";
            const value =
              metric === "voltage" ? Number(reading.voltage) : Number(reading.temperature);
            const isBreach = value < min || value > max;
            if (!isBreach) continue;

            const anomalyRes = await client.query(
            `
            INSERT INTO anomalies(sensor_id, reading_id, timestamp, rule_type, metric, value)
            VALUES($1,$2,$3,'A',$4,$5)
            RETURNING id
            `,
              [reading.sensor_id, reading.id, reading.timestamp, metric, value]
            );
            const anomalyId = anomalyRes.rows[0].id as string;

            const alertRes = await client.query(
            `
            INSERT INTO alerts(anomaly_id, sensor_id, timestamp, current_status, severity, assigned_to_user_id, suppressed, notifications_enabled)
            VALUES($1,$2,$3,'open',$4,$5,$6,$7)
            RETURNING id
            `,
              [
                anomalyId,
                reading.sensor_id,
                reading.timestamp,
                severity,
                operator_user_id,
                suppressed,
                notifications_enabled,
              ]
            );
            if (notifications_enabled) {
              const alertId = alertRes.rows[0].id as string;
              // Broadcast quickly; dashboard state update happens below once per sensor.
              void broadcastAlertCreated(io, reading.sensor_id, alertId, severity, "open");
            }
          }

          // Rule B: rate-of-change spikes
          const rateRes = await client.query(
          `
          SELECT threshold_pct, severity
          FROM rate_of_change_configs
          WHERE sensor_id = $1
          `,
            [reading.sensor_id]
          );
          const rateCfg = rateRes.rows[0] as any | undefined;
          if (rateCfg) {
            const thresholdPct = Number(rateCfg.threshold_pct);
            const severity = rateCfg.severity as "warning" | "critical";

            const avgRes = await client.query(
            `
            SELECT
              avg(voltage)  AS avg_voltage,
              avg(current)  AS avg_current,
              avg(temperature) AS avg_temperature
            FROM (
              SELECT voltage, current, temperature
              FROM readings
              WHERE sensor_id = $1 AND timestamp < $2
              ORDER BY timestamp DESC
              LIMIT 3
            ) t
            `,
              [reading.sensor_id, reading.timestamp]
            );
            const avgRow = avgRes.rows[0] as any;
            const avgVoltage = avgRow.avg_voltage as number | null;
            const avgCurrent = avgRow.avg_current as number | null;
            const avgTemperature = avgRow.avg_temperature as number | null;

            const metricChecks: Array<{
              metric: "voltage" | "current" | "temperature";
              value: number;
              avg: number | null;
            }> = [
              { metric: "voltage", value: Number(reading.voltage), avg: avgVoltage },
              { metric: "current", value: Number(reading.current), avg: avgCurrent },
              { metric: "temperature", value: Number(reading.temperature), avg: avgTemperature },
            ];

            for (const m of metricChecks) {
              if (m.avg === null) continue;
              const avg = Number(m.avg);
              if (avg === 0) continue;
              const pct = (Math.abs(m.value - avg) / Math.abs(avg)) * 100;
              if (pct <= thresholdPct) continue;

              const anomalyRes = await client.query(
              `
              INSERT INTO anomalies(sensor_id, reading_id, timestamp, rule_type, metric, value)
              VALUES($1,$2,$3,'B',$4,$5)
              RETURNING id
              `,
                [reading.sensor_id, reading.id, reading.timestamp, m.metric, m.value]
              );
              const anomalyId = anomalyRes.rows[0].id as string;

              const alertRes = await client.query(
              `
              INSERT INTO alerts(anomaly_id, sensor_id, timestamp, current_status, severity, assigned_to_user_id, suppressed, notifications_enabled)
              VALUES($1,$2,$3,'open',$4,$5,$6,$7)
              RETURNING id
              `,
                [
                  anomalyId,
                  reading.sensor_id,
                  reading.timestamp,
                  severity,
                  operator_user_id,
                  suppressed,
                  notifications_enabled,
                ]
              );

              const alertId = alertRes.rows[0].id as string;
              if (notifications_enabled) {
                void broadcastAlertCreated(io, reading.sensor_id, alertId, severity, "open");
              }
            }
          }

          await client.query(
            `
            UPDATE readings
            SET processing_state = 'done', retry_count = retry_count, last_error = NULL
            WHERE id = $1
            `,
            [reading.id]
          );
        });

        impactedSensors.add(reading.sensor_id);
      } catch (e: any) {
        const msg = e?.message ? String(e.message) : "processing error";
        await pool.query(
          `
          UPDATE readings
          SET processing_state = 'failed',
              retry_count = retry_count + 1,
              last_error = $2
          WHERE id = $1
          `,
          [reading.id, msg]
        );
      }
    }

    // Update and broadcast sensor state once per impacted sensor.
    for (const sensorId of impactedSensors) {
      await refreshSensorState(sensorId, io);
    }
  } finally {
    running = false;
  }
}

