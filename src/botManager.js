import fs from 'node:fs/promises';
import path from 'node:path';
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

patchAudioStickerProto();

const SESSION_DIR = path.resolve(process.cwd(), 'session');
const PREFIX = process.env.PREFIX || '.';
const PACK_NAME = process.env.PACK_NAME || 'Bot by Naqib';
const PACK_AUTHOR = process.env.PACK_AUTHOR || 'Naqib';

const logger = pino({ level: 'silent' });

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

function getMessageText(msg) {
  const m = unwrapMessage(msg.message);
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ''
  ).trim();
}

function getQuotedMessage(msg) {
  const m = unwrapMessage(msg.message);
  if (!m) return null;
  const ctx =
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo ||
    m.audioMessage?.contextInfo ||
    m.stickerMessage?.contextInfo;

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
 * Normalisasi nomor WA (mendukung 08xxx -> 628xxx dan menghapus simbol non-angka).
 */
export function normalizePhoneNumber(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('08')) {
    digits = '62' + digits.slice(1);
  } else if (digits.startsWith('8')) {
    digits = '62' + digits;
  }
  return digits;
}

class BotManager {
  constructor() {
    this.sock = null;
    this.status = 'idle'; // idle | connecting | pairing | connected | error
    this.pairingCode = null;
    this.connectedUser = null;
    this.lastError = null;
    this.reconnectTimer = null;
    this.isStopping = false;
    this.stats = {
      stickersSent: 0,
      audioStickersSent: 0,
    };
  }

  getStatus() {
    return {
      status: this.status,
      pairingCode: this.pairingCode,
      connectedUser: this.connectedUser,
      lastError: this.lastError,
      stats: this.stats,
      prefix: PREFIX,
    };
  }

  async hasExistingSession() {
    try {
      await fs.access(path.join(SESSION_DIR, 'creds.json'));
      return true;
    } catch {
      return false;
    }
  }

  async startIfHasSession() {
    if (await this.hasExistingSession()) {
      console.log('[BOT] Sesi ditemukan, menyambungkan otomatis...');
      await this.connectSocket();
    }
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
        // Abaikan error saat tutup socket
      }
      this.sock = null;
    }
    this.isStopping = false;
  }

  async clearSessionDir() {
    try {
      await fs.rm(SESSION_DIR, { recursive: true, force: true });
    } catch {
      // Abaikan
    }
  }

  async connectSocket({ resetSession = false } = {}) {
    await this.stopSocket();

    if (resetSession) {
      await this.clearSessionDir();
    }

    this.status = 'connecting';
    this.lastError = null;
    if (resetSession) {
      this.pairingCode = null;
      this.connectedUser = null;
    }

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
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
          name: sock.user?.name || 'WhatsApp Bot',
          phone,
        };
        console.log(`[BOT] ✅ Terhubung sebagai ${this.connectedUser.phone}`);
      } else if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;

        if (isLoggedOut) {
          console.log('[BOT] Sesi logout, membersihkan session.');
          this.status = 'idle';
          this.pairingCode = null;
          this.connectedUser = null;
          this.lastError = 'Sesi keluar dari HP. Silakan pairing ulang.';
          await this.clearSessionDir();
          return;
        }

        // Reconnect otomatis jika sudah punya sesi atau sedang proses pairing
        if (this.status === 'connected' || this.status === 'pairing' || this.status === 'connecting') {
          console.log(`[BOT] Koneksi terputus (kode: ${statusCode ?? 'unknown'}), reconnect 3 detik...`);
          this.clearReconnectTimer();
          this.reconnectTimer = setTimeout(() => {
            this.connectSocket().catch((err) => {
              this.status = 'error';
              this.lastError = err?.message || 'Gagal menyambung ulang';
            });
          }, 3000);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        await this.handleMessage(sock, msg);
      }
    });

    return sock;
  }

  /**
   * Memulai koneksi baru & meminta Pairing Code 8 digit untuk nomor yang diberikan.
   */
  async requestPairing(rawPhone) {
    const phone = normalizePhoneNumber(rawPhone);
    if (phone.length < 10 || phone.length > 15) {
      throw new Error('Nomor WhatsApp tidak valid. Contoh: 081234567890 atau 6281234567890');
    }

    const sock = await this.connectSocket({ resetSession: true });

    // Tunggu sebentar agar WebSocket Noise handshake siap sebelum requestPairingCode
    await new Promise((resolve) => setTimeout(resolve, 2500));

    if (this.sock !== sock) {
      throw new Error('Sesi pairing dibatalkan, silakan coba lagi.');
    }

    try {
      const rawCode = await sock.requestPairingCode(phone);
      const formatted = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
      this.pairingCode = formatted;
      this.status = 'pairing';
      this.lastError = null;
      console.log(`[PAIRING] Kode untuk ${phone}: ${formatted}`);
      return formatted;
    } catch (err) {
      this.status = 'error';
      this.lastError = err?.message || 'Gagal meminta kode pairing. Coba lagi sebentar.';
      throw new Error(this.lastError);
    }
  }

  async logout() {
    if (this.sock) {
      try {
        await this.sock.logout();
      } catch {
        // Abaikan jika sudah terputus
      }
    }
    await this.stopSocket();
    await this.clearSessionDir();
    this.status = 'idle';
    this.pairingCode = null;
    this.connectedUser = null;
    this.lastError = null;
  }

  async handleMessage(sock, msg) {
    if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

    const jid = msg.key.remoteJid;
    const text = getMessageText(msg);
    if (!text.startsWith(PREFIX)) return;

    const body = text.slice(PREFIX.length).trim();
    const args = body.split(/\s+/);
    const cmd = (args.shift() || '').toLowerCase();
    const flags = new Set(args.map((a) => a.toLowerCase()));

    const isMenuCmd = cmd === 'menu' || cmd === 'help';
    const isStickerCmd = ['s', 'sticker', 'stiker', 'sa', 'stickeraudio', 'stikeraudio'].includes(cmd);

    if (isMenuCmd) {
      const menuText = [
        '*🤖 Bot by Naqib*',
        '',
        '*Cara Pakai:*',
        `1. *Sticker Audio (dari Video)*`,
        `   Kirim atau reply video dengan caption:`,
        `   \`${PREFIX}s --audio\` atau \`${PREFIX}sa\``,
        `   _(Maks 5 detik, stiker animasi + suara video)_`,
        '',
        `2. *Sticker Audio (Gambar + Audio/VN)*`,
        `   Reply audio/VN lalu kirim gambar dengan caption \`${PREFIX}s --audio\``,
        `   _(Maks 10 detik, stiker statis + suara audio)_`,
        '',
        `3. *Sticker Biasa (Gambar/Video)*`,
        `   Kirim atau reply gambar/video dengan \`${PREFIX}s\``,
        '',
        `*Opsi tambahan:*`,
        `• \`--crop\` / \`-c\` : Potong 1:1 penuh`,
        '',
        '_Catatan: Suara pada Sound Sticker aktif di WhatsApp versi terbaru / Beta._',
      ].join('\n');

      await sock.sendMessage(jid, { text: menuText }, { quoted: msg });
      return;
    }

    if (!isStickerCmd) return;

    const wantAudio =
      cmd === 'sa' ||
      cmd === 'stickeraudio' ||
      cmd === 'stikeraudio' ||
      flags.has('--audio') ||
      flags.has('-a');

    const crop = flags.has('--crop') || flags.has('-c');

    const currentMsg = unwrapMessage(msg.message);
    const quoted = getQuotedMessage(msg);
    const quotedMsg = quoted?.message;

    const hasCurrentVideo = Boolean(currentMsg?.videoMessage);
    const hasCurrentImage = Boolean(currentMsg?.imageMessage);
    const hasCurrentAudio = Boolean(currentMsg?.audioMessage);

    const hasQuotedVideo = Boolean(quotedMsg?.videoMessage);
    const hasQuotedImage = Boolean(quotedMsg?.imageMessage);
    const hasQuotedSticker = Boolean(quotedMsg?.stickerMessage);
    const hasQuotedAudio = Boolean(quotedMsg?.audioMessage);

    const react = async (emoji) => {
      try {
        await sock.sendMessage(jid, { react: { text: emoji, key: msg.key } });
      } catch {
        // Abaikan
      }
    };

    try {
      if (wantAudio) {
        if (hasCurrentVideo || hasQuotedVideo) {
          const target = hasCurrentVideo ? msg : quoted;
          await react('⏳');

          const videoBuf = await downloadBuffer(target, sock);
          const audioExists = await hasAudioStream(videoBuf);

          if (!audioExists) {
            await react('❌');
            await sock.sendMessage(
              jid,
              { text: '❌ Video ini tidak memiliki track audio. Gunakan video yang ada suaranya.' },
              { quoted: msg }
            );
            return;
          }

          const [webpBuffer, audioData] = await Promise.all([
            videoToStickerWebp(videoBuf, {
              maxSeconds: 5,
              crop,
              packname: PACK_NAME,
              author: PACK_AUTHOR,
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
              packname: PACK_NAME,
              author: PACK_AUTHOR,
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
                packname: PACK_NAME,
                author: PACK_AUTHOR,
                emojis: ['🔊'],
              })
            : await imageToStickerWebp(visualBuf, {
                crop,
                packname: PACK_NAME,
                author: PACK_AUTHOR,
                emojis: ['🔊'],
              });

          const audioData = await extractAudioToOggOpus(audBuf, { maxSeconds: 10 });

          await sendAudioSticker(sock, jid, {
            webpBuffer,
            audioBuffer: audioData.buffer,
            seconds: audioData.seconds,
            isAnimated: Boolean(quotedMsg?.stickerMessage?.isAnimated),
            quoted: msg,
          });

          this.stats.audioStickersSent += 1;
          await react('✅');
          return;
        }

        await sock.sendMessage(
          jid,
          {
            text:
              `⚠️ Cara membuat *Sticker Audio*:\n` +
              `• Kirim/reply *video* dengan caption \`${PREFIX}s --audio\`\n` +
              `• Atau reply *audio/VN* lalu kirim *gambar* dengan caption \`${PREFIX}s --audio\``,
          },
          { quoted: msg }
        );
        return;
      }

      if (hasCurrentImage || hasQuotedImage) {
        const target = hasCurrentImage ? msg : quoted;
        await react('⏳');
        const imgBuf = await downloadBuffer(target, sock);
        const webpBuffer = await imageToStickerWebp(imgBuf, {
          crop,
          packname: PACK_NAME,
          author: PACK_AUTHOR,
        });
        await sock.sendMessage(jid, { sticker: webpBuffer }, { quoted: msg });
        this.stats.stickersSent += 1;
        await react('✅');
        return;
      }

      if (hasCurrentVideo || hasQuotedVideo) {
        const target = hasCurrentVideo ? msg : quoted;
        await react('⏳');
        const videoBuf = await downloadBuffer(target, sock);
        const webpBuffer = await videoToStickerWebp(videoBuf, {
          maxSeconds: 5,
          crop,
          packname: PACK_NAME,
          author: PACK_AUTHOR,
        });
        await sock.sendMessage(jid, { sticker: webpBuffer }, { quoted: msg });
        this.stats.stickersSent += 1;
        await react('✅');
        return;
      }

      await sock.sendMessage(
        jid,
        {
          text:
            `⚠️ Kirim atau reply gambar/video dengan \`${PREFIX}s\`\n` +
            `Untuk stiker bersuara, gunakan \`${PREFIX}s --audio\``,
        },
        { quoted: msg }
      );
    } catch (err) {
      console.error('[ERROR] Gagal memproses stiker:', err);
      await react('❌');
      await sock.sendMessage(
        jid,
        { text: `❌ Gagal membuat stiker: ${err.message || 'Terjadi kesalahan'}` },
        { quoted: msg }
      );
    }
  }
}

export const botManager = new BotManager();
