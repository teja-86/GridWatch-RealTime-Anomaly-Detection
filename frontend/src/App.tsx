import React, { useEffect, useState } from "react";
import { io } from "socket.io-client";
import { fetchAlerts, fetchSensors, type AlertView, type SensorState, type SensorView } from "./api";

const wsBaseUrl = import.meta.env.VITE_WS_BASE_URL as string;
const supervisorId = "11111111-1111-1111-1111-111111111111";

function stateColor(state: SensorState) {
  switch (state) {
    case "healthy":
      return "bg-emerald-100 text-emerald-800";
    case "warning":
      return "bg-amber-100 text-amber-800";
    case "critical":
      return "bg-red-100 text-red-800";
    case "silent":
      return "bg-slate-200 text-slate-800";
  }
}

export default function App() {
  const [actorId, setActorId] = useState<string>(supervisorId);
  const [sensors, setSensors] = useState<SensorView[]>([]);
  const [alerts, setAlerts] = useState<AlertView[]>([]);

  // Socket lifecycle is managed inside the `useEffect` below.

  useEffect(() => {
    // Load initial sensors + alerts for zone-scoped actor.
    void (async () => {
      const [sRes, aRes] = await Promise.all([
        fetchSensors(actorId),
        fetchAlerts(actorId, { status: "open", page: 1, pageSize: 50 }),
      ]);
      setSensors(sRes);
      setAlerts(aRes.data);
    })().catch((e) => {
      // eslint-disable-next-line no-console
      console.error(e);
    });
  }, [actorId]);

  useEffect(() => {
    const sock = io(wsBaseUrl, {
      transports: ["websocket"],
      query: { actorId },
    });

    sock.on("sensor_state", (payload: any) => {
      setSensors((prev) => {
        const idx = prev.findIndex((s) => s.sensorId === payload.sensorId);
        if (idx === -1) return prev;
        const next = [...prev];
        next[idx] = { ...next[idx], state: payload.state as SensorState };
        return next;
      });
    });

    sock.on("alert_created", (payload: any) => {
      setAlerts((prev) => {
        // Keep simple; insert at top.
        if (prev.some((a) => a.id === payload.alertId)) return prev;
        const newAlert: AlertView = {
          id: payload.alertId,
          anomaly_id: payload.anomalyId ?? "",
          sensor_id: payload.sensorId,
          timestamp: new Date().toISOString(),
          current_status: payload.status,
          severity: payload.severity,
          suppressed: false,
          assigned_to_user_id: "",
          created_at: new Date().toISOString(),
        };
        return [newAlert, ...prev].slice(0, 200);
      });
    });

    sock.on("alert_updated", (payload: any) => {
      setAlerts((prev) => {
        const idx = prev.findIndex((a) => a.id === payload.alertId);
        if (idx === -1) return prev;
        const next = [...prev];
        next[idx] = { ...next[idx], current_status: payload.status };
        return next;
      });
    });

    return () => {
      sock.disconnect();
    };
  }, [actorId]);

  async function acknowledgeAlert(alertId: string) {
    const res = await fetch(`${import.meta.env.VITE_API_BASE_URL}/alerts/${alertId}/acknowledge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-actor-id": actorId,
      },
      body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error(await res.text());
  }

  async function resolveAlert(alertId: string) {
    const res = await fetch(`${import.meta.env.VITE_API_BASE_URL}/alerts/${alertId}/resolve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-actor-id": actorId,
      },
      body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error(await res.text());
  }

  return (
    <div className="min-h-screen p-6">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center gap-4 mb-6">
          <div className="text-xl font-semibold">GridWatch</div>
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-600">Actor</label>
            <input
              className="border rounded px-3 py-1 text-sm"
              value={actorId}
              onChange={(e) => setActorId(e.target.value)}
              spellCheck={false}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-white rounded-lg shadow-sm p-4">
            <div className="font-semibold mb-3">Sensors</div>
            <div className="grid grid-cols-2 gap-3">
              {sensors.slice(0, 200).map((s) => (
                <div key={s.sensorId} className="border rounded px-3 py-2">
                  <div className="text-xs text-gray-500">{s.zoneName}</div>
                  <div className="text-sm font-medium break-all">{s.sensorId.slice(0, 8)}...</div>
                  <div className={`mt-2 inline-flex px-2 py-1 rounded text-xs ${stateColor(s.state)}`}>
                    {s.state}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white rounded-lg shadow-sm p-4">
            <div className="font-semibold mb-3">Open Alerts</div>
            <div className="overflow-auto max-h-[560px]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500">
                    <th className="py-2">Status</th>
                    <th>Severity</th>
                    <th>Sensor</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {alerts.map((a) => (
                    <tr key={a.id} className="border-t">
                      <td className="py-2">{a.current_status}</td>
                      <td className="capitalize">{a.severity}</td>
                      <td className="break-all">{a.sensor_id.slice(0, 8)}...</td>
                      <td className="text-right py-2">
                        {a.current_status === "open" ? (
                          <div className="flex justify-end gap-2">
                            <button
                              className="text-xs px-2 py-1 border rounded hover:bg-gray-50"
                              onClick={() => void acknowledgeAlert(a.id)}
                            >
                              Ack
                            </button>
                            <button
                              className="text-xs px-2 py-1 border rounded hover:bg-gray-50"
                              onClick={() => void resolveAlert(a.id)}
                            >
                              Resolve
                            </button>
                          </div>
                        ) : a.current_status === "acknowledged" ? (
                          <button
                            className="text-xs px-2 py-1 border rounded hover:bg-gray-50"
                            onClick={() => void resolveAlert(a.id)}
                          >
                            Resolve
                          </button>
                        ) : (
                          <span className="text-xs text-gray-400">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {alerts.length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-6 text-center text-gray-500">
                        No open alerts
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="mt-6 text-xs text-gray-500">
          This UI is for review convenience. Zone isolation is enforced on the backend.
        </div>
      </div>
    </div>
  );
}

