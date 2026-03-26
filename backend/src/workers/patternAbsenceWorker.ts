import type { Server as SocketIOServer } from "socket.io";
import { pool } from "../db";
import { refreshSensorState } from "../services/sensorState";
import { broadcastAlertCreated, broadcastAlertUpdated } from "../realtime";

let running = false;
let cachedSupervisorId: string | null = null;

async function getSupervisorId(): Promise<string> {
  if (cachedSupervisorId) return cachedSupervisorId;
  const res = await pool.query(`SELECT id FROM app_users WHERE role='supervisor' LIMIT 1`);
  cachedSupervisorId = res.rows[0].id as string;
  return cachedSupervisorId!;
}

export async function patternAbsenceWorkerTick(io: SocketIOServer) {
  if (running) return;
  running = true;
  try {
    const supervisorId = await getSupervisorId();

    const createdRes = await pool.query(
      `
      WITH silent AS (
        SELECT
          s.id AS sensor_id,
          pc.silence_seconds,
          pc.severity
        FROM sensors s
        JOIN sensor_last_reading slr ON slr.sensor_id = s.id
        JOIN pattern_absence_configs pc ON pc.sensor_id = s.id
        WHERE slr.last_timestamp <= now() - (pc.silence_seconds || ' seconds')::interval
      ),
      to_insert AS (
        SELECT
          si.sensor_id,
          (SELECT r.id
           FROM readings r
           WHERE r.sensor_id = si.sensor_id
             AND r.timestamp <= (SELECT slr2.last_timestamp FROM sensor_last_reading slr2 WHERE slr2.sensor_id = si.sensor_id)
           ORDER BY r.timestamp DESC
           LIMIT 1) AS reading_id,
          now() AS ts,
          'C' AS rule_type,
          NULL::text AS metric,
          NULL::numeric AS value,
          to_timestamp(
            floor(extract(epoch from now()) / si.silence_seconds) * si.silence_seconds
          ) AS period_start_time,
          si.severity
        FROM silent si
      ),
      ins AS (
        INSERT INTO anomalies(sensor_id, reading_id, timestamp, rule_type, metric, value, period_start_time)
        SELECT sensor_id, reading_id, ts, rule_type, metric, value, period_start_time
        FROM to_insert
        WHERE reading_id IS NOT NULL
        ON CONFLICT (sensor_id, rule_type, period_start_time) DO NOTHING
        RETURNING id, sensor_id
      ),
      alerts_ins AS (
        INSERT INTO alerts(
          anomaly_id,
          sensor_id,
          timestamp,
          current_status,
          severity,
          assigned_to_user_id,
          suppressed,
          notifications_enabled
        )
        SELECT
          ins.id,
          ins.sensor_id,
          now(),
          'open',
          pac.severity,
          zo.operator_user_id,
          COALESCE(sp.suppressed, false) AS suppressed,
          NOT COALESCE(sp.suppressed, false) AS notifications_enabled
        FROM ins
        JOIN sensors s ON s.id = ins.sensor_id
        JOIN zone_operators zo ON zo.zone_id = s.zone_id
        JOIN pattern_absence_configs pac ON pac.sensor_id = ins.sensor_id
        LEFT JOIN LATERAL (
          SELECT EXISTS(
            SELECT 1
            FROM suppressions sp2
            WHERE sp2.sensor_id = ins.sensor_id
              AND sp2.start_time <= now()
              AND sp2.end_time >= now()
          ) AS suppressed
        ) sp ON true
        ON CONFLICT (anomaly_id) DO NOTHING
        RETURNING id AS alert_id, sensor_id, severity, suppressed, notifications_enabled
      )
      SELECT alert_id, sensor_id, severity, suppressed, notifications_enabled
      FROM alerts_ins
      `,
      []
    );

    const createdAlerts = createdRes.rows as Array<{
      alert_id: string;
      sensor_id: string;
      severity: "warning" | "critical";
      suppressed: boolean;
      notifications_enabled: boolean;
    }>;

    const resolvedRes = await pool.query(
      `
      WITH recovered AS (
        SELECT
          s.id AS sensor_id
        FROM sensors s
        JOIN sensor_last_reading slr ON slr.sensor_id = s.id
        JOIN pattern_absence_configs pc ON pc.sensor_id = s.id
        WHERE slr.last_timestamp > now() - (pc.silence_seconds || ' seconds')::interval
      ),
      to_resolve AS (
        SELECT
          a.id AS alert_id,
          a.sensor_id,
          a.current_status AS from_status
        FROM alerts a
        JOIN anomalies an ON an.id = a.anomaly_id
        JOIN recovered r ON r.sensor_id = a.sensor_id
        WHERE an.rule_type = 'C'
          AND a.current_status IN ('open','acknowledged')
      ),
      upd AS (
        UPDATE alerts a
        SET current_status = 'resolved',
            resolved_at = now(),
            last_status_update_by = $1,
            last_status_update_at = now()
        FROM to_resolve t
        WHERE a.id = t.alert_id
        RETURNING a.id AS alert_id, t.sensor_id, t.from_status
      ),
      ins AS (
        INSERT INTO alert_status_transitions(alert_id, from_status, to_status, changed_by_user_id, changed_at)
        SELECT
          upd.alert_id,
          upd.from_status::alert_status,
          'resolved'::alert_status,
          $1::uuid,
          now()
        FROM upd
        RETURNING alert_id
      )
      SELECT alert_id, sensor_id, from_status
      FROM upd
      `,
      [supervisorId]
    );

    const resolvedAlerts = resolvedRes.rows as Array<{ alert_id: string; sensor_id: string; from_status: string }>;

    const impacted = new Set<string>();
    for (const a of createdAlerts) impacted.add(a.sensor_id);
    for (const a of resolvedAlerts) impacted.add(a.sensor_id);

    // Emit alert websocket events so the UI stays in sync (no polling).
    for (const a of createdAlerts) {
      if (!a.notifications_enabled) continue;
      void broadcastAlertCreated(io, a.sensor_id, a.alert_id, a.severity, "open");
    }
    for (const a of resolvedAlerts) {
      // Even if suppressed, the alert state transitioned; update UI.
      void broadcastAlertUpdated(io, a.sensor_id, a.alert_id, "resolved");
    }

    for (const sensorId of impacted) {
      await refreshSensorState(sensorId, io);
    }
  } finally {
    running = false;
  }
}

