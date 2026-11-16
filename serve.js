/* Tiny local server for the Security Dues PWA.
   Serves the static app and stores records in a small SQLite database.
   Usage: npm start   (or: node serve.js)
   Then open http://localhost:4173
   Database file: data/security-dues.db
   Requires Node.js 22.5+ for the built-in node:sqlite module. */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'security-dues.db');
const PORT = Number(process.env.PORT) || 4173;
const MAX_BODY = 10 * 1024 * 1024;

// Optional password gate for public deployments. Leave APP_PASSWORD unset locally.
const APP_USER = process.env.APP_USER || 'admin';
const APP_PASSWORD = process.env.APP_PASSWORD || '';

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`CREATE TABLE IF NOT EXISTS app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return require('crypto').timingSafeEqual(left, right);
}

function authorized(req) {
  if (!APP_PASSWORD) return true;
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const split = decoded.indexOf(':');
  if (split < 0) return false;
  const user = decoded.slice(0, split);
  const pass = decoded.slice(split + 1);
  return safeEqual(user, APP_USER) && safeEqual(pass, APP_PASSWORD);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        const err = new Error('Payload too large');
        err.code = 'TOO_LARGE';
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function validLedger(data) {
  return Boolean(
    data
    && typeof data === 'object'
    && data.settings
    && typeof data.settings === 'object'
    && Array.isArray(data.residents)
    && Array.isArray(data.payments)
  );
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, storage: 'sqlite', file: path.relative(ROOT, DB_FILE) });
    return;
  }

  if (pathname === '/api/state' && req.method === 'GET') {
    const row = db.prepare('SELECT data, updated_at FROM app_state WHERE id = 1').get();
    if (!row) {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    let data = null;
    try {
      data = JSON.parse(row.data);
    } catch (err) {
      console.error('Stored ledger is not valid JSON', err);
    }
    if (!data) {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    sendJson(res, 200, { data, updatedAt: row.updated_at });
    return;
  }

  if (pathname === '/api/state' && req.method === 'PUT') {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      const tooLarge = err.code === 'TOO_LARGE';
      sendJson(res, tooLarge ? 413 : 400, { error: tooLarge ? 'Payload too large' : 'Invalid JSON' });
      return;
    }

    if (!validLedger(body && body.data)) {
      sendJson(res, 400, { error: 'Invalid ledger data' });
      return;
    }

    const updatedAt = typeof body.updatedAt === 'string' && !Number.isNaN(Date.parse(body.updatedAt))
      ? body.updatedAt
      : new Date().toISOString();

    db.prepare(`INSERT INTO app_state (id, data, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
      .run(JSON.stringify(body.data), updatedAt);

    sendJson(res, 200, { ok: true, updatedAt });
    return;
  }

  sendJson(res, 404, { error: 'Unknown API route' });
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  // Render health checks stay open; everything else can be password protected.
  if (pathname !== '/api/health' && !authorized(req)) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="Security Dues", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8'
    });
    res.end('Authentication required');
    return;
  }

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname).catch((err) => {
      console.error('API error', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Server error' });
      else res.end();
    });
    return;
  }

  if (pathname === '/data' || pathname.startsWith('/data/')) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (pathname === '/') pathname = '/index.html';

  const filePath = path.normalize(path.join(ROOT, pathname));
  if (!filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Single-page app fallback for unknown paths.
      if (!path.extname(filePath)) {
        fs.readFile(path.join(ROOT, 'index.html'), (err2, html) => {
          if (err2) { res.writeHead(404); res.end('Not found'); return; }
          res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
          res.end(html);
        });
        return;
      }
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Security Dues running at http://localhost:${PORT}`);
  console.log(`SQLite database: ${DB_FILE}`);
  console.log(`Password protection: ${APP_PASSWORD ? 'on (' + APP_USER + ')' : 'off'}`);
});
