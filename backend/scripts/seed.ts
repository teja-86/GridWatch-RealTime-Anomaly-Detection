import crypto from "crypto";
import { pool } from "../src/db";

type Num = number;

function uuid(): string {
  return crypto.randomUUID();
}

async function main() {
  // Clean strategy:
  // - This is a fresh assessment project; for convenience we keep it idempotent-ish by truncating key tables.
  await pool.query(`
    TRUNCATE TABLE
      readings, anomalies, alert_status_transitions, escalation_log, alerts,
      sensor_state, sensor_last_reading,
      suppressions,
      threshold_configs, rate_of_change_configs, pattern_absence_configs,
      sensors, zone_operators, operator_zones, app_users, zones
    RESTART IDENTITY CASCADE;
  `);

  const zones = ["Zone-A", "Zone-B", "Zone-C"];
  const zoneIds: Record<string, string> = {};
  for (const z of zones) {
    const res = await pool.query(`INSERT INTO zones(name) VALUES($1) RETURNING id`, [z]);
    zoneIds[z] = res.rows[0].id as string;
  }

  const supervisorId = "11111111-1111-1111-1111-111111111111";
  const operatorAId = "22222222-2222-2222-2222-222222222222";
  const operatorBId = "33333333-3333-3333-3333-333333333333";

  await pool.query(
    `INSERT INTO app_users(id, role, display_name) VALUES
      ($1,'supervisor','Supervisor'),
      ($2,'operator','Operator-A'),
      ($3,'operator','Operator-B')`,
    [supervisorId, operatorAId, operatorBId]
  );

  // Operator assignments:
  // Operator-A manages Zone-A and Zone-C, Operator-B manages Zone-B.
  await pool.query(
    `INSERT INTO operator_zones(operator_user_id, zone_id) VALUES
      ($1,$2), ($1,$3),
      ($4,$5)`,
    [operatorAId, zoneIds["Zone-A"], zoneIds["Zone-C"], operatorBId, zoneIds["Zone-B"]]
  );
  await pool.query(
    `INSERT INTO zone_operators(zone_id, operator_user_id) VALUES
      ($1,$2), ($3,$4), ($5,$2)`,
    [zoneIds["Zone-A"], operatorAId, zoneIds["Zone-B"], operatorBId, zoneIds["Zone-C"]]
  );

  const sensorCount = 1000;
  const sensors: { id: string; zoneId: string }[] = [];

  for (let i = 0; i < sensorCount; i++) {
    const zoneIndex = i % 3;
    const zoneName = zones[zoneIndex];
    const id = uuid();
    sensors.push({ id, zoneId: zoneIds[zoneName] });
  }

  // Insert sensors
  const sensorChunks: { id: string; zoneId: string }[][] = [];
  const chunkSize = 200;
  for (let i = 0; i < sensors.length; i += chunkSize) {
    sensorChunks.push(sensors.slice(i, i + chunkSize));
  }
  for (const chunk of sensorChunks) {
    await pool.query(
      `
      INSERT INTO sensors(id, zone_id, status_code)
      SELECT * FROM UNNEST($1::uuid[], $2::uuid[], $3::int[])
      `,
      [
        chunk.map((s) => s.id),
        chunk.map((s) => s.zoneId),
        chunk.map(() => 0),
      ]
    );
  }

  // Sensor configurations
  const now = new Date();
  const start = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  const intervalSeconds = 60 * 5; // 5 min default (we still generate a lot, keep it manageable)
  const latestQueueMinutes = 30; // only last 30 minutes are queued for processing on startup

  // Pick some sensors for demo anomalies and silence
  const anomalySensors = sensors.slice(0, 90); // threshold + spikes
  const silentSensors = sensors.slice(90, 120);

  const cfgThresholdRows: any[] = [];
  const cfgRateRows: any[] = [];
  const cfgAbsenceRows: any[] = [];

  for (const s of sensors) {
    const isCritical = s.zoneId === zoneIds["Zone-A"] ? Math.random() < 0.3 : Math.random() < 0.2;
    const voltageBase = 220 + (Math.random() * 12 - 6);
    const tempBase = 60 + (Math.random() * 10 - 5);

    const voltageMin = voltageBase - (20 + Math.random() * 10);
    const voltageMax = voltageBase + (20 + Math.random() * 10);
    const tempMin = tempBase - (15 + Math.random() * 5);
    const tempMax = tempBase + (15 + Math.random() * 5);

    cfgThresholdRows.push({ sensorId: s.id, metric: "voltage", min: voltageMin, max: voltageMax, sev: isCritical ? "critical" : "warning" });
    cfgThresholdRows.push({ sensorId: s.id, metric: "temperature", min: tempMin, max: tempMax, sev: isCritical ? "critical" : "warning" });

    cfgRateRows.push({
      sensorId: s.id,
      thresholdPct: 15 + Math.random() * 20,
      sev: isCritical ? "critical" : "warning",
    });
    cfgAbsenceRows.push({
      sensorId: s.id,
      silenceSeconds: 120,
      sev: isCritical ? "critical" : "warning",
    });
  }

  // Bulk insert configs
  // threshold_configs
  const thrChunk = 500;
  for (let i = 0; i < cfgThresholdRows.length; i += thrChunk) {
    const slice = cfgThresholdRows.slice(i, i + thrChunk);
    await pool.query(
      `
      INSERT INTO threshold_configs(sensor_id, metric, min_value, max_value, severity)
      SELECT * FROM UNNEST($1::uuid[], $2::text[], $3::numeric[], $4::numeric[], $5::alert_severity[])
      `,
      [
        slice.map((r) => r.sensorId),
        slice.map((r) => r.metric),
        slice.map((r) => r.min),
        slice.map((r) => r.max),
        slice.map((r) => r.sev),
      ]
    );
  }

  // rate_of_change_configs
  const rateChunk = 500;
  for (let i = 0; i < cfgRateRows.length; i += rateChunk) {
    const slice = cfgRateRows.slice(i, i + rateChunk);
    await pool.query(
      `
      INSERT INTO rate_of_change_configs(sensor_id, threshold_pct, severity)
      SELECT * FROM UNNEST($1::uuid[], $2::numeric[], $3::alert_severity[])
      `,
      [slice.map((r) => r.sensorId), slice.map((r) => r.thresholdPct), slice.map((r) => r.sev)]
    );
  }

  // pattern_absence_configs
  const absChunk = 500;
  for (let i = 0; i < cfgAbsenceRows.length; i += absChunk) {
    const slice = cfgAbsenceRows.slice(i, i + absChunk);
    await pool.query(
      `
      INSERT INTO pattern_absence_configs(sensor_id, silence_seconds, severity)
      SELECT * FROM UNNEST($1::uuid[], $2::int[], $3::alert_severity[])
      `,
      [slice.map((r) => r.sensorId), slice.map((r) => r.silenceSeconds), slice.map((r) => r.sev)]
    );
  }

  // Readings
  // We keep last timestamps so rule C can fire on some sensors.
  const processingWindowStart = new Date(now.getTime() - latestQueueMinutes * 60 * 1000);

  const readingsInsertChunkSize = 1000;
  let buf: any[] = [];

  async function flush() {
    if (buf.length === 0) return;
    const ids = buf.map((r) => r.sensor_id);
    const ts = buf.map((r) => r.timestamp);
    const v = buf.map((r) => r.voltage);
    const c = buf.map((r) => r.current);
    const t = buf.map((r) => r.temperature);
    const sc = buf.map((r) => r.status_code);
    const procState = buf.map((r) => (r.timestamp >= processingWindowStart ? "queued" : "done"));
    await pool.query(
      `
      INSERT INTO readings(sensor_id, timestamp, voltage, current, temperature, status_code, processing_state, retry_count)
      SELECT * FROM UNNEST(
        $1::uuid[], $2::timestamptz[], $3::numeric[], $4::numeric[],
        $5::numeric[], $6::int[], $7::processing_state[], $8::int[]
      )
      `,
      [ids, ts, v, c, t, sc, procState, buf.map(() => 0)]
    );
    buf = [];
  }

  const silentSet = new Set(silentSensors.map((s) => s.id));

  // Generate sparse readings over last 48 hours, with a few sensors currently silent.
  for (const sensor of sensors) {
    const isSilent = silentSet.has(sensor.id);
    // For silent sensors, omit readings for the last 3 minutes.
    const silenceStart = new Date(now.getTime() - 3 * 60 * 1000);

    // Different cadence for anomaly sensors vs rest
    const cadence = anomalySensors.some((s) => s.id === sensor.id) ? 60 : intervalSeconds;

    const sensorStart = start;
    for (let ts = sensorStart.getTime(); ts <= now.getTime(); ts += cadence * 1000) {
      const date = new Date(ts);
      if (isSilent && date >= silenceStart) continue;

      // Base wave
      const baseVoltage = 220 + Math.sin(ts / 2000000) * 8;
      const baseCurrent = 10 + Math.cos(ts / 2500000) * 2;
      const baseTemp = 60 + Math.sin(ts / 1800000) * 5;

      // Inject threshold breach and spikes for demo sensors
      let voltage = baseVoltage;
      let temperature = baseTemp;
      if (anomalySensors.some((s) => s.id === sensor.id)) {
        const ageMs = now.getTime() - ts;
        // Make recent (within last 6 hours) anomalies
        if (ageMs < 6 * 60 * 60 * 1000) {
          const i = Math.floor(ts / 60000);
          if (i % 47 === 0) {
            voltage = voltage - 60; // threshold breach
          }
          if (i % 53 === 0) {
            voltage = voltage * (1.4 + Math.random() * 0.1); // rate spike
          }
          if (i % 59 === 0) {
            temperature = temperature + 35; // temperature breach
          }
        }
      }

      buf.push({
        sensor_id: sensor.id,
        timestamp: date.toISOString(),
        voltage: voltage as Num,
        current: baseCurrent as Num,
        temperature: temperature as Num,
        status_code: 1,
      });

      if (buf.length >= readingsInsertChunkSize) {
        // eslint-disable-next-line no-await-in-loop
        await flush();
      }
    }

    // eslint-disable-next-line no-await-in-loop
    await flush();

    // Ensure sensor_state + sensor_last_reading exists.
    const lastTsRes = await pool.query(
      `SELECT max(timestamp) as last_ts FROM readings WHERE sensor_id = $1`,
      [sensor.id]
    );
    const lastTs = lastTsRes.rows[0].last_ts as string | null;
    if (lastTs) {
      await pool.query(
        `
        INSERT INTO sensor_last_reading(sensor_id, last_timestamp)
        VALUES($1, $2)
        ON CONFLICT (sensor_id) DO UPDATE SET last_timestamp = EXCLUDED.last_timestamp, updated_at = now()
        `,
        [sensor.id, lastTs]
      );
    }
    await pool.query(
      `
      INSERT INTO sensor_state(sensor_id, state)
      VALUES($1, 'healthy')
      ON CONFLICT (sensor_id) DO UPDATE SET state = sensor_state.state
      `,
      [sensor.id]
    );
  }

  // Suppressions - none by default
  // eslint-disable-next-line no-console
  console.log("Seed complete.");
}

main()
  .then(() => pool.end().catch(() => {}))
  .catch(async (e) => {
    // eslint-disable-next-line no-console
    console.error("Seed failed", e);
    await pool.end().catch(() => {});
    process.exit(1);
  });

