import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const STORAGE_ROOT = path.resolve(process.cwd(), process.env.STORAGE_DIR || 'storage');
const DATA_DIR = path.join(STORAGE_ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

const DEFAULT_DB = {
  users: {},
  sessions: {},
  bots: {},
  groupSettings: {},
  trialUsage: {},
};

let db = structuredClone(DEFAULT_DB);
let loaded = false;
let saveTimer = null;
let savingPromise = null;

export async function loadStore() {
  if (loaded) return db;
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(DB_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    db = {
      users: parsed.users || {},
      sessions: parsed.sessions || {},
      bots: parsed.bots || {},
      groupSettings: parsed.groupSettings || {},
      trialUsage: parsed.trialUsage || {},
    };
  } catch {
    db = structuredClone(DEFAULT_DB);
    await flushStoreNow();
  }
  loaded = true;
  return db;
}

/**
 * Penulisan disk digabung (debounced 400ms) agar server tetap ringan & tidak lag
 * saat banyak pengunjung mengakses bersamaan.
 */
export function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushStoreNow().catch((err) => console.error('[STORE SAVE ERROR]', err?.message || err));
  }, 400);
}

export async function flushStoreNow() {
  if (savingPromise) return savingPromise;
  savingPromise = (async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = DB_PATH + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
    await fs.rename(tmp, DB_PATH);
  })();
  try {
    await savingPromise;
  } finally {
    savingPromise = null;
  }
}

export async function upsertGoogleUser({ email, name, picture }) {
  await loadStore();
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    throw new Error('Email Google tidak valid');
  }

  const envOwner = (process.env.OWNER_EMAIL || '').trim().toLowerCase();
  const existingUsers = Object.values(db.users);
  const hasAnyOwner = existingUsers.some((u) => u.role === 'owner');

  let user = db.users[normalizedEmail];
  if (!user) {
    const isOwner = (envOwner && normalizedEmail === envOwner) || !hasAnyOwner;
    user = {
      id: crypto.randomUUID(),
      email: normalizedEmail,
      name: (name || normalizedEmail.split('@')[0]).trim(),
      picture: picture || '',
      role: isOwner ? 'owner' : 'user',
      phoneVerified: false,
      verifiedPhone: '',
      verifiedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    db.users[normalizedEmail] = user;
  } else {
    if (name) user.name = name.trim();
    if (picture) user.picture = picture;
    if (envOwner && normalizedEmail === envOwner) {
      user.role = 'owner';
    }
    if (typeof user.phoneVerified !== 'boolean') {
      user.phoneVerified = false;
      user.verifiedPhone = user.verifiedPhone || '';
      user.verifiedAt = user.verifiedAt || null;
    }
    user.updatedAt = Date.now();
  }

  scheduleSave();
  return user;
}

export async function markUserPhoneVerified(email, phone) {
  await loadStore();
  const key = String(email || '').trim().toLowerCase();
  const user = db.users[key];
  if (!user) throw new Error('Akun tidak ditemukan');
  user.phoneVerified = true;
  user.verifiedPhone = phone;
  user.verifiedAt = Date.now();
  user.updatedAt = Date.now();

  // Reset status peringatan unverified agar user langsung bisa memakai jatah 10 chat
  if (phone && db.trialUsage[phone]?.warnedStage === 'unverified') {
    db.trialUsage[phone].warnedStage = '';
  }

  await flushStoreNow();
  return user;
}

export async function unverifyUserPhone(targetEmail) {
  await loadStore();
  const key = String(targetEmail || '').trim().toLowerCase();
  const user = db.users[key];
  if (!user) throw new Error('Akun tidak ditemukan');
  user.phoneVerified = false;
  user.verifiedPhone = '';
  user.verifiedAt = null;
  user.updatedAt = Date.now();
  await flushStoreNow();
  return user;
}

export function getPhoneAccountTier(phone) {
  const clean = String(phone || '').replace(/\D/g, '');
  if (!clean) return 'unverified';
  for (const user of Object.values(db.users)) {
    if (user.phoneVerified && user.verifiedPhone === clean) {
      if (isVipActive(user)) return 'vip';
      return 'verified';
    }
  }
  return 'unverified';
}

function getTodayWibKey() {
  // Tanggal harian zona waktu WIB (UTC+7): YYYY-MM-DD
  const nowWib = new Date(Date.now() + 7 * 60 * 60 * 1000);
  return nowWib.toISOString().slice(0, 10);
}

function getOrResetDailyUsage(cleanKey) {
  const today = getTodayWibKey();
  const existing = db.trialUsage[cleanKey];
  if (!existing || existing.dateKey !== today) {
    db.trialUsage[cleanKey] = {
      dateKey: today,
      count: 0,
      firstFreeUsed: false,
      warnedStage: '',
    };
    scheduleSave();
  }
  return db.trialUsage[cleanKey];
}

export async function getDailyQuotaStatus(phone) {
  await loadStore();
  const clean = String(phone || '').replace(/\D/g, '');
  const tier = getPhoneAccountTier(clean);
  if (tier === 'vip') {
    return { tier: 'vip', used: 0, limit: Infinity, exhausted: false };
  }
  const usage = getOrResetDailyUsage(clean || 'unknown');
  const limit = tier === 'verified' ? 10 : 3;
  return {
    tier,
    used: usage.count,
    limit,
    exhausted: usage.count >= limit,
    warned: usage.warnedStage === tier,
  };
}

/**
 * Cek & konsumsi kuota HARIAN (reset tiap hari WIB) KHUSUS pada bot milik Owner:
 * - VIP / Owner -> unlimited
 * - Belum verifikasi -> 3x / hari; Sudah verifikasi -> 10x / hari
 * - .menu / .help & chat pertama setelah reset harian -> tidak mengurangi kuota (selama belum limit)
 * - Jika kuota sudah habis -> kirim notifikasi persuasif 1x saja, setelah itu JANGAN MERESPON SAMA SEKALI (termasuk .menu).
 */
export async function checkAndConsumeOwnerBotQuota(phone, { isFreeCommand = false } = {}) {
  await loadStore();
  const clean = String(phone || '').replace(/\D/g, '');
  if (!clean) return { allowed: true, tier: 'vip' };

  const tier = getPhoneAccountTier(clean);
  if (tier === 'vip') {
    return { allowed: true, tier: 'vip', used: 0, limit: Infinity };
  }

  const usage = getOrResetDailyUsage(clean);
  const limit = tier === 'verified' ? 10 : 3;

  // Jika sudah pernah diperingatkan karena limit habis di tahap ini -> DIAM TOTAL (bahkan untuk .menu!)
  if (usage.count >= limit && usage.warnedStage === tier) {
    return { allowed: false, silent: true, tier, used: usage.count, limit };
  }

  // Jika kuota sudah mencapai limit dan user masih kirim command -> kirim peringatan 1x
  if (usage.count >= limit) {
    usage.warnedStage = tier;
    scheduleSave();
    return { allowed: false, silent: false, tier, used: usage.count, limit };
  }

  // .menu / .help tidak mengurangi kuota selama belum limit
  if (isFreeCommand) {
    return { allowed: true, tier, used: usage.count, limit, showCounter: false };
  }

  // Chat/command pertama setelah reset harian tidak mengurangi kuota
  if (!usage.firstFreeUsed) {
    usage.firstFreeUsed = true;
    scheduleSave();
    return { allowed: true, tier, used: usage.count, limit, firstFree: true, showCounter: true };
  }

  // Konsumsi 1 kuota harian
  usage.count += 1;
  scheduleSave();
  return { allowed: true, tier, used: usage.count, limit, showCounter: true };
}

export async function createSessionToken(email) {
  await loadStore();
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = {
    email: email.toLowerCase(),
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
  };
  // Bersihkan sesi kadaluarsa secara ringan
  const now = Date.now();
  for (const [k, v] of Object.entries(db.sessions)) {
    if (v.expiresAt < now) delete db.sessions[k];
  }
  scheduleSave();
  return token;
}

export async function getUserBySession(token) {
  await loadStore();
  if (!token) return null;
  const sess = db.sessions[token];
  if (!sess) return null;
  if (sess.expiresAt < Date.now()) {
    delete db.sessions[token];
    scheduleSave();
    return null;
  }
  return db.users[sess.email] || null;
}

export async function deleteSessionToken(token) {
  await loadStore();
  if (token && db.sessions[token]) {
    delete db.sessions[token];
    scheduleSave();
  }
}

export function isVipActive(user) {
  if (!user) return false;
  if (user.role === 'owner') return true;
  if (user.role === 'buyer') {
    if (user.vipExpiresAt == null) return true; // Lifetime
    return Date.now() < Number(user.vipExpiresAt);
  }
  return false;
}

export function isEmailVipActive(email) {
  const key = String(email || '').trim().toLowerCase();
  if (!key) return false;
  const user = db.users[key];
  if (!user) return false;
  return isVipActive(user);
}

export function isOwnerEmail(email) {
  const key = String(email || '').trim().toLowerCase();
  if (!key) return false;
  const envOwner = (process.env.OWNER_EMAIL || '').trim().toLowerCase();
  if (envOwner && key === envOwner) return true;
  const user = db.users[key];
  return user?.role === 'owner';
}

export async function listUsers() {
  await loadStore();
  return Object.values(db.users)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((u) => ({
      ...u,
      vipActive: isVipActive(u),
      vipExpired: u.role === 'buyer' && !isVipActive(u),
    }));
}

/**
 * Ubah role user. Untuk role 'buyer', dukung durationDays berupa angka hari (misal 7, 30, 90, 365)
 * atau 'lifetime' untuk akses selamanya.
 */
export async function setUserRole(targetEmail, newRole, durationDays = 'lifetime') {
  await loadStore();
  const key = String(targetEmail || '').trim().toLowerCase();
  const user = db.users[key];
  if (!user) throw new Error('Akun tidak ditemukan');
  if (!['owner', 'buyer', 'user'].includes(newRole)) {
    throw new Error('Role tidak valid (harus owner, buyer, atau user)');
  }

  user.role = newRole;
  if (newRole === 'buyer') {
    if (durationDays === 'lifetime' || durationDays === null || durationDays === '') {
      user.vipExpiresAt = null;
      user.vipPlan = 'lifetime';
    } else {
      const days = Number(durationDays);
      if (!Number.isFinite(days) || days <= 0) {
        throw new Error('Durasi VIP tidak valid.');
      }
      user.vipExpiresAt = Date.now() + days * 24 * 60 * 60 * 1000;
      user.vipPlan = `${days}d`;
    }
  } else if (newRole === 'owner') {
    user.vipExpiresAt = null;
    user.vipPlan = 'owner';
  } else {
    user.vipExpiresAt = null;
    user.vipPlan = '';
  }

  user.updatedAt = Date.now();
  await flushStoreNow();
  return {
    ...user,
    vipActive: isVipActive(user),
    vipExpired: user.role === 'buyer' && !isVipActive(user),
  };
}

export async function saveBotRecord(record) {
  await loadStore();
  db.bots[record.id] = {
    ...db.bots[record.id],
    ...record,
    updatedAt: Date.now(),
  };
  scheduleSave();
  return db.bots[record.id];
}

export async function deleteBotRecord(botId) {
  await loadStore();
  if (db.bots[botId]) {
    delete db.bots[botId];
    scheduleSave();
  }
}

export async function listBotRecords() {
  await loadStore();
  return Object.values(db.bots).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

export async function getGroupSettings(groupJid) {
  await loadStore();
  return (
    db.groupSettings[groupJid] || {
      antidelete: false,
      antiedit: false,
      antikudeta: false,
    }
  );
}

export async function updateGroupSetting(groupJid, key, value) {
  await loadStore();
  const current = await getGroupSettings(groupJid);
  db.groupSettings[groupJid] = {
    ...current,
    [key]: Boolean(value),
  };
  scheduleSave();
  return db.groupSettings[groupJid];
}
