import { pool } from "../db";
import { SensorState, broadcastSensorState } from "../realtime";
import type { Server as SocketIOServer } from "socket.io";

export async function refreshSensorState(
  sensorId: string,
  io: SocketIOServer
): Promise<{ changed: boolean; newState: SensorState }> {
  const stateRes = await pool.query(
    `
    WITH
    hasSilent AS (
      SELECT 1
      FROM alerts a
      JOIN anomalies an ON an.id = a.anomaly_id
      WHERE a.sensor_id = $1
        AND a.current_status = 'open'
        AND a.suppressed = false
        AND an.rule_type = 'C'
      LIMIT 1
    ),
    hasCritical AS (
      SELECT 1
      FROM alerts a
      WHERE a.sensor_id = $1
        AND a.current_status = 'open'
        AND a.suppressed = false
        AND a.severity = 'critical'
      LIMIT 1
    ),
    hasWarning AS (
      SELECT 1
      FROM alerts a
      WHERE a.sensor_id = $1
        AND a.current_status = 'open'
        AND a.suppressed = false
        AND a.severity = 'warning'
      LIMIT 1
    )
    SELECT
      CASE
        WHEN EXISTS (SELECT 1 FROM hasSilent) THEN 'silent'::sensor_state_enum
        WHEN EXISTS (SELECT 1 FROM hasCritical) THEN 'critical'::sensor_state_enum
        WHEN EXISTS (SELECT 1 FROM hasWarning) THEN 'warning'::sensor_state_enum
        ELSE 'healthy'::sensor_state_enum
      END AS computed_state
    `,
    [sensorId]
  );
  const computed = stateRes.rows[0].computed_state as SensorState;

  const prevRes = await pool.query(`SELECT state FROM sensor_state WHERE sensor_id = $1`, [sensorId]);
  const prev = (prevRes.rowCount ? (prevRes.rows[0].state as SensorState) : "healthy") as SensorState;

  if (prev === computed) return { changed: false, newState: computed };

  await pool.query(
    `
    INSERT INTO sensor_state(sensor_id, state)
    VALUES($1, $2)
    ON CONFLICT (sensor_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()
    `,
    [sensorId, computed]
  );

  await broadcastSensorState(io, sensorId, computed);

  return { changed: true, newState: computed };
}

