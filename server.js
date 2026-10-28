/**
 * ═══════════════════════════════════════════════════════════════════════
 * GRIDWISE SECURE BACKEND & TELEMETRY PROXY SERVER
 * Node.js + Express.js + PostgreSQL (pg) + JWT Authentication
 * ───────────────────────────────────────────────────────────────────────
 * Setup instructions:
 * 1. npm install
 * 2. node server.js
 * Default Port: 3000 (with automatic fallback to 3001 if occupied)
 * ═══════════════════════════════════════════════════════════════════════
 */

'use strict';

const path = require('path');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const db = require('./db');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'gridwise_energy_os_secure_key_2026';

const fs = require('fs');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// Explicit root route for SPA / Vercel serverless compatibility
app.get('/', (req, res) => {
  const publicIndex = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(publicIndex)) {
    return res.sendFile(publicIndex);
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Helper: PBKDF2 hash (100,000 iterations, SHA-256)
function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex');
}

/**
 * Authentication Middleware: Verifies Bearer JWT token against database session
 */
async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ ok: false, message: 'Access denied. Missing Bearer token.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const sessionUser = await db.verifySession(tokenHash);
    if (!sessionUser) {
      return res.status(401).json({ ok: false, message: 'Session expired or revoked. Please sign in again.' });
    }

    req.user = sessionUser;
    req.tokenHash = tokenHash;
    next();
  } catch (err) {
    return res.status(403).json({ ok: false, message: 'Invalid or expired token.' });
  }
}

// ─────────────────────────────────────────────────────────────────
// AUTHENTICATION ENDPOINTS
// ─────────────────────────────────────────────────────────────────

// 1. Health check & DB status endpoint
app.get('/api/auth/health', (req, res) => {
  res.json({
    status: 'online',
    service: 'GridWise Energy OS Backend v2.0',
    database: db.dbState.connected ? 'postgresql' : 'fallback-memory',
    timestamp: new Date().toISOString()
  });
});

// 2. Sign In Endpoint
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required.' });
  }

  try {
    const user = await db.findUserByEmail(email);
    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials. Operator not found.' });
    }

    const testHash = hashPassword(password, user.salt);
    if (testHash !== user.hash) {
      return res.status(401).json({ message: 'Invalid credentials. Password incorrect.' });
    }

    // Generate signed JWT token
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '4h' }
    );
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = Date.now() + (4 * 60 * 60 * 1000);

    await db.createSession({
      userId: user.id,
      tokenHash,
      ip: req.ip || req.headers['x-forwarded-for'],
      userAgent: req.headers['user-agent'],
      expiresAt
    });

    res.json({
      token,
      expiresInMs: 4 * 60 * 60 * 1000,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        organization: user.organization
      }
    });
  } catch (err) {
    console.error('[GridWise Auth Login Error]', err);
    res.status(500).json({ message: 'Authentication service encountered an internal error.' });
  }
});

// 3. Sign Up Endpoint
app.post('/api/auth/signup', async (req, res) => {
  const { name, email, password, role, organization } = req.body || {};
  const normalizedEmail = (email || '').toLowerCase().trim();

  if (!name || !normalizedEmail || !password) {
    return res.status(400).json({ message: 'Missing required registration fields.' });
  }

  try {
    const existing = await db.findUserByEmail(normalizedEmail);
    if (existing) {
      return res.status(409).json({ message: 'Operator account already registered with this email.' });
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(password, salt);

    const newUser = await db.createUser({
      name,
      email: normalizedEmail,
      role: role || 'Grid Controller',
      organization: organization || 'Regional Grid Node',
      salt,
      hash
    });

    res.status(201).json({
      message: 'Operator account registered successfully.',
      user: {
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
        role: newUser.role,
        organization: newUser.organization
      }
    });
  } catch (err) {
    console.error('[GridWise Auth Signup Error]', err);
    res.status(500).json({ message: 'Registration service encountered an internal error.' });
  }
});

// 4. Logout / Session Invalidation
app.post('/api/auth/logout', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (token) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await db.revokeSession(tokenHash);
  }
  res.json({ ok: true, message: 'Operator logged out successfully.' });
});

// 5. Current Authenticated Operator Profile
app.get('/api/auth/me', authenticateToken, (req, res) => {
  res.json({ ok: true, user: req.user });
});

// ─────────────────────────────────────────────────────────────────
// SETTINGS & SIMULATION RUNS PERSISTENCE
// ─────────────────────────────────────────────────────────────────

// Get User Settings
app.get('/api/settings', authenticateToken, async (req, res) => {
  try {
    const settings = await db.getUserSettings(req.user.user_id);
    res.json({ ok: true, settings });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Update User Settings (Hospital priority invariant preserved)
app.put('/api/settings', authenticateToken, async (req, res) => {
  try {
    const body = req.body || {};
    // Ensure hospital priority is respected as priority 1
    const safeSettings = {
      hospital_priority: parseInt(body.hospital_priority, 10) || 1,
      hospital_weight: parseFloat(body.hospital_weight) || 3.0,
      residential_priority: parseInt(body.residential_priority, 10) || 2,
      residential_weight: parseFloat(body.residential_weight) || 2.0,
      industrial_priority: parseInt(body.industrial_priority, 10) || 3,
      industrial_weight: parseFloat(body.industrial_weight) || 1.0,
      default_strategy: body.default_strategy || 'priority'
    };

    const updated = await db.updateUserSettings(req.user.user_id, safeSettings);
    res.json({ ok: true, settings: updated });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Save Simulation Run
app.post('/api/simulations', async (req, res) => {
  try {
    const { runData, consumers } = req.body || {};
    if (!runData) {
      return res.status(400).json({ ok: false, message: 'Missing runData payload.' });
    }

    let userId = null;
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        userId = decoded.userId;
      } catch (e) {
        // Optional auth: unauthenticated runs are saved with userId = null
      }
    }

    const saved = await db.saveSimulationRun(userId, runData, consumers);
    res.status(201).json({ ok: true, runId: saved.id, executed_at: saved.executed_at });
  } catch (err) {
    console.error('[GridWise Save Simulation Error]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Get Simulation History
app.get('/api/simulations/history', async (req, res) => {
  try {
    let userId = null;
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        userId = decoded.userId;
      } catch (e) {}
    }
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);
    const history = await db.getSimulationHistory(userId, limit);
    res.json({ ok: true, history });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// INDIA ENERGY DATA PROXY & 5-MINUTE CACHE
// Upstream: https://india-energy-data.vercel.app/api/v1
// ═══════════════════════════════════════════════════════════════════════
const UPSTREAM_API_BASE = process.env.UPSTREAM_API_BASE || 'https://india-energy-data.vercel.app/api/v1';
const CACHE_TTL_MS = parseInt(process.env.INDIA_CACHE_TTL_MS, 10) || (5 * 60 * 1000);
const indiaApiCache = new Map();

/**
 * Fetch helper with timeout and 5-minute memory caching
 */
async function fetchWithCache(cacheKey, url, timeoutMs = 8000) {
  const cached = indiaApiCache.get(cacheKey);
  const now = Date.now();

  // Return fresh cached copy if within TTL
  if (cached && (now - cached.timestamp < CACHE_TTL_MS)) {
    return {
      ok: true,
      data: cached.data,
      cached: true,
      stale: false,
      cachedAt: new Date(cached.timestamp).toISOString(),
      expiresInSec: Math.round((CACHE_TTL_MS - (now - cached.timestamp)) / 1000)
    };
  }

  // Attempt upstream fetch
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'GridWise-EnergyOS/2.0'
      }
    });
    clearTimeout(timer);

    if (!resp.ok) {
      throw new Error(`Upstream API responded with HTTP ${resp.status} ${resp.statusText}`);
    }

    const data = await resp.json();
    indiaApiCache.set(cacheKey, { data, timestamp: now });

    return {
      ok: true,
      data,
      cached: false,
      stale: false,
      cachedAt: new Date(now).toISOString(),
      expiresInSec: Math.round(CACHE_TTL_MS / 1000)
    };
  } catch (err) {
    clearTimeout(timer);
    // If upstream failed but we have stale cache, return it with stale: true
    if (cached) {
      return {
        ok: true,
        data: cached.data,
        cached: true,
        stale: true,
        warning: `Upstream fetch failed (${err.message}). Serving last known cached data.`,
        cachedAt: new Date(cached.timestamp).toISOString(),
        expiresInSec: 0
      };
    }
    // No cache available
    return {
      ok: false,
      error: err.name === 'AbortError' ? 'Upstream API request timed out (8s)' : err.message,
      status: 503
    };
  }
}

// 1. All Zones list with latest demand_met
app.get('/api/india/zones', async (req, res) => {
  const result = await fetchWithCache('zones', `${UPSTREAM_API_BASE}/zones`);
  if (!result.ok) {
    return res.status(result.status || 500).json(result);
  }
  res.json(result);
});

// 2. Live telemetry for a specific zone (defaults to National 'IN')
app.get('/api/india/live', async (req, res) => {
  const zoneId = (req.query.zone || 'IN').toUpperCase().trim();
  const cacheKey = `zone_live_${zoneId}`;
  const result = await fetchWithCache(cacheKey, `${UPSTREAM_API_BASE}/zone/${encodeURIComponent(zoneId)}/live`);
  if (!result.ok) {
    return res.status(result.status || 500).json(result);
  }
  res.json(result);
});

// 3. System and scraper health status
app.get('/api/india/status', async (req, res) => {
  const result = await fetchWithCache('status', `${UPSTREAM_API_BASE}/status`);
  if (!result.ok) {
    return res.status(result.status || 500).json(result);
  }
  res.json(result);
});

// 4. Cache diagnostic / clear (for tests and verification)
app.post('/api/india/cache/clear', (req, res) => {
  const clearedCount = indiaApiCache.size;
  indiaApiCache.clear();
  res.json({ ok: true, cleared: clearedCount, timestamp: new Date().toISOString() });
});

if (require.main === module) {
  function startServer(port) {
    const server = app.listen(port, async () => {
      console.log(`[GridWise Backend] GridWise Server & India API Proxy listening on http://localhost:${port}`);
      await db.initDatabase();
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && (port === 3000 || port === '3000')) {
        console.warn(`[GridWise Backend] Port 3000 in use, falling back to port 3001...`);
        startServer(3001);
      } else {
        console.error(`[GridWise Backend] Server error:`, err);
      }
    });
  }
  startServer(PORT);
}

module.exports = app;
