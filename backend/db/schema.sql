-- GridWatch schema (run from scratch)
-- IMPORTANT: This file is intended to be run once on a fresh database.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'processing_state') THEN
    CREATE TYPE processing_state AS ENUM ('queued', 'processing', 'done', 'failed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'alert_severity') THEN
    CREATE TYPE alert_severity AS ENUM ('warning', 'critical');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'alert_status') THEN
    CREATE TYPE alert_status AS ENUM ('open', 'acknowledged', 'resolved');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'sensor_state_enum') THEN
    CREATE TYPE sensor_state_enum AS ENUM ('healthy', 'warning', 'critical', 'silent');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS app_users (
  id uuid PRIMARY KEY,
  role text NOT NULL CHECK (role IN ('operator', 'supervisor')),
  display_name text NOT NULL
);

CREATE TABLE IF NOT EXISTS operator_zones (
  operator_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  zone_id uuid NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  PRIMARY KEY (operator_user_id, zone_id)
);

-- Primary operator assigned to a zone (used to assign new alerts)
CREATE TABLE IF NOT EXISTS zone_operators (
  zone_id uuid PRIMARY KEY REFERENCES zones(id) ON DELETE CASCADE,
  operator_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sensors (
  id uuid PRIMARY KEY,
  zone_id uuid NOT NULL REFERENCES zones(id),
  status_code int NOT NULL DEFAULT 0
);

-- Independent mechanism input for rule C
CREATE TABLE IF NOT EXISTS sensor_last_reading (
  sensor_id uuid PRIMARY KEY REFERENCES sensors(id) ON DELETE CASCADE,
  last_timestamp timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sensor_id uuid NOT NULL REFERENCES sensors(id),
  timestamp timestamptz NOT NULL,
  voltage numeric NOT NULL,
  current numeric NOT NULL,
  temperature numeric NOT NULL,
  status_code int NOT NULL,

  processing_state processing_state NOT NULL DEFAULT 'queued',
  retry_count int NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_readings_sensor_ts
  ON readings(sensor_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_readings_processing_state
  ON readings(processing_state, retry_count, created_at);

CREATE TABLE IF NOT EXISTS anomalies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reading_id uuid REFERENCES readings(id) ON DELETE CASCADE,
  sensor_id uuid NOT NULL REFERENCES sensors(id),
  timestamp timestamptz NOT NULL,
  rule_type text NOT NULL CHECK (rule_type IN ('A','B','C')),
  metric text,
  value numeric,
  period_start_time timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Dedupe for Rule C (and allows any rule to use period_start_time if desired)
CREATE UNIQUE INDEX IF NOT EXISTS idx_anomalies_dedupe_rule_period
  ON anomalies(sensor_id, rule_type, period_start_time);

-- One alert per anomaly
CREATE TABLE IF NOT EXISTS alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anomaly_id uuid UNIQUE NOT NULL REFERENCES anomalies(id) ON DELETE CASCADE,

  sensor_id uuid NOT NULL REFERENCES sensors(id),
  timestamp timestamptz NOT NULL,

  current_status alert_status NOT NULL DEFAULT 'open',
  severity alert_severity NOT NULL,

  assigned_to_user_id uuid NOT NULL REFERENCES app_users(id),

  suppressed boolean NOT NULL DEFAULT false,
  -- When suppressed, workers should not notify/escalate.
  notifications_enabled boolean NOT NULL DEFAULT true,

  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  resolved_at timestamptz,

  last_status_update_by uuid REFERENCES app_users(id),
  last_status_update_at timestamptz,

  -- Used by the escalation worker (idempotency).
  escalation_status text NOT NULL DEFAULT 'none'
);

CREATE INDEX IF NOT EXISTS idx_alerts_status_created
  ON alerts(current_status, severity, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_alerts_assigned
  ON alerts(assigned_to_user_id, current_status, severity, created_at DESC);

CREATE TABLE IF NOT EXISTS alert_status_transitions (
  id bigserial PRIMARY KEY,
  alert_id uuid NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  from_status alert_status NOT NULL,
  to_status alert_status NOT NULL,
  changed_by_user_id uuid NOT NULL REFERENCES app_users(id),
  changed_at timestamptz NOT NULL DEFAULT now()
);

-- Append-only escalation log: exactly once per alert
CREATE TABLE IF NOT EXISTS escalation_log (
  id bigserial PRIMARY KEY,
  alert_id uuid UNIQUE NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  escalated_to_user_id uuid NOT NULL REFERENCES app_users(id),
  escalated_at timestamptz NOT NULL DEFAULT now(),
  note text
);

CREATE TABLE IF NOT EXISTS suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sensor_id uuid NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
  start_time timestamptz NOT NULL,
  end_time timestamptz NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_time > start_time)
);

-- Rule configuration
-- Rule A: configured min/max per sensor and metric
CREATE TABLE IF NOT EXISTS threshold_configs (
  sensor_id uuid NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
  metric text NOT NULL CHECK (metric IN ('voltage','temperature')),
  min_value numeric NOT NULL,
  max_value numeric NOT NULL,
  severity alert_severity NOT NULL,
  PRIMARY KEY (sensor_id, metric)
);

-- Rule B: rate-of-change spike percentage per sensor
CREATE TABLE IF NOT EXISTS rate_of_change_configs (
  sensor_id uuid PRIMARY KEY REFERENCES sensors(id) ON DELETE CASCADE,
  threshold_pct numeric NOT NULL CHECK (threshold_pct > 0),
  severity alert_severity NOT NULL
);

-- Rule C: pattern absence
CREATE TABLE IF NOT EXISTS pattern_absence_configs (
  sensor_id uuid PRIMARY KEY REFERENCES sensors(id) ON DELETE CASCADE,
  silence_seconds int NOT NULL CHECK (silence_seconds >= 60),
  severity alert_severity NOT NULL
);

-- Zone-scoped sensor state for fast dashboard queries + quick websocket broadcasts.
CREATE TABLE IF NOT EXISTS sensor_state (
  sensor_id uuid PRIMARY KEY REFERENCES sensors(id) ON DELETE CASCADE,
  state sensor_state_enum NOT NULL DEFAULT 'healthy',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Basic safety checks
ALTER TABLE alerts
  ADD CONSTRAINT alerts_status_valid CHECK (current_status IN ('open','acknowledged','resolved'));

