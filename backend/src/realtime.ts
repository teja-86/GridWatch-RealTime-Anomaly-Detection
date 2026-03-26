import { Server as SocketIOServer } from "socket.io";
import { pool } from "./db";
import type { ActorContext } from "./auth";

let ioInstance: SocketIOServer | null = null;

export type SensorState = "healthy" | "warning" | "critical" | "silent";

export type RealtimeEvents = {
  "sensor_state": (payload: { sensorId: string; state: SensorState; updatedAt: string }) => void;
  "alert_created": (payload: { alertId: string; sensorId: string; severity: string; status: string }) => void;
  "alert_updated": (payload: { alertId: string; sensorId: string; status: string }) => void;
};

async function getSensorZoneId(sensorId: string): Promise<string> {
  const res = await pool.query(`SELECT zone_id FROM sensors WHERE id = $1`, [sensorId]);
  if (res.rowCount !== 1) throw new Error("Sensor not found");
  return res.rows[0].zone_id as string;
}

export function attachRealtime(io: SocketIOServer) {
  ioInstance = io;
  io.on("connection", async (socket) => {
    const actorId = (socket.handshake.query.actorId as string | undefined) ?? "";
    const actor: ActorContext | null = await (async () => {
      if (!actorId) return null;
      const roleRes = await pool.query(`SELECT id, role FROM app_users WHERE id = $1`, [actorId]);
      if (roleRes.rowCount !== 1) return null;
      const role = roleRes.rows[0].role as ActorContext["role"];
      if (role === "supervisor") return { actorId, role: "supervisor", zoneIds: [] };
      const zonesRes = await pool.query(
        `SELECT zone_id FROM operator_zones WHERE operator_user_id = $1`,
        [actorId]
      );
      return { actorId, role: "operator", zoneIds: zonesRes.rows.map((r) => r.zone_id as string) };
    })();

    // If we can't determine actor, we keep socket in a private room only.
    if (!actor) {
      socket.join(`actor:${actorId}`);
      return;
    }

    if (actor.role === "supervisor") {
      socket.join("supervisor");
      const zonesRes = await pool.query(`SELECT id FROM zones`);
      for (const z of zonesRes.rows) {
        socket.join(`zone:${z.id}`);
      }
      return;
    }

    for (const zoneId of actor.zoneIds) {
      socket.join(`zone:${zoneId}`);
    }
  });
}

export function getRealtimeIo(): SocketIOServer | null {
  return ioInstance;
}

export async function broadcastSensorState(io: SocketIOServer, sensorId: string, state: SensorState) {
  const zoneId = await getSensorZoneId(sensorId);
  io.to(`zone:${zoneId}`).emit("sensor_state", {
    sensorId,
    state,
    updatedAt: new Date().toISOString(),
  });
}

export async function broadcastAlertCreated(
  io: SocketIOServer,
  sensorId: string,
  alertId: string,
  severity: string,
  status: string
) {
  const zoneId = await getSensorZoneId(sensorId);
  io.to(`zone:${zoneId}`).emit("alert_created", { alertId, sensorId, severity, status });
}

export async function broadcastAlertUpdated(
  io: SocketIOServer,
  sensorId: string,
  alertId: string,
  status: string
) {
  const zoneId = await getSensorZoneId(sensorId);
  io.to(`zone:${zoneId}`).emit("alert_updated", { alertId, sensorId, status });
}

