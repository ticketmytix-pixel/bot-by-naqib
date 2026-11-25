import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import pino from 'pino';
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  Browsers,
} from '@whiskeysockets/baileys';

import { patchAudioStickerProto } from './patchProto.js';
import {
  imageToStickerWebp,
  videoToStickerWebp,
  hasAudioStream,
  extractAudioToOggOpus,
  addStickerExif,
} from './media.js';
import { sendAudioSticker } from './audioSticker.js';
import { GroupGuard } from './features/groupGuard.js';
import { handleXoxCommand } from './features/minigame.js';
import { sendWebviewCard } from './features/webviewMessage.js';
import { allocateXoxRoom } from './features/xoxRooms.js';
import { createBratSticker, BRAT_THEMES } from './features/brat.js';
import {
  downloadSocialVideo,
  downloadSpotifyMusic,
  searchSpotifyTracks,
  extractVideoToMp3,
  removeImageBackground,
} from './features/tools.js';
import {
  saveBotRecord,
  deleteBotRecord,
  listBotRecords,
  updateGroupSetting,
  getGroupSettings,
  isEmailVipActive,
  isOwnerEmail,
  checkAndConsumeOwnerBotQuota,
} from './store.js';

patchAudioStickerProto();

const STORAGE_ROOT = path.resolve(process.cwd(), process.env.STORAGE_DIR || 'storage');
const SESSIONS_ROOT = path.join(STORAGE_ROOT, 'sessions');
const PREFIX = process.env.PREFIX || '.';
const DEFAULT_PACK_NAME = process.env.PACK_NAME || 'Bot by Naqib';
const DEFAULT_PACK_AUTHOR = process.env.PACK_AUTHOR || 'Naqib';

const logger = pino({ level: 'silent' });

export function normalizePhoneNumber(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('08')) digits = '62' + digits.slice(1);
  else if (digits.startsWith('8')) digits = '62' + digits;
  return digits;
}

function unwrapMessage(message) {
  if (!message) return null;
  if (message.ephemeralMessage?.message) return unwrapMessage(message.ephemeralMessage.message);
  if (message.viewOnceMessage?.message) return unwrapMessage(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2?.message) return unwrapMessage(message.viewOnceMessageV2.message);
  if (message.documentWithCaptionMessage?.message) {
    return unwrapMessage(message.documentWithCaptionMessage.message);
  }
  return message;
}

function getMessageText(m) {
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ''
  ).trim();
}

function getQuotedMessage(msg, unwrapped) {
  if (!unwrapped) return null;
  const ctx =
    unwrapped.extendedTextMessage?.contextInfo ||
    unwrapped.imageMessage?.contextInfo ||
    unwrapped.videoMessage?.contextInfo ||
    unwrapped.audioMessage?.contextInfo ||
    unwrapped.stickerMessage?.contextInfo;

  if (!ctx?.quotedMessage) return null;

  return {
    key: {
      remoteJid: msg.key.remoteJid,
      id: ctx.stanzaId,
      participant: ctx.participant,
      fromMe: false,
    },
    message: unwrapMessage(ctx.quotedMessage),
  };
}

async function downloadBuffer(waMsg, sock) {
  return downloadMediaMessage(
    waMsg,
    'buffer',
    {},
    {
      logger,
      reuploadRequest: sock.updateMediaMessage,
    }
  );
}

/**
 * Satu BotInstance merepresentasikan 1 nomor WhatsApp yang berjalan independen
 * dengan folder sesi terisolasi (sessions/<id>/) sehingga banyak nomor WA dapat
 * menjadi bot secara bersamaan dalam satu server.
 */
class BotInstance {
  constructor({ id, ownerEmail, phone, packName, packAuthor }) {
    this.id = id;
    this.ownerEmail = ownerEmail;
    this.phone = phone;
    this.packName = packName || DEFAULT_PACK_NAME;
    this.packAuthor = packAuthor || DEFAULT_PACK_AUTHOR;
    this.sessionDir = path.join(SESSIONS_ROOT, id);

    this.sock = null;
    this.status = 'idle'; // idle | connecting | pairing | connected | error
    this.pairingCode = null;
    this.connectedUser = null;
    this.lastError = null;
    this.reconnectTimer = null;
    this.isStopping = false;
    this.groupGuard = new GroupGuard();
    this.userCooldowns = new Map(); // senderBare -> lastCommandTimestampMs
    this.stats = {
      stickersSent: 0,
      audioStickersSent: 0,
      downloads: 0,
      commandsRun: 0,
    };
  }

  toJSON() {
    return {
      id: this.id,
      ownerEmail: this.ownerEmail,
      phone: this.connectedUser?.phone || this.phone,
      packName: this.packName,
      packAuthor: this.packAuthor,
      status: this.status,
      pairingCode: this.pairingCode,
      connectedUser: this.connectedUser,
      lastError: this.lastError,
      stats: this.stats,
    };
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  async stopSocket() {
    this.clearReconnectTimer();
    this.isStopping = true;
    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch {
        // Abaikan
      }
      this.sock = null;
    }
    this.isStopping = false;
  }

  async connect({ resetSession = false } = {}) {
    await this.stopSocket();

    if (resetSession) {
      await fs.rm(this.sessionDir, { recursive: true, force: true }).catch(() => {});
      this.pairingCode = null;
      this.connectedUser = null;
    }

    await fs.mkdir(this.sessionDir, { recursive: true });
    this.status = 'connecting';
    this.lastError = null;

    const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger,
      auth: state,
      browser: Browsers.ubuntu('Chrome'),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    this.sock = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      if (this.sock !== sock || this.isStopping) return;
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        this.status = 'connected';
        this.pairingCode = null;
        this.lastError = null;
        const jid = sock.user?.id || '';
        const phone = jid.split(':')[0].split('@')[0];
        this.connectedUser = {
          name: sock.user?.name || this.packName,
          phone,
        };
        this.phone = phone || this.phone;
        await saveBotRecord({
          id: this.id,
          ownerEmail: this.ownerEmail,
          phone: this.phone,
          packName: this.packName,
          packAuthor: this.packAuthor,
        });
        console.log(`[BOT:${this.id.slice(0, 6)}] ✅ Terhubung sebagai ${this.phone}`);
      } else if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          console.log(`[BOT:${this.id.slice(0, 6)}] Logged out, sesi dihapus.`);
          this.status = 'idle';
          this.pairingCode = null;
          this.connectedUser = null;
          this.lastError = 'Sesi keluar dari HP. Silakan pairing ulang.';
          await fs.rm(this.sessionDir, { recursive: true, force: true }).catch(() => {});
          return;
        }

        if (['connected', 'pairing', 'connecting'].includes(this.status)) {
          console.log(`[BOT:${this.id.slice(0, 6)}] Terputus (kode: ${code ?? '?'}), reconnect 3s...`);
          this.clearReconnectTimer();
          this.reconnectTimer = setTimeout(() => {
            this.connect().catch((err) => {
              this.status = 'error';
              this.lastError = err?.message || 'Gagal menyambung ulang';
            });
          }, 3000);
        }
      }
    });

    sock.ev.on('group-participants.update', async (update) => {
      await this.groupGuard.handleParticipantsUpdate(sock, update);
    });

    sock.ev.on('messages.update', async (updates) => {
      await this.groupGuard.handleMessagesUpdate(sock, updates);
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        await this.handleMessage(sock, msg);
      }
    });

    return sock;
  }

  async requestPairingCode(phone) {
    const cleanPhone = normalizePhoneNumber(phone);
    if (cleanPhone.length < 10 || cleanPhone.length > 15) {
      throw new Error('Nomor WhatsApp tidak valid. Contoh: 081234567890');
    }
    this.phone = cleanPhone;

    const sock = await this.connect({ resetSession: true });
    await new Promise((r) => setTimeout(r, 2500));

    if (this.sock !== sock) {
      throw new Error('Sesi pairing dibatalkan, coba lagi.');
    }

    const rawCode = await sock.requestPairingCode(cleanPhone);
    const formatted = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
    this.pairingCode = formatted;
    this.status = 'pairing';
    this.lastError = null;
    console.log(`[PAIRING:${this.id.slice(0, 6)}] Kode untuk ${cleanPhone}: ${formatted}`);
    return formatted;
  }

  async destroy() {
    if (this.sock) {
      try {
        await this.sock.logout();
      } catch {
        // Abaikan
      }
    }
    await this.stopSocket();
    await fs.rm(this.sessionDir, { recursive: true, force: true }).catch(() => {});
  }

  async handleMessage(sock, msg) {
    if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

    const jid = msg.key.remoteJid;
    const isGroup = jid.endsWith('@g.us');
    const unwrapped = unwrapMessage(msg.message);
    if (!unwrapped) return;

    // Cek event Anti-Delete & Anti-Edit terlebih dahulu
    const handledProto = await this.groupGuard.handleProtocolEvent(sock, msg, unwrapped);
    if (handledProto) return;

    const text = getMessageText(unwrapped);

    // Simpan ke cache grup (untuk Anti-Delete & Anti-Edit)
    if (isGroup) {
      this.groupGuard.cacheMessage(msg, text);
    }

    if (!text.startsWith(PREFIX)) return;

    // Cek apakah masa aktif VIP pemilik bot masih berlaku
    if (this.ownerEmail && !isEmailVipActive(this.ownerEmail)) {
      await sock.sendMessage(
        jid,
        {
          text:
            `⏳ *MASA AKTIF VIP BOT BERAKHIR*\n\n` +
            `Masa sewa VIP untuk bot ini sudah habis.\n` +
            `Silakan lakukan pembayaran / perpanjangan terlebih dahulu ke Owner:\n` +
            `📱 WhatsApp: *085185779714*\n\n` +
            `_Setelah diperpanjang oleh Owner, bot akan langsung aktif kembali otomatis._`,
        },
        { quoted: msg }
      );
      return;
    }

    const body = text.slice(PREFIX.length).trim();
    const parts = body.split(/\s+/);
    const cmd = (parts.shift() || '').toLowerCase();
    const restText = parts.join(' ').trim();
    const flags = new Set(parts.map((p) => p.toLowerCase()));

    // ==================== RESOLVE NOMOR PENGIRIM (MENDUKUNG @lid & PN) ====================
    const senderJid =
      msg.key.participantAlt ||
      msg.key.remoteJidAlt ||
      msg.key.participant ||
      msg.key.remoteJid ||
      '';
    const senderBare = senderJid.split(':')[0].split('@')[0];

    // ==================== ANTI-SPAM COOLDOWN (3.5 DETIK / USER) ====================
    const nowMs = Date.now();
    const lastCmdMs = this.userCooldowns.get(senderBare) || 0;
    if (!msg.key.fromMe && nowMs - lastCmdMs < 3500) {
      return; // Abaikan spam cepat agar bot tidak kena ban WhatsApp
    }
    this.userCooldowns.set(senderBare, nowMs);
    if (this.userCooldowns.size > 500) {
      this.userCooldowns.delete(this.userCooldowns.keys().next().value);
    }

    // ==================== KUOTA HARIAN KHUSUS BOT OWNER (BOT BUYER TANPA LIMIT) ====================
    const isOwnerBot = isOwnerEmail(this.ownerEmail);
    const isFreeCmd = cmd === 'menu' || cmd === 'help';
    let quotaInfo = null;

    if (isOwnerBot && !msg.key.fromMe) {
      quotaInfo = await checkAndConsumeOwnerBotQuota(senderBare, { isFreeCommand: isFreeCmd });
      if (!quotaInfo.allowed) {
        if (quotaInfo.silent) return; // Sudah diperingatkan 1x -> JANGAN MERESPON SAMA SEKALI!
        const webUrl = (process.env.PUBLIC_URL || 'https://botwanaqib-production.up.railway.app').replace(/\/$/, '');

        // Jeda 2 detik khusus bot Owner agar aman dari ban
        await new Promise((r) => setTimeout(r, 2000));

        const persuasiveMsg =
          quotaInfo.tier === 'unverified'
            ? [
                `⏳ *Batas Penggunaan Harian Anda Habis (${quotaInfo.used}/${quotaInfo.limit})*`,
                '',
                `Ingin lanjut pakai semua fitur keren *${this.packName}* (Sound Sticker, Brat, Spotify Live, AI RemoveBG, Downloader Tanpa Watermark)?`,
                '',
                `✨ *GRATIS!* Verifikasi nomor WA Anda sekarang di website untuk langsung dapat *10x kuota harian gratis* setiap hari!`,
                `💎 Atau upgrade ke *VIP* untuk akses *UNLIMITED* + bisa jadikan nomor WA Anda sendiri sebagai bot 24/7!`,
                '',
                `👉 Daftar / Verifikasi di sini:\n${webUrl}`,
                '',
                `_Kuota harian otomatis reset besok pukul 00.00 WIB._`,
              ].join('\n')
            : [
                `💎 *Batas Penggunaan Harian Anda Habis (${quotaInfo.used}/${quotaInfo.limit})*`,
                '',
                `Terima kasih sudah mencoba *${this.packName}*! Kuota uji coba harian Anda hari ini sudah habis.`,
                '',
                `🚀 Upgrade ke *VIP* sekarang untuk menikmati:`,
                `• Penggunaan *UNLIMITED* tanpa batas harian`,
                `• Pasang bot langsung di nomor WhatsApp Anda sendiri (24/7)`,
                `• Bebas custom nama bot & pack stiker sesuka hati`,
                '',
                `👉 Upgrade VIP di website:\n${webUrl}`,
                `📱 Atau langsung chat Owner: 085185779714`,
                '',
                `_Kuota harian otomatis reset besok pukul 00.00 WIB._`,
              ].join('\n');

        await sock.sendMessage(jid, { text: persuasiveMsg }, { quoted: msg });
        return;
      }
    }

    // ==================== JEDA NATURAL + TYPING (KHUSUS OWNER SLOW 2 DETIK) ====================
    try {
      await sock.sendPresenceUpdate('composing', jid);
    } catch {
      // Abaikan jika presence gagal
    }
    const naturalDelay = isOwnerBot
      ? 2000 + Math.floor(Math.random() * 500) // Khusus bot Owner: slow 2.0 - 2.5 detik anti-ban
      : 800 + Math.floor(Math.random() * 600); // Bot Buyer: 0.8 - 1.4 detik
    await new Promise((r) => setTimeout(r, naturalDelay));

    // Helper kirim info penggunaan harian (X/Y) setelah bot selesai merespon command fitur
    const sendUsageFooterIfNeeded = async () => {
      if (!isOwnerBot || !quotaInfo || !quotaInfo.showCounter || quotaInfo.tier === 'vip') return;
      const note = quotaInfo.firstFree
        ? `📊 Penggunaan harian Anda: *(${quotaInfo.used}/${quotaInfo.limit})* _(chat pertama gratis!)_`
        : `📊 Penggunaan harian Anda: *(${quotaInfo.used}/${quotaInfo.limit})*`;
      try {
        await sock.sendMessage(jid, { text: note });
      } catch {
        // Abaikan
      }
    };

    const react = async (emoji) => {
      try {
        await sock.sendMessage(jid, { react: { text: emoji, key: msg.key } });
      } catch {
        // Abaikan
      }
    };

    try {
      // ==================== MENU ====================
      if (cmd === 'menu' || cmd === 'help') {
        this.stats.commandsRun += 1;
        const gs = isGroup ? await getGroupSettings(jid) : null;
        const groupStatus = gs
          ? `\n*Status Proteksi Grup Ini:*\n• Anti-Delete: ${gs.antidelete ? '✅ ON' : '❌ OFF'}\n• Anti-Edit: ${gs.antiedit ? '✅ ON' : '❌ OFF'}\n• Anti-Kudeta: ${gs.antikudeta ? '✅ ON' : '❌ OFF'}\n`
          : '';

        const webUrl = (process.env.PUBLIC_URL || 'https://botwanaqib-production.up.railway.app').replace(/\/$/, '');
        let quotaHeader = '';
        if (isOwnerBot && !msg.key.fromMe && quotaInfo) {
          quotaHeader =
            quotaInfo.tier === 'vip'
              ? `💎 *Status Akun: VIP (Unlimited)*\n\n`
              : `📊 *Batas Penggunaan Harian Anda: (${quotaInfo.used}/${quotaInfo.limit})*\n\n`;
        }

        const menuText = [
          `${quotaHeader}*🤖 ${this.packName}*`,
          `_Multi-Bot WhatsApp All-in-One_`,
          groupStatus,
          `*🎨 Sticker, Sound Sticker & Brat*`,
          `• \`${PREFIX}s --audio\` / \`${PREFIX}sa\` — Sticker Audio (video maks 5d / gambar+VN maks 10d)`,
          `• \`${PREFIX}s\` — Sticker biasa (gambar/video, tambah \`--crop\` untuk 1:1)`,
          `• \`${PREFIX}brat <teks>\` — Sticker Brat (tema: \`--green\`, \`--dark\`, \`--pink\`, \`--blue\`, \`--red\`, \`--yellow\`, \`--purple\`)`,
          `• \`${PREFIX}bratvid <teks>\` — Sticker Brat Animasi (kata per kata)`,
          '',
          `*📥 Media & Tools*`,
          `• \`${PREFIX}dl <link>\` / \`${PREFIX}tiktok <link>\` — Download video sosmed tanpa watermark`,
          `• \`${PREFIX}spotify <judul>\` — Pemutar Spotify Live | \`${PREFIX}play <judul>\` — MP3 langsung`,
          `• \`${PREFIX}toaudio\` / \`${PREFIX}tomp3\` — Ekstrak audio MP3 dari video`,
          `• \`${PREFIX}removebg\` / \`${PREFIX}nobg\` — Hapus background foto (AI presisi)`,
          '',
          `*🛡️ Proteksi Grup (Khusus Grup)*`,
          `• \`${PREFIX}antidelete on/off\` — Deteksi pesan yang dihapus`,
          `• \`${PREFIX}antiedit on/off\` — Deteksi pesan yang diedit`,
          `• \`${PREFIX}antikudeta on/off\` — Cegah kudeta & pulihkan admin/anggota`,
          '',
          `*🎮 Minigame*`,
          `• \`${PREFIX}xox\` — XOX Live (DM vs Bot AI / Grup Token 6 Angka Real-Time)`,
          '',
          `🌐 Daftar / Verifikasi Akun: ${webUrl}`,
        ].join('\n');

        await sock.sendMessage(jid, { text: menuText }, { quoted: msg });
        return;
      }

      // ==================== STICKER BRAT (SEMUA VARIAN) ====================
      const bratCmdMap = {
        brat: { theme: 'white', animated: false },
        bratwhite: { theme: 'white', animated: false },
        bratgreen: { theme: 'green', animated: false },
        bratdark: { theme: 'dark', animated: false },
        bratblack: { theme: 'black', animated: false },
        bratpink: { theme: 'pink', animated: false },
        bratblue: { theme: 'blue', animated: false },
        bratred: { theme: 'red', animated: false },
        bratyellow: { theme: 'yellow', animated: false },
        bratpurple: { theme: 'purple', animated: false },
        bratvid: { theme: 'white', animated: true },
        bratanim: { theme: 'white', animated: true },
        bratvideo: { theme: 'white', animated: true },
      };

      if (bratCmdMap[cmd]) {
        this.stats.commandsRun += 1;
        let { theme, animated } = bratCmdMap[cmd];
        const textTokens = [];
        for (const token of parts) {
          const low = token.toLowerCase();
          if (low === '--vid' || low === '--anim' || low === '-v') {
            animated = true;
          } else if (low.startsWith('--') && BRAT_THEMES[low.slice(2)]) {
            theme = low.slice(2);
          } else {
            textTokens.push(token);
          }
        }
        const bratText = textTokens.join(' ').trim();
        if (!bratText) {
          await sock.sendMessage(
            jid,
            {
              text:
                `💚 *Cara pakai Sticker Brat:*\n` +
                `• \`${PREFIX}brat teks kamu\` (putih klasik)\n` +
                `• \`${PREFIX}bratgreen teks kamu\` / \`${PREFIX}brat --dark teks\`\n` +
                `• \`${PREFIX}bratvid teks kamu\` (animasi kata-per-kata)\n` +
                `Tema warna: \`--white\`, \`--green\`, \`--dark\`, \`--pink\`, \`--blue\`, \`--red\`, \`--yellow\`, \`--purple\``,
            },
            { quoted: msg }
          );
          return;
        }
        await react('⏳');
        const webpBuffer = await createBratSticker({
          text: bratText,
          theme,
          animated,
          packname: this.packName,
          author: this.packAuthor,
        });
        await sock.sendMessage(jid, { sticker: webpBuffer }, { quoted: msg });
        this.stats.stickersSent += 1;
        await react('✅');
        await sendUsageFooterIfNeeded();
        return;
      }

      // ==================== PROTEKSI GRUP ====================
      if (['antidelete', 'antiedit', 'antikudeta'].includes(cmd)) {
        this.stats.commandsRun += 1;
        if (!isGroup) {
          await sock.sendMessage(jid, { text: '⚠️ Perintah ini hanya bisa digunakan di dalam grup.' }, { quoted: msg });
          return;
        }
        const mode = (parts[0] || '').toLowerCase();
        if (!['on', 'off'].includes(mode)) {
          await sock.sendMessage(
            jid,
            { text: `Gunakan: \`${PREFIX}${cmd} on\` atau \`${PREFIX}${cmd} off\`` },
            { quoted: msg }
          );
          return;
        }
        const enable = mode === 'on';
        await updateGroupSetting(jid, cmd, enable);
        await sock.sendMessage(
          jid,
          { text: `🛡️ Fitur *${cmd.toUpperCase()}* di grup ini sekarang: *${enable ? 'AKTIF ✅' : 'NONAKTIF ❌'}*` },
          { quoted: msg }
        );
        return;
      }

      // ==================== MINIGAME XOX & XOX LIVE ====================
      if (cmd === 'xox' || cmd === 'ttt' || cmd === 'xoxlive') {
        this.stats.commandsRun += 1;
        const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
        const subArg = (parts[0] || '').toLowerCase();

        if (publicUrl && (cmd === 'xoxlive' || (!subArg && !flags.has('--text')))) {
          if (!isGroup) {
            // Chat Pribadi (DM) -> Link biasa langsung main 1v1 lawan Bot AI
            const botUrl = `${publicUrl}/app/xox?mode=bot&bot=${encodeURIComponent(this.packName)}`;
            await sendWebviewCard(sock, jid, {
              title: `🎮 XOX vs Bot — ${this.packName}`,
              subtitle: 'Mode Chat Pribadi • 1v1 Lawan Bot AI',
              body: `Ketuk link di bawah untuk langsung main *XOX vs Bot AI*!\n_(Atau ketik \`${PREFIX}xox --text\` untuk mode teks)_`,
              url: botUrl,
              quoted: msg,
            });
            return;
          }

          // Di Grup -> Buat Token 6 Angka Acak Unik (tidak bentrok dengan grup/bot lain!)
          const token = allocateXoxRoom({ botId: this.id, groupJid: jid });
          const pvpUrl = `${publicUrl}/app/xox?token=${token}&mode=pvp&bot=${encodeURIComponent(this.packName)}`;

          await sendWebviewCard(sock, jid, {
            title: `⚔️ XOX By-One — Token #${token}`,
            subtitle: `${this.packName} • Real-Time Grup By-One`,
            body:
              `🔑 *Token Room:* \`${token}\`\n` +
              `Siapa saja di grup ini yang mengetuk link ini akan langsung bertemu *By-One Real-Time*!\n` +
              `_(Token otomatis dilepas & bisa dipakai ulang setelah game selesai. Mode teks: \`${PREFIX}xox --text\`)_`,
            url: pvpUrl,
            quoted: msg,
          });
          return;
        }

        const cleanParts = parts.filter((p) => p.toLowerCase() !== '--text');
        await handleXoxCommand(sock, msg, cleanParts, PREFIX);
        return;
      }

      // ==================== SPOTIFY LIVE & MP3 PLAY ====================
      if (cmd === 'spotify' || cmd === 'spotifylive' || cmd === 'play' || cmd === 'music') {
        this.stats.commandsRun += 1;
        const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
        const wantMp3Only = cmd === 'play' || flags.has('--mp3');
        const cleanQuery = parts.filter((p) => p.toLowerCase() !== '--mp3').join(' ').trim();

        // Mode Spotify Live (Kartu Pemutar Spotify Live dengan cover album asli!)
        if (!wantMp3Only && publicUrl) {
          const q = cleanQuery || 'Tulus Teh Hijau';
          const spotifyUrl = `${publicUrl}/app/spotify?q=${encodeURIComponent(q)}&bot=${encodeURIComponent(this.packName)}`;

          await react('⏳');
          let firstTrack = null;
          try {
            const list = await searchSpotifyTracks(q);
            firstTrack = list[0] || null;
          } catch {
            // Tetap kirim kartu Spotify Live meski prefetch cover gagal
          }

          const displayTitle = firstTrack?.title || q;
          const displayArtist = firstTrack?.uploader ? ` • ${firstTrack.uploader}` : '';

          await sendWebviewCard(sock, jid, {
            title: `🎧 ${displayTitle}`,
            subtitle: `Spotify Live — ${this.packName}${displayArtist}`,
            body:
              `Pemutar *Spotify Live* siap dibuka!\n` +
              `Ketuk kartu/link di bawah untuk memutar lagu & memilih rekomendasi.\n` +
              `_(Ingin file MP3 langsung di chat? Ketik \`${PREFIX}play ${q}\`)_`,
            url: spotifyUrl,
            thumbnailUrl: firstTrack?.thumbnail || undefined,
            quoted: msg,
          });
          this.stats.downloads += 1;
          await react('✅');
          await sendUsageFooterIfNeeded();
          return;
        }

        if (!cleanQuery) {
          await sock.sendMessage(
            jid,
            { text: `🎵 Contoh: \`${PREFIX}spotify Teh Hijau\` atau \`${PREFIX}play Bento\`` },
            { quoted: msg }
          );
          return;
        }

        await react('⏳');
        const track = await downloadSpotifyMusic(cleanQuery);
        await sock.sendMessage(
          jid,
          {
            audio: track.buffer,
            mimetype: 'audio/mpeg',
            fileName: `${track.title}.mp3`,
          },
          { quoted: msg }
        );
        this.stats.downloads += 1;
        await react('✅');
        await sendUsageFooterIfNeeded();
        return;
      }

      // ==================== DOWNLOADER SOSMED NO WATERMARK ====================
      if (['dl', 'download', 'tiktok', 'tt', 'ig', 'reels', 'fb'].includes(cmd)) {
        this.stats.commandsRun += 1;
        const url = parts[0];
        if (!url) {
          await sock.sendMessage(
            jid,
            { text: `📥 Contoh: \`${PREFIX}dl https://vt.tiktok.com/...\`` },
            { quoted: msg }
          );
          return;
        }
        await react('⏳');
        const video = await downloadSocialVideo(url);
        await sock.sendMessage(
          jid,
          {
            video: video.buffer,
            caption: `✅ *${video.platform} No Watermark*\n${video.title}`,
          },
          { quoted: msg }
        );
        this.stats.downloads += 1;
        await react('✅');
        await sendUsageFooterIfNeeded();
        return;
      }

      // ==================== EKSTRAK AUDIO DARI VIDEO ====================
      if (cmd === 'toaudio' || cmd === 'tomp3' || cmd === 'extractaudio') {
        this.stats.commandsRun += 1;
        const quoted = getQuotedMessage(msg, unwrapped);
        const target = unwrapped.videoMessage ? msg : quoted?.message?.videoMessage ? quoted : null;
        if (!target) {
          await sock.sendMessage(
            jid,
            { text: `🎧 Kirim atau reply video dengan \`${PREFIX}toaudio\`` },
            { quoted: msg }
          );
          return;
        }
        await react('⏳');
        const videoBuf = await downloadBuffer(target, sock);
        const mp3Buf = await extractVideoToMp3(videoBuf);
        await sock.sendMessage(
          jid,
          { audio: mp3Buf, mimetype: 'audio/mpeg', fileName: 'extracted-audio.mp3' },
          { quoted: msg }
        );
        this.stats.downloads += 1;
        await react('✅');
        await sendUsageFooterIfNeeded();
        return;
      }

      // ==================== HAPUS BACKGROUND FOTO ====================
      if (cmd === 'removebg' || cmd === 'nobg' || cmd === 'hapusbg') {
        this.stats.commandsRun += 1;
        const quoted = getQuotedMessage(msg, unwrapped);
        const target = unwrapped.imageMessage ? msg : quoted?.message?.imageMessage ? quoted : null;
        if (!target) {
          await sock.sendMessage(
            jid,
            { text: `✂️ Kirim atau reply foto dengan \`${PREFIX}removebg\`` },
            { quoted: msg }
          );
          return;
        }
        await react('⏳');
        const imgBuf = await downloadBuffer(target, sock);
        const pngBuf = await removeImageBackground(imgBuf);
        await sock.sendMessage(
          jid,
          {
            document: pngBuf,
            mimetype: 'image/png',
            fileName: 'no-background.png',
            caption: '✅ Background berhasil dihapus (format PNG transparan).',
          },
          { quoted: msg }
        );
        this.stats.downloads += 1;
        await react('✅');
        await sendUsageFooterIfNeeded();
        return;
      }

      // ==================== STICKER & SOUND STICKER ====================
      const isStickerCmd = ['s', 'sticker', 'stiker', 'sa', 'stickeraudio', 'stikeraudio'].includes(cmd);
      if (!isStickerCmd) return;

      this.stats.commandsRun += 1;
      const wantAudio =
        cmd === 'sa' ||
        cmd === 'stickeraudio' ||
        cmd === 'stikeraudio' ||
        flags.has('--audio') ||
        flags.has('-a');
      const crop = flags.has('--crop') || flags.has('-c');

      const quoted = getQuotedMessage(msg, unwrapped);
      const qMsg = quoted?.message;

      const hasCurrentVideo = Boolean(unwrapped.videoMessage);
      const hasCurrentImage = Boolean(unwrapped.imageMessage);
      const hasCurrentAudio = Boolean(unwrapped.audioMessage);
      const hasQuotedVideo = Boolean(qMsg?.videoMessage);
      const hasQuotedImage = Boolean(qMsg?.imageMessage);
      const hasQuotedSticker = Boolean(qMsg?.stickerMessage);
      const hasQuotedAudio = Boolean(qMsg?.audioMessage);

      if (wantAudio) {
        if (hasCurrentVideo || hasQuotedVideo) {
          const target = hasCurrentVideo ? msg : quoted;
          await react('⏳');
          const videoBuf = await downloadBuffer(target, sock);
          if (!(await hasAudioStream(videoBuf))) {
            await react('❌');
            await sock.sendMessage(
              jid,
              { text: '❌ Video ini tidak memiliki track audio.' },
              { quoted: msg }
            );
            return;
          }
          const [webpBuffer, audioData] = await Promise.all([
            videoToStickerWebp(videoBuf, {
              maxSeconds: 5,
              crop,
              packname: this.packName,
              author: this.packAuthor,
              emojis: ['🔊'],
            }),
            extractAudioToOggOpus(videoBuf, { maxSeconds: 5 }),
          ]);
          await sendAudioSticker(sock, jid, {
            webpBuffer,
            audioBuffer: audioData.buffer,
            seconds: audioData.seconds,
            isAnimated: true,
            quoted: msg,
          });
          this.stats.audioStickersSent += 1;
          await react('✅');
          await sendUsageFooterIfNeeded();
          return;
        }

        if (hasCurrentImage && hasQuotedAudio) {
          await react('⏳');
          const [imgBuf, audBuf] = await Promise.all([
            downloadBuffer(msg, sock),
            downloadBuffer(quoted, sock),
          ]);
          const [webpBuffer, audioData] = await Promise.all([
            imageToStickerWebp(imgBuf, {
              crop,
              packname: this.packName,
              author: this.packAuthor,
              emojis: ['🔊'],
            }),
            extractAudioToOggOpus(audBuf, { maxSeconds: 10 }),
          ]);
          await sendAudioSticker(sock, jid, {
            webpBuffer,
            audioBuffer: audioData.buffer,
            seconds: audioData.seconds,
            isAnimated: false,
            quoted: msg,
          });
          this.stats.audioStickersSent += 1;
          await react('✅');
          await sendUsageFooterIfNeeded();
          return;
        }

        if (hasCurrentAudio && (hasQuotedImage || hasQuotedSticker)) {
          await react('⏳');
          const [visualBuf, audBuf] = await Promise.all([
            downloadBuffer(quoted, sock),
            downloadBuffer(msg, sock),
          ]);
          const webpBuffer = hasQuotedSticker
            ? await addStickerExif(visualBuf, {
                packname: this.packName,
                author: this.packAuthor,
                emojis: ['🔊'],
              })
            : await imageToStickerWebp(visualBuf, {
                crop,
                packname: this.packName,
                author: this.packAuthor,
                emojis: ['🔊'],
              });
          const audioData = await extractAudioToOggOpus(audBuf, { maxSeconds: 10 });
          await sendAudioSticker(sock, jid, {
            webpBuffer,
            audioBuffer: audioData.buffer,
            seconds: audioData.seconds,
            isAnimated: Boolean(qMsg?.stickerMessage?.isAnimated),
            quoted: msg,
          });
          this.stats.audioStickersSent += 1;
          await react('✅');
          await sendUsageFooterIfNeeded();
          return;
        }

        await sock.sendMessage(
          jid,
          { text: `⚠️ Kirim/reply video dengan \`${PREFIX}s --audio\` atau reply VN lalu kirim gambar dengan \`${PREFIX}s --audio\`.` },
          { quoted: msg }
        );
        return;
      }

      // Sticker biasa
      if (hasCurrentImage || hasQuotedImage) {
        const target = hasCurrentImage ? msg : quoted;
        await react('⏳');
        const imgBuf = await downloadBuffer(target, sock);
        const webpBuffer = await imageToStickerWebp(imgBuf, {
          crop,
          packname: this.packName,
          author: this.packAuthor,
        });
        await sock.sendMessage(jid, { sticker: webpBuffer }, { quoted: msg });
        this.stats.stickersSent += 1;
        await react('✅');
        await sendUsageFooterIfNeeded();
        return;
      }

      if (hasCurrentVideo || hasQuotedVideo) {
        const target = hasCurrentVideo ? msg : quoted;
        await react('⏳');
        const videoBuf = await downloadBuffer(target, sock);
        const webpBuffer = await videoToStickerWebp(videoBuf, {
          maxSeconds: 5,
          crop,
          packname: this.packName,
          author: this.packAuthor,
        });
        await sock.sendMessage(jid, { sticker: webpBuffer }, { quoted: msg });
        this.stats.stickersSent += 1;
        await react('✅');
        await sendUsageFooterIfNeeded();
        return;
      }

      await sock.sendMessage(
        jid,
        { text: `⚠️ Kirim/reply gambar atau video dengan \`${PREFIX}s\` atau \`${PREFIX}s --audio\`.` },
        { quoted: msg }
      );
    } catch (err) {
      console.error(`[BOT:${this.id.slice(0, 6)} ERROR]`, err?.message || err);
      await react('❌');
      await sock.sendMessage(
        jid,
        { text: `❌ Gagal memproses perintah: ${err?.message || 'Terjadi kesalahan'}` },
        { quoted: msg }
      );
    }
  }
}

class MultiBotManager {
  constructor() {
    this.instances = new Map(); // botId -> BotInstance
  }

  async bootSavedBots() {
    await fs.mkdir(SESSIONS_ROOT, { recursive: true });
    const records = await listBotRecords();

    // Migrasi otomatis sesi lama dari folder ./session jika belum ada bot terdaftar
    if (records.length === 0) {
      const legacyDir = path.resolve(process.cwd(), 'session');
      try {
        await fs.access(path.join(legacyDir, 'creds.json'));
        const migratedId = 'primary';
        const targetDir = path.join(SESSIONS_ROOT, migratedId);
        await fs.cp(legacyDir, targetDir, { recursive: true });
        await saveBotRecord({
          id: migratedId,
          ownerEmail: (process.env.OWNER_EMAIL || 'owner@naqib.bot').toLowerCase(),
          phone: '',
          packName: DEFAULT_PACK_NAME,
          packAuthor: DEFAULT_PACK_AUTHOR,
          createdAt: Date.now(),
        });
        console.log('[MULTI-BOT] Sesi lama dimigrasi ke sessions/primary');
      } catch {
        // Tidak ada sesi lama
      }
    }

    const allRecords = await listBotRecords();
    for (const rec of allRecords) {
      const instance = new BotInstance(rec);
      this.instances.set(rec.id, instance);
      try {
        await fs.access(path.join(instance.sessionDir, 'creds.json'));
        console.log(`[MULTI-BOT] Menyambungkan bot ${rec.id} (${rec.phone || 'saved'})...`);
        instance.connect().catch((err) => {
          instance.status = 'error';
          instance.lastError = err?.message || 'Gagal connect';
        });
      } catch {
        // Belum punya creds, tunggu pairing
      }
    }
  }

  async createAndPairBot({ ownerEmail, phone, packName, packAuthor }) {
    const cleanPhone = normalizePhoneNumber(phone);
    if (cleanPhone.length < 10 || cleanPhone.length > 15) {
      throw new Error('Nomor WhatsApp tidak valid. Contoh: 081234567890');
    }

    const cleanPackName = (packName || DEFAULT_PACK_NAME).trim() || DEFAULT_PACK_NAME;
    const cleanPackAuthor = (packAuthor || cleanPackName).trim() || DEFAULT_PACK_AUTHOR;

    // Cek apakah nomor ini sudah ada instance-nya untuk owner yang sama
    let existing = [...this.instances.values()].find(
      (b) => b.phone === cleanPhone && b.ownerEmail === ownerEmail
    );

    if (!existing) {
      const id = crypto.randomBytes(6).toString('hex');
      existing = new BotInstance({
        id,
        ownerEmail,
        phone: cleanPhone,
        packName: cleanPackName,
        packAuthor: cleanPackAuthor,
      });
      this.instances.set(id, existing);
      await saveBotRecord({
        id,
        ownerEmail,
        phone: cleanPhone,
        packName: existing.packName,
        packAuthor: existing.packAuthor,
        createdAt: Date.now(),
      });
    } else {
      // Selalu perbarui nama bot & pack stiker jika diubah saat pairing ulang
      existing.packName = cleanPackName;
      existing.packAuthor = cleanPackAuthor;
      await saveBotRecord({
        id: existing.id,
        ownerEmail: existing.ownerEmail,
        phone: cleanPhone,
        packName: existing.packName,
        packAuthor: existing.packAuthor,
      });
    }

    const code = await existing.requestPairingCode(cleanPhone);
    return { bot: existing.toJSON(), code };
  }

  /**
   * Ubah nama bot & nama pack stiker secara live tanpa perlu pairing ulang.
   */
  async updateBotProfile(botId, requester, { packName, packAuthor }) {
    const instance = this.instances.get(botId);
    if (!instance) {
      throw new Error('Bot tidak ditemukan.');
    }
    if (requester.role !== 'owner' && instance.ownerEmail !== requester.email) {
      throw new Error('Anda tidak punya izin mengubah bot ini.');
    }
    const cleanName = String(packName || '').trim();
    if (!cleanName || cleanName.length > 50) {
      throw new Error('Nama bot / pack stiker harus 1–50 karakter.');
    }
    const cleanAuthor = String(packAuthor || cleanName).trim().slice(0, 50);

    instance.packName = cleanName;
    instance.packAuthor = cleanAuthor;

    await saveBotRecord({
      id: instance.id,
      ownerEmail: instance.ownerEmail,
      phone: instance.phone,
      packName: instance.packName,
      packAuthor: instance.packAuthor,
    });

    return instance.toJSON();
  }

  async removeBot(botId, requester) {
    const instance = this.instances.get(botId);
    if (!instance) {
      await deleteBotRecord(botId);
      return;
    }
    if (requester.role !== 'owner' && instance.ownerEmail !== requester.email) {
      throw new Error('Anda tidak punya izin menghapus bot ini.');
    }
    await instance.destroy();
    this.instances.delete(botId);
    await deleteBotRecord(botId);
  }

  listBotsForUser(user) {
    const all = [...this.instances.values()].map((b) => b.toJSON());
    if (user.role === 'owner') return all;
    return all.filter((b) => b.ownerEmail === user.email);
  }

  /**
   * Kirim kode OTP 6 digit ke nomor WhatsApp user KHUSUS menggunakan bot milik OWNER
   * (tidak pernah memakai nomor WhatsApp milik Buyer/pelanggan lain).
   */
  async sendOtpToPhone(rawPhone, code) {
    const cleanPhone = normalizePhoneNumber(rawPhone);
    if (cleanPhone.length < 10 || cleanPhone.length > 15) {
      throw new Error('Nomor WhatsApp tidak valid. Contoh: 081234567890');
    }

    const connectedOwnerBots = [...this.instances.values()].filter(
      (b) => b.status === 'connected' && b.sock && isOwnerEmail(b.ownerEmail)
    );

    // Opsional: jika OTP_BOT_PHONE diset di .env, prioritaskan nomor bot Owner tersebut
    const preferredPhone = normalizePhoneNumber(process.env.OTP_BOT_PHONE || '');
    const activeBot =
      (preferredPhone && connectedOwnerBots.find((b) => b.phone === preferredPhone)) ||
      connectedOwnerBots[0];

    if (!activeBot) {
      throw new Error(
        'Bot WhatsApp resmi milik Owner untuk mengirim OTP sedang offline. Hubungi Owner agar menautkan/menyalakan bot Owner terlebih dahulu.'
      );
    }

    const jid = `${cleanPhone}@s.whatsapp.net`;
    const [exists] = await activeBot.sock.onWhatsApp(jid);
    if (!exists?.exists) {
      throw new Error(`Nomor +${cleanPhone} tidak terdaftar di WhatsApp.`);
    }

    await activeBot.sock.sendMessage(exists.jid || jid, {
      text:
        `🔐 *KODE VERIFIKASI BOT BY NAQIB*\n\n` +
        `Kode OTP Anda: *${code}*\n` +
        `Berlaku selama *5 menit*.\n\n` +
        `_Jangan bagikan kode ini kepada siapa pun._`,
    });

    return cleanPhone;
  }

  getGlobalStats() {
    let activeBots = 0;
    let totalStickers = 0;
    let totalDownloads = 0;
    for (const b of this.instances.values()) {
      if (b.status === 'connected') activeBots += 1;
      totalStickers += b.stats.stickersSent + b.stats.audioStickersSent;
      totalDownloads += b.stats.downloads;
    }
    return {
      totalBots: this.instances.size,
      activeBots,
      totalStickers,
      totalDownloads,
    };
  }
}

export const multiBotManager = new MultiBotManager();
