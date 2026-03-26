import type { Server as SocketIOServer } from "socket.io";
import { pool, withTx } from "../db";
import { broadcastAlertUpdated } from "../realtime";

let running = false;
let cachedSupervisorId: string | null = null;

async function getSupervisorId(): Promise<string> {
  if (cachedSupervisorId) return cachedSupervisorId;
  const res = await pool.query(`SELECT id FROM app_users WHERE role='supervisor' LIMIT 1`);
  cachedSupervisorId = res.rows[0].id as string;
  return cachedSupervisorId!;
}

export async function escalationWorkerTick(io: SocketIOServer) {
  if (running) return;
  running = true;
  try {
    const supervisorId = await getSupervisorId();
    const batchSize = 100;

    const escalated = await withTx(async (client) => {
      const candidatesRes = await client.query(
        `
        SELECT a.id, a.sensor_id
        FROM alerts a
        WHERE a.current_status = 'open'
          AND a.severity = 'critical'
          AND a.suppressed = false
          AND a.escalation_status = 'none'
          AND a.created_at <= now() - interval '5 minutes'
        ORDER BY a.created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
        `,
        [batchSize]
      );

      const candidates = candidatesRes.rows as Array<{ id: string; sensor_id: string }>;
      if (candidates.length === 0) return [];

      // Reassign alerts to supervisor and mark escalation status.
      const ids = candidates.map((c) => c.id);
      await client.query(
        `
        UPDATE alerts a
        SET assigned_to_user_id = $1,
            escalation_status = 'escalated'
        WHERE a.id = ANY($2::uuid[])
        `,
        [supervisorId, ids]
      );

      // Exactly once per alert due to unique constraint on escalation_log.alert_id.
      await client.query(
        `
        INSERT INTO escalation_log(alert_id, escalated_to_user_id, note)
        SELECT id, $1::uuid, 'auto-escalation'::text
        FROM UNNEST($2::uuid[]) AS t(id)
        ON CONFLICT (alert_id) DO NOTHING
        `,
        [supervisorId, ids]
      );

      return candidates;
    });

    for (const c of escalated) {
      // Status stays 'open'; this is reassignment-only for supervisors to view.
      void broadcastAlertUpdated(io, c.sensor_id, c.id, "open");
    }
  } finally {
    running = false;
  }
}

