const apiBaseUrl = import.meta.env.VITE_API_BASE_URL as string;

export type SensorState = "healthy" | "warning" | "critical" | "silent";

export type SensorView = {
  sensorId: string;
  zoneName: string;
  state: SensorState;
};

export type AlertView = {
  id: string;
  anomaly_id: string;
  sensor_id: string;
  timestamp: string;
  current_status: string;
  severity: "warning" | "critical";
  suppressed: boolean;
  assigned_to_user_id: string;
  created_at: string;
};

export async function fetchSensors(actorId: string): Promise<SensorView[]> {
  const res = await fetch(`${apiBaseUrl}/dashboard/sensors`, {
    headers: { "x-actor-id": actorId },
  });
  if (!res.ok) throw new Error(`fetchSensors failed: ${await res.text()}`);
  const json = await res.json();
  return json.sensors as SensorView[];
}

export async function fetchAlerts(
  actorId: string,
  query: Record<string, string | number | boolean | undefined>
): Promise<{ page: number; pageSize: number; total: number; data: AlertView[] }> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    params.set(k, String(v));
  }
  const res = await fetch(`${apiBaseUrl}/alerts?${params.toString()}`, {
    headers: { "x-actor-id": actorId },
  });
  if (!res.ok) throw new Error(`fetchAlerts failed: ${await res.text()}`);
  return res.json();
}

