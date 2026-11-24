import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { botManager } from './botManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');
const PORT = Number(process.env.PORT) || 3000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 16 * 1024) {
      throw new Error('Payload terlalu besar');
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

async function serveStatic(res, reqPath) {
  const safePath = reqPath === '/' ? '/index.html' : reqPath;
  const fullPath = path.resolve(PUBLIC_DIR, '.' + safePath);

  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const content = await fs.readFile(fullPath);
    const ext = path.extname(fullPath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  try {
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return sendJson(res, 200, botManager.getStatus());
    }

    if (req.method === 'POST' && url.pathname === '/api/pair') {
      const body = await readJsonBody(req);
      const code = await botManager.requestPairing(body.phone);
      return sendJson(res, 200, {
        ok: true,
        code,
        status: botManager.getStatus(),
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/logout') {
      await botManager.logout();
      return sendJson(res, 200, {
        ok: true,
        status: botManager.getStatus(),
      });
    }

    if (req.method === 'GET') {
      return serveStatic(res, url.pathname);
    }

    res.writeHead(405);
    res.end('Method Not Allowed');
  } catch (err) {
    console.error('[HTTP ERROR]', err?.message || err);
    return sendJson(res, 400, {
      ok: false,
      error: err?.message || 'Terjadi kesalahan pada server',
    });
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`[WEB] Server Pairing Bot aktif di port ${PORT}`);
  await botManager.startIfHasSession();
});
