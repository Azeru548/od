/* Tiny local server for the Security Dues PWA.
   Serves the static app. The ledger itself lives in Firebase Firestore and is
   read and written by the browser, so this server stores nothing.
   Usage: npm start   (or: node serve.js)
   Then open http://localhost:4173 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 4173;

// Optional password gate for public deployments. Leave APP_PASSWORD unset locally.
const APP_USER = process.env.APP_USER || 'admin';
const APP_PASSWORD = process.env.APP_PASSWORD || '';

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

function handleApi(req, res, pathname) {
  if (pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, storage: 'firestore' });
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
    handleApi(req, res, pathname);
    return;
  }

  // Left over from the SQLite days: never serve the local data directory.
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
  console.log('Storage: Firebase Firestore (ledgers/main)');
  console.log(`Password protection: ${APP_PASSWORD ? 'on (' + APP_USER + ')' : 'off'}`);
});
