import { Router } from "express";
import { z } from "zod";
import { pool } from "../db";
import { getActorContext } from "../auth";
import { getRealtimeIo, broadcastAlertUpdated } from "../realtime";
import { refreshSensorState } from "../services/sensorState";

const ListQuerySchema = z.object({
  status: z.enum(["open", "acknowledged", "resolved"]).optional(),
  severity: z.enum(["warning", "critical"]).optional(),
  sensorId: z.string().uuid().optional(),
  page: z.string().optional(),
  pageSize: z.string().optional(),
});

const ActorBodySchema = z.object({
  actorId: z.string().uuid().optional(),
});

const TransitionBodySchema = z.object({
  // If omitted, server uses x-actor-id for zone-scoped authorization.
  actorId: z.string().uuid().optional(),
});

export const alertsRouter = Router();

alertsRouter.post("/", async (req, res) => {
  try {
    const ctx = await getActorContext(req);
    const body = z.object({ anomalyId: z.string().uuid() }).parse(req.body);
    const anomalyId = body.anomalyId;

    // Derive sensor + severity and enforce zone isolation.
    const createRes = await pool.query(
      `
      WITH an AS (
        SELECT a.id, a.sensor_id, a.timestamp, a.rule_type, a.metric
        FROM anomalies a
        WHERE a.id = $1
      ),
      auth AS (
        SELECT an.*
        FROM an
        JOIN sensors s ON s.id = an.sensor_id
        WHERE (
          $2::text = 'supervisor'
          OR s.zone_id = ANY($3::uuid[])
        )
      ),
      computed AS (
        SELECT
          auth.id AS anomaly_id,
          auth.sensor_id,
          auth.timestamp,
          CASE
            WHEN auth.rule_type = 'A' THEN tc.severity
            WHEN auth.rule_type = 'B' THEN rc.severity
            WHEN auth.rule_type = 'C' THEN pac.severity
          END AS severity,
          zo.operator_user_id AS assigned_to_user_id,
          EXISTS(
            SELECT 1
            FROM suppressions sp
            WHERE sp.sensor_id = auth.sensor_id
              AND sp.start_time <= auth.timestamp
              AND sp.end_time >= auth.timestamp
          ) AS suppressed
        FROM auth
        LEFT JOIN threshold_configs tc ON tc.sensor_id = auth.sensor_id AND tc.metric = auth.metric
        LEFT JOIN rate_of_change_configs rc ON rc.sensor_id = auth.sensor_id
        LEFT JOIN pattern_absence_configs pac ON pac.sensor_id = auth.sensor_id
        JOIN zone_operators zo ON zo.zone_id = (SELECT zone_id FROM sensors WHERE id = auth.sensor_id)
      )
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
        anomaly_id,
        sensor_id,
        timestamp,
        'open',
        severity,
        assigned_to_user_id,
        suppressed,
        NOT suppressed
      FROM computed
      ON CONFLICT (anomaly_id) DO NOTHING
      RETURNING id
      `,
      [anomalyId, ctx.role, ctx.zoneIds]
    );

    if (createRes.rowCount === 0) {
      return res.status(200).json({ ok: true, alertId: null, reason: "Already exists or forbidden" });
    }
    res.status(201).json({ ok: true, alertId: createRes.rows[0].id as string });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "Bad request" });
  }
});

alertsRouter.post("/:id/transition", async (req, res) => {
  try {
    const ctx = await getActorContext(req);
    const body = z
      .object({ newStatus: z.enum(["acknowledged", "resolved"]), actorId: z.string().uuid().optional() })
      .parse(req.body);
    const actorId = body.actorId ?? ctx.actorId;

    const result = await transitionAlert({
      actorId,
      alertId: req.params.id,
      nextStatus: body.newStatus,
      ctx,
    });
    res.json(result);
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "Bad request" });
  }
});

alertsRouter.get("/", async (req, res) => {
  try {
    const ctx = await getActorContext(req);
    const q = ListQuerySchema.parse(req.query);
    const page = Math.max(1, Number(q.page ?? "1"));
    const pageSize = Math.min(100, Math.max(1, Number(q.pageSize ?? "50")));
    const offset = (page - 1) * pageSize;

    const whereParts: string[] = [];
    const params: any[] = [];

    // Zone isolation via sensors join
    if (ctx.role === "operator") {
      whereParts.push(`s.zone_id = ANY($${params.length + 1}::uuid[])`);
      params.push(ctx.zoneIds);
    }
    if (q.sensorId) {
      whereParts.push(`a.sensor_id = $${params.length + 1}`);
      params.push(q.sensorId);
    }
    if (q.status) {
      whereParts.push(`a.current_status = $${params.length + 1}`);
      params.push(q.status);
    }
    if (q.severity) {
      whereParts.push(`a.severity = $${params.length + 1}`);
      params.push(q.severity);
    }

    const where = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

    const totalRes = await pool.query(
      `
      SELECT COUNT(*)::int AS total
      FROM alerts a
      JOIN sensors s ON s.id = a.sensor_id
      ${where}
      `,
      params
    );
    const total = totalRes.rows[0].total as number;

    const rowsRes = await pool.query(
      `
      SELECT
        a.id,
        a.anomaly_id,
        a.sensor_id,
        a.timestamp,
        a.current_status,
        a.severity,
        a.suppressed,
        a.assigned_to_user_id,
        a.created_at
      FROM alerts a
      JOIN sensors s ON s.id = a.sensor_id
      ${where}
      ORDER BY a.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `,
      [...params, pageSize, offset]
    );

    res.json({
      page,
      pageSize,
      total,
      data: rowsRes.rows,
    });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "Bad request" });
  }
});

alertsRouter.post("/:id/acknowledge", async (req, res) => {
  try {
    const ctx = await getActorContext(req);
    const body = TransitionBodySchema.parse(req.body);
    const actorId = body.actorId ?? ctx.actorId;

    const alertId = req.params.id;
    const result = await transitionAlert({
      actorId,
      alertId,
      nextStatus: "acknowledged",
      ctx,
    });
    res.json(result);
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "Bad request" });
  }
});

alertsRouter.post("/:id/resolve", async (req, res) => {
  try {
    const ctx = await getActorContext(req);
    const body = TransitionBodySchema.parse(req.body);
    const actorId = body.actorId ?? ctx.actorId;
    const alertId = req.params.id;

    const result = await transitionAlert({
      actorId,
      alertId,
      nextStatus: "resolved",
      ctx,
    });
    res.json(result);
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "Bad request" });
  }
});

async function transitionAlert(params: {
  actorId: string;
  alertId: string;
  nextStatus: "acknowledged" | "resolved";
  ctx: { actorId: string; role: "operator" | "supervisor"; zoneIds: string[] };
}) {
  // Validate zone access
  const accessRes = await pool.query(
    `
    SELECT a.id, a.sensor_id, a.current_status, a.suppressed
    FROM alerts a
    JOIN sensors s ON s.id = a.sensor_id
    WHERE a.id = $1
    AND (
      $2::text = 'supervisor' OR s.zone_id = ANY($3::uuid[])
    )
    `,
    [params.alertId, params.ctx.role, params.ctx.zoneIds]
  );
  if (accessRes.rowCount !== 1) throw new Error("Forbidden alert");

  const currentStatus = accessRes.rows[0].current_status as "open" | "acknowledged" | "resolved";

  const allowed =
    params.nextStatus === "acknowledged"
      ? currentStatus === "open"
      : params.nextStatus === "resolved"
        ? currentStatus === "open" || currentStatus === "acknowledged"
        : false;

  if (!allowed) throw new Error(`Invalid status transition from ${currentStatus} to ${params.nextStatus}`);

  const updated = await pool.query(
    `
    WITH upd AS (
      UPDATE alerts
      SET
        current_status = $1::alert_status,
        acknowledged_at = CASE WHEN $1::alert_status = 'acknowledged' THEN now() ELSE acknowledged_at END,
        resolved_at = CASE WHEN $1::alert_status = 'resolved' THEN now() ELSE resolved_at END,
        last_status_update_by = $2::uuid,
        last_status_update_at = now()
      WHERE id = $3
      RETURNING id, sensor_id, current_status
    )
    INSERT INTO alert_status_transitions(alert_id, from_status, to_status, changed_by_user_id, changed_at)
    SELECT id, $4::alert_status, $1::alert_status, $2::uuid, now()
    FROM upd
    RETURNING id, (SELECT sensor_id FROM upd WHERE upd.id = alert_status_transitions.alert_id) AS sensor_id
    `,
    [params.nextStatus, params.actorId, params.alertId, currentStatus]
  );

  const sensorId = updated.rows[0]?.sensor_id as string | undefined;

  const io = getRealtimeIo();
  if (io && sensorId) {
    await refreshSensorState(sensorId, io);
    void broadcastAlertUpdated(io, sensorId, params.alertId, params.nextStatus);
  }

  return { ok: true, alertId: params.alertId };
}

