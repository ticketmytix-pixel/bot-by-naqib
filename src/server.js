import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import {
  loadStore,
  flushStoreNow,
  upsertGoogleUser,
  markUserPhoneVerified,
  unverifyUserPhone,
  createSessionToken,
  getUserBySession,
  deleteSessionToken,
  listUsers,
  setUserRole,
  isVipActive,
} from './store.js';
import { multiBotManager } from './multiBotManager.js';
import { searchSpotifyTracks, getSpotifyStreamFile } from './features/tools.js';
import { attachXoxSseClient, handleXoxRoomAction } from './features/xoxRooms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');
const PORT = Number(process.env.PORT) || 3000;
const VIP_WA_NUMBER = '085185779714';
const VIP_WA_INTL = '6285185779714';
const COOKIE_NAME = 'naqib_session';
const OAUTH_STATE_COOKIE = 'naqib_oauth_state';

const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
const GOOGLE_CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
const GOOGLE_OAUTH_ENABLED = Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// ==================== IN-MEMORY STATIC CACHE + GZIP (ANTI-LAG) ====================
const staticCache = new Map(); // reqPath -> { raw, gzip, type }

async function preloadStaticAssets() {
  const routes = [
    ['index.html', '/'],
    ['index.html', '/index.html'],
    ['style.css', '/style.css'],
    ['app.js', '/app.js'],
    ['spotify.html', '/app/spotify'],
    ['xox.html', '/app/xox'],
  ];
  for (const [file, route] of routes) {
    try {
      const fullPath = path.join(PUBLIC_DIR, file);
      const raw = await fs.readFile(fullPath);
      const gzip = zlib.gzipSync(raw, { level: 6 });
      const ext = path.extname(file);
      staticCache.set(route, {
        raw,
        gzip,
        type: MIME_TYPES[ext] || 'application/octet-stream',
      });
    } catch {
      // Abaikan jika file belum ada
    }
  }
}

// ==================== LIGHTWEIGHT IP RATE LIMITER ====================
const rateBuckets = new Map(); // ip -> { count, resetAt }
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQ = 120;

function checkRateLimit(req) {
  const ip =
    String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 1, resetAt: now + RATE_WINDOW_MS };
    rateBuckets.set(ip, bucket);
    return true;
  }
  bucket.count += 1;
  return bucket.count <= RATE_MAX_REQ;
}

// ==================== OTP STORE (MEMORY-BOUNDED) ====================
// email -> { code, phone, expiresAt, resendAt, attempts }
const otpStore = new Map();

// Pembersihan periodik agar RAM selalu kecil & tidak bocor
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) {
    if (v.resetAt <= now) rateBuckets.delete(k);
  }
  for (const [k, v] of otpStore) {
    if (v.expiresAt <= now) otpStore.delete(k);
  }
}, 60_000).unref();

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = decodeURIComponent(part.slice(idx + 1).trim());
    out[k] = v;
  }
  return out;
}

function appendCookie(res, cookieStr) {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) {
    res.setHeader('Set-Cookie', [cookieStr]);
  } else if (Array.isArray(prev)) {
    res.setHeader('Set-Cookie', [...prev, cookieStr]);
  } else {
    res.setHeader('Set-Cookie', [prev, cookieStr]);
  }
}

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
    if (total > 24 * 1024) throw new Error('Payload terlalu besar');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function getBaseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function serveCachedStatic(req, res, pathname) {
  const entry = staticCache.get(pathname);
  if (!entry) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }
  const acceptGzip = String(req.headers['accept-encoding'] || '').includes('gzip');
  const buf = acceptGzip ? entry.gzip : entry.raw;
  const headers = {
    'Content-Type': entry.type,
    'Content-Length': buf.length,
    'Cache-Control': pathname === '/' ? 'no-cache' : 'public, max-age=300',
  };
  if (acceptGzip) headers['Content-Encoding'] = 'gzip';
  res.writeHead(200, headers);
  res.end(buf);
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  // Serve static assets langsung dari RAM cache (ultra cepat)
  if (req.method === 'GET' && staticCache.has(url.pathname)) {
    return serveCachedStatic(req, res, url.pathname);
  }

  // Rate limit untuk API & auth
  if (url.pathname.startsWith('/api/') && !checkRateLimit(req)) {
    return sendJson(res, 429, { ok: false, error: 'Terlalu banyak permintaan. Coba lagi sebentar.' });
  }

  const cookies = parseCookies(req);
  const currentUser = await getUserBySession(cookies[COOKIE_NAME]);

  try {
    // ==================== GOOGLE OAUTH2 RESMI ====================
    if (req.method === 'GET' && url.pathname === '/auth/google') {
      if (!GOOGLE_OAUTH_ENABLED) {
        res.writeHead(302, { Location: '/?auth_error=oauth_not_configured' });
        res.end();
        return;
      }

      const state = crypto.randomBytes(16).toString('hex');
      appendCookie(res, `${OAUTH_STATE_COOKIE}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`);

      const redirectUri = `${getBaseUrl(req)}/auth/google/callback`;
      const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        prompt: 'select_account',
        state,
      });

      res.writeHead(302, {
        Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
      });
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/auth/google/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const expectedState = cookies[OAUTH_STATE_COOKIE];

      appendCookie(res, `${OAUTH_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);

      if (!code || !GOOGLE_OAUTH_ENABLED || !state || !expectedState || !timingSafeEqualStr(state, expectedState)) {
        res.writeHead(302, { Location: '/?auth_error=invalid_state' });
        res.end();
        return;
      }

      const redirectUri = `${getBaseUrl(req)}/auth/google/callback`;
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });
      const tokenJson = await tokenRes.json();
      if (!tokenJson.access_token) {
        res.writeHead(302, { Location: '/?auth_error=token_failed' });
        res.end();
        return;
      }

      const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokenJson.access_token}` },
      });
      const profile = await profileRes.json();
      if (!profile?.email || profile.verified_email === false) {
        res.writeHead(302, { Location: '/?auth_error=email_unverified' });
        res.end();
        return;
      }

      const user = await upsertGoogleUser({
        email: profile.email,
        name: profile.name,
        picture: profile.picture,
      });

      const sessionToken = await createSessionToken(user.email);
      appendCookie(
        res,
        `${COOKIE_NAME}=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`
      );
      res.writeHead(302, { Location: '/' });
      res.end();
      return;
    }

    // ==================== AUTH STATUS & LOGOUT ====================
    if (req.method === 'GET' && url.pathname === '/api/me') {
      const enrichedUser = currentUser
        ? {
            ...currentUser,
            vipActive: isVipActive(currentUser),
            vipExpired: currentUser.role === 'buyer' && !isVipActive(currentUser),
          }
        : null;

      return sendJson(res, 200, {
        user: enrichedUser,
        googleOAuthEnabled: GOOGLE_OAUTH_ENABLED,
        vipWaNumber: VIP_WA_NUMBER,
        vipWaIntl: VIP_WA_INTL,
        globalStats: multiBotManager.getGlobalStats(),
      });
    }

    if (
      (req.method === 'POST' && url.pathname === '/api/auth/logout') ||
      (req.method === 'GET' && url.pathname === '/auth/logout')
    ) {
      if (cookies[COOKIE_NAME]) {
        await deleteSessionToken(cookies[COOKIE_NAME]);
        await flushStoreNow();
      }
      const clearHeader = `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
      if (req.method === 'GET') {
        res.writeHead(302, {
          'Set-Cookie': clearHeader,
          Location: '/',
          'Cache-Control': 'no-store',
        });
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': clearHeader,
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ==================== WHATSAPP OTP VERIFICATION ====================
    if (req.method === 'POST' && url.pathname === '/api/otp/send') {
      if (!currentUser) {
        return sendJson(res, 401, { ok: false, error: 'Silakan login dengan Google terlebih dahulu.' });
      }
      const body = await readJsonBody(req);
      const now = Date.now();
      const prev = otpStore.get(currentUser.email);
      if (prev && prev.resendAt > now) {
        const waitSec = Math.ceil((prev.resendAt - now) / 1000);
        return sendJson(res, 429, {
          ok: false,
          error: `Tunggu ${waitSec} detik sebelum meminta kode OTP baru.`,
        });
      }

      const code = String(crypto.randomInt(100000, 1000000));
      const cleanPhone = await multiBotManager.sendOtpToPhone(body.phone, code);

      otpStore.set(currentUser.email, {
        code,
        phone: cleanPhone,
        expiresAt: now + 5 * 60 * 1000,
        resendAt: now + 60 * 1000,
        attempts: 0,
      });

      return sendJson(res, 200, {
        ok: true,
        phone: cleanPhone,
        expiresInSeconds: 300,
        message: `Kode OTP 6 digit telah dikirim ke WhatsApp +${cleanPhone}.`,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/otp/verify') {
      if (!currentUser) {
        return sendJson(res, 401, { ok: false, error: 'Silakan login terlebih dahulu.' });
      }
      const body = await readJsonBody(req);
      const inputCode = String(body.code || '').replace(/\D/g, '');
      const record = otpStore.get(currentUser.email);

      if (!record) {
        return sendJson(res, 400, {
          ok: false,
          error: 'Belum ada kode OTP aktif. Klik Kirim Kode OTP terlebih dahulu.',
        });
      }
      if (record.expiresAt < Date.now()) {
        otpStore.delete(currentUser.email);
        return sendJson(res, 400, {
          ok: false,
          error: 'Kode OTP sudah kadaluarsa. Silakan kirim ulang kode baru.',
        });
      }
      if (record.attempts >= 5) {
        otpStore.delete(currentUser.email);
        return sendJson(res, 429, {
          ok: false,
          error: 'Terlalu banyak percobaan salah. Silakan kirim ulang OTP baru.',
        });
      }

      record.attempts += 1;
      if (!timingSafeEqualStr(inputCode, record.code)) {
        return sendJson(res, 400, {
          ok: false,
          error: `Kode OTP tidak sesuai (sisa ${Math.max(0, 5 - record.attempts)} percobaan).`,
        });
      }

      otpStore.delete(currentUser.email);
      const updatedUser = await markUserPhoneVerified(currentUser.email, record.phone);

      return sendJson(res, 200, {
        ok: true,
        user: updatedUser,
        message: 'Nomor WhatsApp berhasil diverifikasi!',
      });
    }

    // ==================== MULTI-BOT API ====================
    if (req.method === 'GET' && url.pathname === '/api/bots') {
      if (!currentUser) {
        return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
      }
      return sendJson(res, 200, {
        ok: true,
        bots: multiBotManager.listBotsForUser(currentUser),
        globalStats: multiBotManager.getGlobalStats(),
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/bots/pair') {
      if (!currentUser) {
        return sendJson(res, 401, { ok: false, error: 'Silakan login dengan Google terlebih dahulu.' });
      }

      // Wajib verifikasi OTP WA dulu (kecuali Owner saat bootstrapping bot pertama ketika belum ada bot online)
      const hasOnlineBot = multiBotManager.getGlobalStats().activeBots > 0;
      if (!currentUser.phoneVerified && !(currentUser.role === 'owner' && !hasOnlineBot)) {
        return sendJson(res, 403, {
          ok: false,
          error: 'Nomor WhatsApp akun Anda belum terverifikasi OTP. Selesaikan verifikasi OTP terlebih dahulu.',
        });
      }

      if (!isVipActive(currentUser)) {
        const isExpired = currentUser.role === 'buyer';
        return sendJson(res, 403, {
          ok: false,
          error: isExpired
            ? `Masa aktif VIP Anda telah berakhir. Silakan perpanjang pembayaran ke WA Owner ${VIP_WA_NUMBER}.`
            : `Fitur ini khusus VIP (Role Buyer). Hubungi WA ${VIP_WA_NUMBER} untuk beli bot.`,
        });
      }

      const body = await readJsonBody(req);
      if (!body.acceptedTos) {
        return sendJson(res, 400, {
          ok: false,
          error: 'Anda wajib menyetujui peringatan aturan WhatsApp sebelum pairing.',
        });
      }

      const result = await multiBotManager.createAndPairBot({
        ownerEmail: currentUser.email,
        phone: body.phone,
        packName: body.packName,
        packAuthor: body.packAuthor,
      });
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === 'PATCH' && url.pathname.startsWith('/api/bots/')) {
      if (!currentUser) {
        return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
      }
      const botId = decodeURIComponent(url.pathname.slice('/api/bots/'.length));
      const body = await readJsonBody(req);
      const bot = await multiBotManager.updateBotProfile(botId, currentUser, {
        packName: body.packName,
        packAuthor: body.packAuthor,
      });
      return sendJson(res, 200, { ok: true, bot });
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/bots/')) {
      if (!currentUser) {
        return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
      }
      const botId = decodeURIComponent(url.pathname.slice('/api/bots/'.length));
      await multiBotManager.removeBot(botId, currentUser);
      return sendJson(res, 200, { ok: true });
    }

    // ==================== OWNER ADMIN API ====================
    if (req.method === 'GET' && url.pathname === '/api/admin/users') {
      if (!currentUser || currentUser.role !== 'owner') {
        return sendJson(res, 403, { ok: false, error: 'Khusus Owner.' });
      }
      const users = await listUsers();
      return sendJson(res, 200, { ok: true, users });
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/users/role') {
      if (!currentUser || currentUser.role !== 'owner') {
        return sendJson(res, 403, { ok: false, error: 'Khusus Owner.' });
      }
      const body = await readJsonBody(req);
      if (body.email?.toLowerCase() === currentUser.email && body.role !== 'owner') {
        return sendJson(res, 400, { ok: false, error: 'Owner tidak bisa menurunkan role akun sendiri.' });
      }
      const updated = await setUserRole(body.email, body.role, body.durationDays);
      return sendJson(res, 200, { ok: true, user: updated });
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/users/unverify') {
      if (!currentUser || currentUser.role !== 'owner') {
        return sendJson(res, 403, { ok: false, error: 'Khusus Owner.' });
      }
      const body = await readJsonBody(req);
      const updated = await unverifyUserPhone(body.email);
      return sendJson(res, 200, { ok: true, user: updated });
    }

    // ==================== SPOTIFY LIVE IN-APP WEBVIEW API ====================
    if (req.method === 'GET' && url.pathname === '/api/spotify/search') {
      const q = url.searchParams.get('q') || 'Tulus Teh Hijau';
      const tracks = await searchSpotifyTracks(q);
      return sendJson(res, 200, { ok: true, tracks });
    }

    if (req.method === 'GET' && url.pathname === '/api/spotify/stream') {
      const trackUrl = url.searchParams.get('url');
      const filePath = await getSpotifyStreamFile(trackUrl);
      const stat = await fs.stat(filePath);
      const total = stat.size;
      const range = req.headers.range;

      if (range) {
        const match = /bytes=(\d+)-(\d*)/.exec(range);
        const start = match ? Number(match[1]) : 0;
        const end = match && match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
        const fh = await fs.open(filePath, 'r');
        const chunkLen = end - start + 1;
        const buf = Buffer.alloc(chunkLen);
        await fh.read(buf, 0, chunkLen, start);
        await fh.close();
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkLen,
          'Content-Type': 'audio/mpeg',
          'Cache-Control': 'public, max-age=600',
        });
        res.end(buf);
        return;
      }

      const fullBuf = await fs.readFile(filePath);
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': total,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=600',
      });
      res.end(fullBuf);
      return;
    }

    // ==================== XOX LIVE REAL-TIME SSE STREAM (TOKEN 6 ANGKA) ====================
    if (req.method === 'GET' && url.pathname === '/api/xox/stream') {
      const token = String(url.searchParams.get('token') || '').replace(/\D/g, '');
      if (token.length !== 6) {
        res.writeHead(400);
        res.end('Invalid token');
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');

      const detach = attachXoxSseClient(token, res);
      const keepAlive = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          clearInterval(keepAlive);
        }
      }, 20000);

      req.on('close', () => {
        clearInterval(keepAlive);
        detach();
      });
      return;
    }

    // ==================== XOX LIVE PVP ROOM API (TOKEN 6 ANGKA) ====================
    if (req.method === 'POST' && url.pathname === '/api/xox/room') {
      const body = await readJsonBody(req);
      const result = handleXoxRoomAction({
        token: body.token,
        clientId: String(body.clientId || '').slice(0, 32),
        action: body.action || 'join',
        idx: body.idx,
      });
      return sendJson(res, result.ok ? 200 : 404, result);
    }

    res.writeHead(404);
    res.end('Not Found');
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

await loadStore();
await preloadStaticAssets();

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`[WEB] Bot by Naqib Platform (Lightweight + Gzip + Rate-Limit) aktif di port ${PORT}`);
  console.log(`[AUTH] Official Google OAuth2: ${GOOGLE_OAUTH_ENABLED ? 'READY' : 'PERLU GOOGLE_CLIENT_ID & GOOGLE_CLIENT_SECRET di .env'}`);
  await multiBotManager.bootSavedBots();
});
