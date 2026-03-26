# GridWatch — Real-Time Anomaly Detection

Operational platform that ingests high-frequency sensor readings, detects anomalies, creates/manages alerts, and pushes real-time sensor state updates to zone-scoped operators **without polling**.

---

## 1) Setup (one command)
### Docker (recommended)
From repo root:

```bash
docker-compose up --build
```

- **Backend**: `http://localhost:4000`
- **Frontend**: `http://localhost:5173`
- **Postgres**: `localhost:5433` (host port mapped to container `5432`)

Backend auto-runs:
- `backend/scripts/initDb.ts` (creates DB if missing, then loads `backend/db/schema.sql`)
- `backend/scripts/seed.ts` (controlled by `SEED_ON_STARTUP=true` in `docker-compose.yml`)

### Local dev (no Docker)
1. Ensure Postgres is running locally.
2. In `backend/.env`, set:

```env
DATABASE_URL=postgres://postgres:YOUR_PASSWORD@localhost:5432/gridwatch
DEFAULT_ACTOR_ID=11111111-1111-1111-1111-111111111111
```

3. Run:

```bash
cd backend
npm install
npm run db:init
npm run db:seed
npm run dev
```

4. In a second terminal:

```bash
cd frontend
npm install
npm run dev
```

### Seeded actor IDs (for local testing)
- **Supervisor**: `11111111-1111-1111-1111-111111111111`
- **Operator-A**: `22222222-2222-2222-2222-222222222222`
- **Operator-B**: `33333333-3333-3333-3333-333333333333`

---

## 2) Architecture (data flow)
### Ingest → durable storage → async processing → anomalies → alerts → dashboard

1. **`POST /ingest`** receives up to 1000 readings.
2. Backend **bulk inserts** readings into Postgres `readings` with `processing_state='queued'`.
   - This is the durability boundary: the endpoint responds only after insert succeeds.
3. **Anomaly worker** continuously pulls queued readings using `FOR UPDATE SKIP LOCKED`:
   - Applies **Rule A** (threshold breach) using `threshold_configs`
   - Applies **Rule B** (rate-of-change spike) using `rate_of_change_configs` and previous 3 readings
   - Writes `anomalies` + `alerts`
   - Marks reading `done` or `failed` with `retry_count` + `last_error` (recoverable, not silently dropped)
4. **Pattern absence worker (Rule C)** runs independently:
   - Scans `sensor_last_reading` + `pattern_absence_configs` to find sensors silent > 2 minutes
   - Creates Rule C anomaly + alert (idempotent per time bucket)
   - Resolves Rule C alerts when sensor resumes reporting
5. **Escalation worker**:
   - Finds **open critical** alerts older than 5 minutes
   - Reassigns to supervisor
   - Writes exactly-once record to `escalation_log` (duplicate escalation is prevented)
6. **Real-time updates**:
   - On alert create/transition and on Rule C changes, backend refreshes `sensor_state` and emits zone-scoped websocket events.

---

## 3) Schema Decisions (tables, indexes, relationships)
### Why these tables
- **`readings`**: source-of-truth for sensor data, plus durable processing state (`queued/processing/done/failed`) to support async pipeline and recovery.
- **`anomalies`**: immutable event records; a single reading can create multiple anomalies (Rule A voltage + Rule A temperature + Rule B, etc.).
- **`alerts`**: one alert per anomaly (enforced by `alerts.anomaly_id UNIQUE`), with lifecycle state (`open → acknowledged → resolved`).
- **`alert_status_transitions`**: append-only audit trail; no updates/deletes, only inserts for every status change.
- **`suppressions`**: maintenance windows; anomalies are still recorded, alerts are created but marked suppressed and don’t notify/escalate.
- **`sensor_last_reading`**: enables Rule C (silence) detection without relying on inbound data timing.
- **`sensor_state`**: cached per-sensor operational state to power fast dashboard loads and consistent real-time emission.
- **Zones + users**: `zones`, `app_users`, `operator_zones`, and `zone_operators` support zone isolation and assignment.

### Key indexes (performance justifications)
- **`readings(sensor_id, timestamp DESC)`**: required for `GET /sensors/:id/history` and Rule B “previous 3 readings”.
- **`readings(processing_state, retry_count, created_at)`**: supports worker queue scanning efficiently.
- **`alerts(current_status, severity, created_at DESC)`** and **`alerts(assigned_to_user_id, current_status, ...)`**: supports fast `/alerts` list filters.
- **Rule C dedupe**: `anomalies(sensor_id, rule_type, period_start_time)` unique index prevents duplicate “silent” anomalies.

### Zone isolation at the data layer
All read endpoints join through `sensors.zone_id` and enforce:
- supervisor: unrestricted
- operator: only `zone_id IN operator_zones`

---

## 4) Real-Time Design (no polling)
### Technology
- **Socket.IO** on the backend (`backend/src/realtime.ts`)
- **socket.io-client** on the frontend

### Architecture
- Each websocket connection joins **zone rooms** (`zone:<zoneId>`).
- Backend emits:
  - **`sensor_state`** when computed state changes (`healthy | warning | critical | silent`)
  - **`alert_created`** when a new alert is created (unless suppressed)
  - **`alert_updated`** on lifecycle transitions and escalation-related updates
- Frontend updates UI state immediately on these events; no client-side polling is used for state changes.

---

## 5) What I Finished and What I Cut
### Finished (working)
- **Durable ingestion** (`POST /ingest`) up to 1000 readings/batch.
- **Async processing pipeline**:
  - Rule A + Rule B worker processing queued readings
  - Rule C worker detecting silence independently
  - Failed processing is recoverable via `processing_state='failed'`, `retry_count`, `last_error`
- **Alerts**:
  - Create alerts for anomalies
  - Lifecycle transitions `open → acknowledged → resolved` (+ audit trail inserts)
- **Suppression**:
  - `POST /suppressions` creates windows
  - During suppression: anomalies still recorded; alerts are created but marked suppressed; no notifications/escalation
- **Auto-escalation** (exactly-once):
  - critical open > 5 min → reassigned to supervisor + `escalation_log` entry
- **Zone isolation** enforced in SQL across endpoints.
- **Frontend**:
  - Live sensor list + open alerts panel
  - Real-time updates via websocket (no polling)

### Cut / stubbed / incomplete
- No full operator auth (uses `x-actor-id` header + seeded IDs).
- Dashboard UI is minimal (no charts, no sensor detail page).
- No notifications system beyond websocket events.
- Limited suppression behavior documentation only; no UI for suppression.
- Historical endpoint returns required fields, but UI doesn’t render history yet.

---

## 6) The Three Hardest Problems (decisions + why)
1. **Durability vs latency in `/ingest`**
   - Chosen approach: bulk insert to Postgres then return; async workers do heavy processing.
   - Rationale: meets “durably stored before response” while keeping response time low.

2. **Recoverable processing without silent drops**
   - Chosen approach: `processing_state`, `retry_count`, and `last_error` on each reading.
   - Rationale: failures remain queryable and retryable; nothing disappears.

3. **Exactly-once escalation**
   - Chosen approach: unique constraint on `escalation_log.alert_id` and worker idempotency.
   - Rationale: prevents duplicate escalations even with retries or multiple worker ticks.

---

## 7) Production Gap (if I had a week)
I would add **proper authentication + RLS (Row Level Security)** in Postgres:
- Replace `x-actor-id` with real auth (JWT/session) and enforce zone isolation via RLS policies.
- This makes “zone isolation at the data layer” provable even if an endpoint has a bug.

---

## Quick Smoke Test Commands
### Health
```bash
curl http://localhost:4000/healthz
```

### Dashboard sensors (with actor header)
```bash
curl -H "x-actor-id: 11111111-1111-1111-1111-111111111111" \
  http://localhost:4000/dashboard/sensors
```

### Alerts list
```bash
curl -H "x-actor-id: 11111111-1111-1111-1111-111111111111" \
  "http://localhost:4000/alerts?page=1&pageSize=5"
```

### History endpoint format note
`GET /sensors/:id/history` expects **strict ISO UTC datetime** for `from` and `to` (example: `2026-03-26T17:00:00.000Z`).

