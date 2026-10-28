-- ═══════════════════════════════════════════════════════════════════════
-- GRIDWISE ENERGY OS — POSTGRESQL RELATIONAL SCHEMA
-- Version: 1.0.0
-- Database: gridwise_db
-- ═══════════════════════════════════════════════════════════════════════

-- Ensure pgcrypto or gen_random_uuid is available (native in PG 13+)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. USERS & OPERATORS
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(128) NOT NULL,
    salt VARCHAR(64) NOT NULL,
    name VARCHAR(150) NOT NULL,
    role VARCHAR(80) NOT NULL DEFAULT 'Grid Controller',
    organization VARCHAR(150) NOT NULL DEFAULT 'Regional Substation Node',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(LOWER(email));

-- 2. USER SESSIONS (Server-side tracking & invalidation)
CREATE TABLE IF NOT EXISTS user_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(128) NOT NULL UNIQUE,
    ip_address VARCHAR(45),
    user_agent TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON user_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON user_sessions(expires_at);

-- 3. USER SIMULATION SETTINGS (Custom priorities & weights)
CREATE TABLE IF NOT EXISTS user_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    hospital_priority INT NOT NULL DEFAULT 1 CHECK (hospital_priority > 0),
    hospital_weight NUMERIC(5,2) NOT NULL DEFAULT 3.00 CHECK (hospital_weight > 0),
    hospital_baseline_demand NUMERIC(10,2) NOT NULL DEFAULT 30.00,
    residential_priority INT NOT NULL DEFAULT 2 CHECK (residential_priority > 0),
    residential_weight NUMERIC(5,2) NOT NULL DEFAULT 2.00 CHECK (residential_weight > 0),
    residential_baseline_demand NUMERIC(10,2) NOT NULL DEFAULT 70.00,
    industrial_priority INT NOT NULL DEFAULT 3 CHECK (industrial_priority > 0),
    industrial_weight NUMERIC(5,2) NOT NULL DEFAULT 1.00 CHECK (industrial_weight > 0),
    industrial_baseline_demand NUMERIC(10,2) NOT NULL DEFAULT 50.00,
    default_strategy VARCHAR(30) NOT NULL DEFAULT 'priority' CHECK (default_strategy IN ('priority', 'proportional', 'fairness')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 4. NATIONAL & STATE INDIA GRID TELEMETRY SNAPSHOTS
CREATE TABLE IF NOT EXISTS india_grid_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    zone_code VARCHAR(10) NOT NULL DEFAULT 'IN',
    zone_name VARCHAR(100) NOT NULL DEFAULT 'National Grid (India)',
    demand_met_mw NUMERIC(12,2) NOT NULL,
    clean_share_pct NUMERIC(5,2) NOT NULL,
    carbon_intensity_gco2 NUMERIC(8,2),
    fuel_generation_mix JSONB NOT NULL DEFAULT '{}'::jsonb,
    provenance VARCHAR(20) NOT NULL CHECK (provenance IN ('MEASURED', 'ESTIMATED', 'SIMULATED')),
    measured_at TIMESTAMPTZ,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_india_snapshots_zone ON india_grid_snapshots(zone_code, captured_at DESC);

-- 5. SIMULATION EXECUTION RUNS
CREATE TABLE IF NOT EXISTS simulation_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    mode VARCHAR(10) NOT NULL CHECK (mode IN ('auto', 'manual')),
    strategy VARCHAR(30) NOT NULL CHECK (strategy IN ('priority', 'proportional', 'fairness')),
    simulated_hour INT NOT NULL CHECK (simulated_hour BETWEEN 0 AND 23),
    solar_fault BOOLEAN NOT NULL DEFAULT FALSE,
    -- Inputs (kWh)
    supply_solar NUMERIC(10,4) NOT NULL DEFAULT 0,
    supply_wind NUMERIC(10,4) NOT NULL DEFAULT 0,
    supply_hydro NUMERIC(10,4) NOT NULL DEFAULT 0,
    supply_battery NUMERIC(10,4) NOT NULL DEFAULT 0,
    supply_external_grid NUMERIC(10,4) NOT NULL DEFAULT 0,
    supply_renewable_total NUMERIC(10,4) NOT NULL DEFAULT 0,
    supply_total NUMERIC(10,4) NOT NULL DEFAULT 0,
    -- Aggregate Output Invariants (kWh)
    demand_total NUMERIC(10,4) NOT NULL,
    allocated_total NUMERIC(10,4) NOT NULL,
    unmet_total NUMERIC(10,4) NOT NULL,
    shortage NUMERIC(10,4) NOT NULL,
    surplus NUMERIC(10,4) NOT NULL,
    coverage_pct NUMERIC(5,2) NOT NULL,
    fully_met_count INT NOT NULL,
    -- Telemetry Benchmark Link
    india_snapshot_id UUID REFERENCES india_grid_snapshots(id) ON DELETE SET NULL,
    executed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sim_runs_user ON simulation_runs(user_id, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_sim_runs_date ON simulation_runs(executed_at DESC);

-- 6. ALLOCATION BREAKDOWNS (Per-Consumer Microgrid Results)
CREATE TABLE IF NOT EXISTS allocation_breakdowns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    simulation_run_id UUID NOT NULL REFERENCES simulation_runs(id) ON DELETE CASCADE,
    consumer_name VARCHAR(50) NOT NULL CHECK (consumer_name IN ('hospital', 'residential', 'industrial')),
    consumer_label VARCHAR(80) NOT NULL,
    priority_rank INT NOT NULL,
    weight NUMERIC(5,2) NOT NULL,
    demand_kwh NUMERIC(10,4) NOT NULL,
    allocated_kwh NUMERIC(10,4) NOT NULL,
    unmet_kwh NUMERIC(10,4) NOT NULL,
    satisfaction_pct NUMERIC(5,2) NOT NULL,
    fully_satisfied BOOLEAN NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_alloc_run_id ON allocation_breakdowns(simulation_run_id);

-- 7. SAVED HISTORICAL REPORTS & AUDIT ARCHIVE
CREATE TABLE IF NOT EXISTS saved_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    simulation_run_id UUID NOT NULL REFERENCES simulation_runs(id) ON DELETE CASCADE,
    report_title VARCHAR(200) NOT NULL,
    format VARCHAR(10) NOT NULL CHECK (format IN ('CSV', 'JSON', 'BENCHMARK')),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_reports_user ON saved_reports(user_id, created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════
-- SEED DEFAULT OPERATOR ACCOUNT
-- Default password: GridWise2026!
-- ═══════════════════════════════════════════════════════════════════════
INSERT INTO users (id, email, password_hash, salt, name, role, organization)
VALUES (
    'a0000000-0000-0000-0000-000000000001',
    'operator@gridwise.energy',
    '1da4d04b9931793f08bc488c3d8b4e8f7dd7c064b2861a280801020a6484add6',
    '24b108afb1e415ca2ede399f8bf24f56',
    'Dr. Elena Vance',
    'Lead Grid Controller',
    'GridWise Central Operations'
)
ON CONFLICT (email) DO NOTHING;

INSERT INTO user_settings (user_id, hospital_priority, hospital_weight, residential_priority, residential_weight, industrial_priority, industrial_weight)
VALUES (
    'a0000000-0000-0000-0000-000000000001',
    1, 3.00,
    2, 2.00,
    3, 1.00
)
ON CONFLICT (user_id) DO NOTHING;
