/**
 * ═══════════════════════════════════════════════════════════════════════
 * GRIDWISE DATABASE ACCESS LAYER (PostgreSQL + Resilient In-Memory Fallback)
 * ───────────────────────────────────────────────────────────────────────
 * - Uses 'pg' connection pooling with parameterized queries.
 * - Auto-detects PostgreSQL availability on startup.
 * - If PostgreSQL credentials or database are pending setup, automatically
 *   operates in resilient in-memory mode so the application never crashes.
 * ═══════════════════════════════════════════════════════════════════════
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT, 10) || 5432,
  database: process.env.PGDATABASE || 'gridwise_db',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || '',
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
  max: parseInt(process.env.PGPOOL_MAX, 10) || 20,
  idleTimeoutMillis: parseInt(process.env.PG_IDLE_TIMEOUT_MS, 10) || 30000,
  connectionTimeoutMillis: parseInt(process.env.PG_CONNECTION_TIMEOUT_MS, 10) || 3000,
});

pool.on('error', (err) => {
  console.warn('[GridWise DB Pool Warning]', err.message);
});

// Internal connection and fallback state
const dbState = {
  connected: false,
  errorMessage: null,
  // In-memory fallback caches
  fallbackUsers: new Map(),
  fallbackSessions: new Map(),
  fallbackSettings: new Map(),
  fallbackSimulations: []
};

// Seed demo operator into in-memory fallback
const DEMO_SALT = '24b108afb1e415ca2ede399f8bf24f56';
const DEMO_HASH = '1da4d04b9931793f08bc488c3d8b4e8f7dd7c064b2861a280801020a6484add6';
const DEMO_USER = {
  id: 'a0000000-0000-0000-0000-000000000001',
  email: 'operator@gridwise.energy',
  name: 'Dr. Elena Vance',
  role: 'Lead Grid Controller',
  organization: 'GridWise Central Operations',
  salt: DEMO_SALT,
  hash: DEMO_HASH,
  created_at: new Date().toISOString()
};
dbState.fallbackUsers.set(DEMO_USER.email, DEMO_USER);
dbState.fallbackSettings.set(DEMO_USER.id, {
  hospital_priority: 1,
  hospital_weight: 3.0,
  residential_priority: 2,
  residential_weight: 2.0,
  industrial_priority: 3,
  industrial_weight: 1.0,
  default_strategy: 'priority'
});

/**
 * Initialize and verify Database connection on server startup.
 */
async function initDatabase() {
  try {
    const res = await pool.query('SELECT NOW() AS current_time');
    dbState.connected = true;
    dbState.errorMessage = null;
    console.log(`[GridWise DB] PostgreSQL connected successfully at ${res.rows[0].current_time}`);

    // Run schema migrations if schema.sql exists
    const schemaPath = path.join(__dirname, 'schema.sql');
    if (fs.existsSync(schemaPath)) {
      const sql = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(sql);
      console.log('[GridWise DB] Relational schema verified & synchronized.');
    }
    return true;
  } catch (err) {
    dbState.connected = false;
    dbState.errorMessage = err.message;
    console.warn(`[GridWise DB] PostgreSQL offline or auth pending (${err.message}). Operating in resilient in-memory fallback mode.`);
    return false;
  }
}

/**
 * Execute parameterized query safely
 */
async function query(text, params) {
  if (!dbState.connected) {
    throw new Error('Database not connected. Using fallback.');
  }
  return pool.query(text, params);
}

// ─────────────────────────────────────────────────────────────────
// DATA ACCESS LAYER (UNIFIED FOR POSTGRESQL & FALLBACK)
// ─────────────────────────────────────────────────────────────────

/** Find user by email */
async function findUserByEmail(email) {
  const normalized = (email || '').toLowerCase().trim();
  if (dbState.connected) {
    try {
      const res = await pool.query(
        'SELECT id, email, password_hash AS hash, salt, name, role, organization, created_at FROM users WHERE LOWER(email) = LOWER($1)',
        [normalized]
      );
      return res.rows[0] || null;
    } catch (e) {
      console.warn('[GridWise DB] findUserByEmail query error, using fallback:', e.message);
    }
  }
  return dbState.fallbackUsers.get(normalized) || null;
}

/** Create user */
async function createUser({ name, email, role, organization, salt, hash }) {
  const normalized = (email || '').toLowerCase().trim();
  if (dbState.connected) {
    try {
      const res = await pool.query(
        `INSERT INTO users (email, password_hash, salt, name, role, organization)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, email, name, role, organization, created_at`,
        [normalized, hash, salt, name.trim(), role || 'Grid Controller', organization || 'Regional Node']
      );
      const user = res.rows[0];
      // Create default settings for user
      await pool.query(
        `INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
        [user.id]
      );
      return user;
    } catch (e) {
      console.warn('[GridWise DB] createUser query error, using fallback:', e.message);
    }
  }

  // Fallback
  const id = 'user-' + Date.now();
  const newUser = {
    id,
    email: normalized,
    name: name.trim(),
    role: role || 'Grid Controller',
    organization: organization || 'Regional Node',
    salt,
    hash,
    created_at: new Date().toISOString()
  };
  dbState.fallbackUsers.set(normalized, newUser);
  dbState.fallbackSettings.set(id, {
    hospital_priority: 1, hospital_weight: 3.0,
    residential_priority: 2, residential_weight: 2.0,
    industrial_priority: 3, industrial_weight: 1.0,
    default_strategy: 'priority'
  });
  return {
    id: newUser.id,
    email: newUser.email,
    name: newUser.name,
    role: newUser.role,
    organization: newUser.organization,
    created_at: newUser.created_at
  };
}

/** Create session */
async function createSession({ userId, tokenHash, ip, userAgent, expiresAt }) {
  if (dbState.connected) {
    try {
      await pool.query(
        `INSERT INTO user_sessions (user_id, token_hash, ip_address, user_agent, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, tokenHash, ip || null, userAgent || null, new Date(expiresAt)]
      );
      return true;
    } catch (e) {
      console.warn('[GridWise DB] createSession query error:', e.message);
    }
  }
  dbState.fallbackSessions.set(tokenHash, { userId, tokenHash, expiresAt, revoked: false });
  return true;
}

/** Verify active session */
async function verifySession(tokenHash) {
  if (dbState.connected) {
    try {
      const res = await pool.query(
        `SELECT s.id AS session_id, s.user_id, u.email, u.name, u.role, u.organization
         FROM user_sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.revoked = FALSE AND s.expires_at > NOW()`,
        [tokenHash]
      );
      return res.rows[0] || null;
    } catch (e) {
      console.warn('[GridWise DB] verifySession error:', e.message);
    }
  }

  // Fallback
  const session = dbState.fallbackSessions.get(tokenHash);
  if (session && !session.revoked && session.expiresAt > Date.now()) {
    // Find user by id
    for (const u of dbState.fallbackUsers.values()) {
      if (u.id === session.userId) {
        return {
          session_id: 'session-' + session.tokenHash,
          user_id: u.id,
          email: u.email,
          name: u.name,
          role: u.role,
          organization: u.organization
        };
      }
    }
  }
  return null;
}

/** Revoke session on logout */
async function revokeSession(tokenHash) {
  if (dbState.connected) {
    try {
      await pool.query(
        `UPDATE user_sessions SET revoked = TRUE WHERE token_hash = $1`,
        [tokenHash]
      );
      return true;
    } catch (e) {
      console.warn('[GridWise DB] revokeSession error:', e.message);
    }
  }
  const session = dbState.fallbackSessions.get(tokenHash);
  if (session) session.revoked = true;
  return true;
}

/** Get user settings */
async function getUserSettings(userId) {
  if (dbState.connected) {
    try {
      const res = await pool.query(
        `SELECT hospital_priority, hospital_weight, hospital_baseline_demand,
                residential_priority, residential_weight, residential_baseline_demand,
                industrial_priority, industrial_weight, industrial_baseline_demand,
                default_strategy, updated_at
         FROM user_settings WHERE user_id = $1`,
        [userId]
      );
      if (res.rows[0]) return res.rows[0];
    } catch (e) {
      console.warn('[GridWise DB] getUserSettings error:', e.message);
    }
  }
  return dbState.fallbackSettings.get(userId) || {
    hospital_priority: 1, hospital_weight: 3.0, hospital_baseline_demand: 30,
    residential_priority: 2, residential_weight: 2.0, residential_baseline_demand: 70,
    industrial_priority: 3, industrial_weight: 1.0, industrial_baseline_demand: 50,
    default_strategy: 'priority'
  };
}

/** Update user settings */
async function updateUserSettings(userId, s) {
  if (dbState.connected) {
    try {
      const res = await pool.query(
        `INSERT INTO user_settings (user_id, hospital_priority, hospital_weight, residential_priority, residential_weight, industrial_priority, industrial_weight, default_strategy, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           hospital_priority = EXCLUDED.hospital_priority,
           hospital_weight = EXCLUDED.hospital_weight,
           residential_priority = EXCLUDED.residential_priority,
           residential_weight = EXCLUDED.residential_weight,
           industrial_priority = EXCLUDED.industrial_priority,
           industrial_weight = EXCLUDED.industrial_weight,
           default_strategy = EXCLUDED.default_strategy,
           updated_at = NOW()
         RETURNING *`,
        [
          userId,
          s.hospital_priority || 1, s.hospital_weight || 3.0,
          s.residential_priority || 2, s.residential_weight || 2.0,
          s.industrial_priority || 3, s.industrial_weight || 1.0,
          s.default_strategy || 'priority'
        ]
      );
      return res.rows[0];
    } catch (e) {
      console.warn('[GridWise DB] updateUserSettings error:', e.message);
    }
  }

  // Fallback
  const current = dbState.fallbackSettings.get(userId) || {};
  const updated = {
    ...current,
    hospital_priority: s.hospital_priority || 1,
    hospital_weight: s.hospital_weight || 3.0,
    residential_priority: s.residential_priority || 2,
    residential_weight: s.residential_weight || 2.0,
    industrial_priority: s.industrial_priority || 3,
    industrial_weight: s.industrial_weight || 1.0,
    default_strategy: s.default_strategy || 'priority',
    updated_at: new Date().toISOString()
  };
  dbState.fallbackSettings.set(userId, updated);
  return updated;
}

/** Save a complete simulation run and its allocation breakdowns */
async function saveSimulationRun(userId, runData, consumers) {
  if (dbState.connected) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const runRes = await client.query(
        `INSERT INTO simulation_runs (
           user_id, mode, strategy, simulated_hour, solar_fault,
           supply_solar, supply_wind, supply_hydro, supply_battery, supply_external_grid,
           supply_renewable_total, supply_total, demand_total, allocated_total, unmet_total,
           shortage, surplus, coverage_pct, fully_met_count
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         RETURNING id, executed_at`,
        [
          userId || null, runData.mode || 'auto', runData.strategy || 'priority',
          runData.simulated_hour || 12, runData.solar_fault || false,
          runData.supply_solar || 0, runData.supply_wind || 0, runData.supply_hydro || 0,
          runData.supply_battery || 0, runData.supply_external_grid || 0,
          runData.supply_renewable_total || 0, runData.supply_total || 0,
          runData.demand_total || 0, runData.allocated_total || 0, runData.unmet_total || 0,
          runData.shortage || 0, runData.surplus || 0, runData.coverage_pct || 0,
          runData.fully_met_count || 0
        ]
      );
      const runId = runRes.rows[0].id;

      if (Array.isArray(consumers)) {
        for (const c of consumers) {
          await client.query(
            `INSERT INTO allocation_breakdowns (
               simulation_run_id, consumer_name, consumer_label, priority_rank,
               weight, demand_kwh, allocated_kwh, unmet_kwh, satisfaction_pct, fully_satisfied
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              runId, c.name, c.label || c.name, c.priority || 1,
              c.weight || 1, c.demand || 0, c.allocated || 0, c.unmet || 0,
              c.demand > 0 ? Math.min(100, Math.round((c.allocated / c.demand) * 100)) : 100,
              (c.unmet || 0) < 0.001
            ]
          );
        }
      }
      await client.query('COMMIT');
      return { id: runId, executed_at: runRes.rows[0].executed_at };
    } catch (e) {
      await client.query('ROLLBACK');
      console.warn('[GridWise DB] saveSimulationRun transaction error:', e.message);
    } finally {
      client.release();
    }
  }

  // Fallback
  const id = 'sim-' + Date.now();
  const entry = {
    id,
    userId,
    runData,
    consumers,
    executed_at: new Date().toISOString()
  };
  dbState.fallbackSimulations.unshift(entry);
  if (dbState.fallbackSimulations.length > 50) dbState.fallbackSimulations.pop();
  return { id, executed_at: entry.executed_at };
}

/** Get historical simulation runs */
async function getSimulationHistory(userId, limit = 20) {
  if (dbState.connected) {
    try {
      const res = await pool.query(
        `SELECT id, mode, strategy, simulated_hour, supply_total, demand_total,
                allocated_total, shortage, surplus, coverage_pct, fully_met_count, executed_at
         FROM simulation_runs
         WHERE ($1::uuid IS NULL OR user_id = $1)
         ORDER BY executed_at DESC LIMIT $2`,
        [userId || null, limit]
      );
      return res.rows;
    } catch (e) {
      console.warn('[GridWise DB] getSimulationHistory error:', e.message);
    }
  }
  return dbState.fallbackSimulations.slice(0, limit);
}

module.exports = {
  pool,
  dbState,
  initDatabase,
  query,
  findUserByEmail,
  createUser,
  createSession,
  verifySession,
  revokeSession,
  getUserSettings,
  updateUserSettings,
  saveSimulationRun,
  getSimulationHistory
};
