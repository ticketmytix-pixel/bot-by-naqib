import 'dotenv/config';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
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

// Aktifkan patch WAProto untuk Sound Sticker (StickerMessage.audioMessage field 26)
const patched = patchAudioStickerProto();
console.log(
  patched
    ? '[PROTO] Patch WAProto Sound Sticker (field 26 audioMessage) aktif.'
    : '[PROTO] Baileys sudah mendukung Sound Sticker secara native.'
);

const PREFIX = process.env.PREFIX || '.';
const PACK_NAME = process.env.PACK_NAME || 'Bot by Naqib';
const PACK_AUTHOR = process.env.PACK_AUTHOR || 'Naqib';

const logger = pino({ level: 'silent' });

/**
 * Unwrap pesan yang dibungkus ephemeralMessage / viewOnceMessage.
 */
function unwrapMessage(message) {
  if (!message) return null;
  if (message.ephemeralMessage?.message) {
    return unwrapMessage(message.ephemeralMessage.message);
  }
  if (message.viewOnceMessage?.message) {
    return unwrapMessage(message.viewOnceMessage.message);
  }
  if (message.viewOnceMessageV2?.message) {
    return unwrapMessage(message.viewOnceMessageV2.message);
  }
  if (message.documentWithCaptionMessage?.message) {
    return unwrapMessage(message.documentWithCaptionMessage.message);
  }
  return message;
}

/**
 * Ambil teks/caption dari pesan.
 */
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

/**
 * Ambil pesan yang di-reply (quoted) dalam bentuk WAMessage minimal agar bisa di-download.
 */
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

async function askPhoneNumber() {
  const envNum = (process.env.PAIRING_NUMBER || '').replace(/\D/g, '');
  if (envNum.length >= 10) {
    return envNum;
  }

  const rl = readline.createInterface({ input, output });
  try {
    console.log('\n=================================================');
    console.log('  WHATSAPP AUDIO STICKER BOT - PAIRING CODE');
    console.log('=================================================');
    console.log('Masukkan nomor WhatsApp bot dengan kode negara.');
    console.log('Contoh: 6281234567890 (tanpa + atau spasi)\n');

    while (true) {
      const answer = await rl.question('Nomor WA: ');
      const cleaned = answer.replace(/\D/g, '');
      if (cleaned.length >= 10) {
        return cleaned;
      }
      console.log('Nomor tidak valid. Contoh yang benar: 6281234567890');
    }
  } finally {
    rl.close();
  }
}

async function handleMessage(sock, msg) {
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
      `• \`--crop\` / \`-c\` : Potong 1:1 penuh (tanpa border transparan)`,
      '',
      '_Catatan: Fitur Sound Sticker hanya memutar suara di WhatsApp versi terbaru / Beta yang sudah mendukung Sound Stickers._',
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

  // Reaksi loading
  const react = async (emoji) => {
    try {
      await sock.sendMessage(jid, { react: { text: emoji, key: msg.key } });
    } catch {
      // Abaikan jika gagal react
    }
  };

  try {
    if (wantAudio) {
      // MODE 1: Video (dikirim langsung atau di-reply) -> Animated Sound Sticker (maks 5 detik)
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

        await react('✅');
        return;
      }

      // MODE 2: Gambar + Audio/VN (kirim gambar sambil reply audio/VN)
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

        await react('✅');
        return;
      }

      // MODE 3: Audio/VN + Gambar/Sticker (kirim audio sambil reply gambar/sticker)
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

    // MODE STIKER BIASA (tanpa --audio)
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

let pairingRequested = false;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./session');
  const { version } = await fetchLatestBaileysVersion();

  console.log(`[BOT] Menghubungkan ke WhatsApp Web v${version.join('.')}...`);

  const sock = makeWASocket({
    version,
    logger,
    auth: state,
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  // Pairing Code flow jika belum login
  if (!sock.authState.creds.registered && !pairingRequested) {
    pairingRequested = true;
    const phoneNumber = await askPhoneNumber();

    setTimeout(async () => {
      try {
        const rawCode = await sock.requestPairingCode(phoneNumber);
        const formatted = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;

        console.log('\n=================================================');
        console.log(`  KODE PAIRING ANDA:  ${formatted}`);
        console.log('=================================================');
        console.log('Buka WhatsApp di HP Anda:');
        console.log('1. Ketuk titik tiga (⋮) -> Perangkat Tertaut');
        console.log('2. Ketuk "Tautkan Perangkat"');
        console.log('3. Pilih "Tautkan dengan nomor telepon saja"');
        console.log(`4. Masukkan kode: ${formatted}\n`);
      } catch (err) {
        pairingRequested = false;
        console.error('[PAIRING ERROR] Gagal meminta pairing code:', err?.message || err);
      }
    }, 2500);
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      pairingRequested = false;
      console.log('\n[BOT] ✅ Berhasil terhubung ke WhatsApp!');
      console.log(`[BOT] Ketik ${PREFIX}menu atau kirim video dengan caption ${PREFIX}s --audio\n`);
    } else if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(`[BOT] Koneksi terputus (kode: ${statusCode ?? 'unknown'}).`);

      if (shouldReconnect) {
        console.log('[BOT] Mencoba menyambung ulang dalam 3 detik...');
        setTimeout(() => startBot(), 3000);
      } else {
        console.log('[BOT] Sesi keluar (Logged Out). Hapus folder "session/" lalu jalankan ulang untuk pairing baru.');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      await handleMessage(sock, msg);
    }
  });
}

startBot().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
