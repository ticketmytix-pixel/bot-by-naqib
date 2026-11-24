import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import webp from 'node-webpmux';

const execFileAsync = promisify(execFile);

const MAX_ANIMATED_WEBP_BYTES = 500 * 1024; // Batas ukuran stiker animasi WhatsApp (500 KB)

async function createTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wa-sticker-'));
}

async function cleanupDir(dir) {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Abaikan error pembersihan folder sementara
  }
}

/**
 * Menambahkan EXIF metadata WhatsApp (packname, author, emojis) ke buffer WebP.
 */
export async function addStickerExif(webpBuffer, {
  packname = 'Bot by Naqib',
  author = 'Naqib',
  emojis = ['🔊'],
} = {}) {
  const img = new webp.Image();
  await img.load(webpBuffer);

  const json = {
    'sticker-pack-id': crypto.randomBytes(16).toString('hex'),
    'sticker-pack-name': packname,
    'sticker-pack-publisher': author,
    emojis,
  };

  const exifHeader = Buffer.from([
    0x49, 0x49, 0x2a, 0x00,
    0x08, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x41, 0x57,
    0x07, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x16, 0x00,
    0x00, 0x00,
  ]);
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const exif = Buffer.concat([exifHeader, jsonBuf]);
  exif.writeUIntLE(jsonBuf.length, 14, 4);

  img.exif = exif;
  return img.save(null);
}

/**
 * Konversi gambar (JPG/PNG/WebP) menjadi stiker statis WebP 512x512 dengan EXIF.
 */
export async function imageToStickerWebp(inputBuffer, {
  crop = false,
  packname,
  author,
  emojis = ['✨'],
} = {}) {
  const tmpDir = await createTempDir();
  try {
    const inPath = path.join(tmpDir, 'input');
    const outPath = path.join(tmpDir, 'output.webp');
    await fs.writeFile(inPath, inputBuffer);

    const vf = crop
      ? 'scale=512:512:force_original_aspect_ratio=increase,crop=512:512,format=rgba'
      : 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=rgba';

    await execFileAsync('ffmpeg', [
      '-y',
      '-i', inPath,
      '-vf', vf,
      '-vcodec', 'libwebp',
      '-lossless', '0',
      '-q:v', '80',
      '-preset', 'default',
      '-an',
      '-vsync', '0',
      outPath,
    ]);

    const rawWebp = await fs.readFile(outPath);
    return addStickerExif(rawWebp, { packname, author, emojis });
  } finally {
    await cleanupDir(tmpDir);
  }
}

/**
 * Konversi video/GIF menjadi stiker animasi WebP 512x512 (maks 5 detik, <= 500 KB) dengan EXIF.
 */
export async function videoToStickerWebp(inputBuffer, {
  maxSeconds = 5,
  crop = false,
  packname,
  author,
  emojis = ['🔊'],
} = {}) {
  const tmpDir = await createTempDir();
  try {
    const inPath = path.join(tmpDir, 'input.mp4');
    const outPath = path.join(tmpDir, 'output.webp');
    await fs.writeFile(inPath, inputBuffer);

    const scaleFilter = crop
      ? 'scale=512:512:force_original_aspect_ratio=increase,crop=512:512'
      : 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000';

    // Coba beberapa profil kompresi agar hasil selalu <= 500 KB
    const presets = [
      { fps: 15, quality: 50 },
      { fps: 12, quality: 35 },
      { fps: 10, quality: 25 },
      { fps: 8, quality: 18 },
    ];

    let rawWebp = null;
    for (const { fps, quality } of presets) {
      await execFileAsync('ffmpeg', [
        '-y',
        '-i', inPath,
        '-t', String(maxSeconds),
        '-vf', `fps=${fps},${scaleFilter},format=rgba`,
        '-vcodec', 'libwebp',
        '-lossless', '0',
        '-compression_level', '6',
        '-q:v', String(quality),
        '-loop', '0',
        '-preset', 'default',
        '-an',
        '-vsync', '0',
        outPath,
      ]);

      rawWebp = await fs.readFile(outPath);
      if (rawWebp.length <= MAX_ANIMATED_WEBP_BYTES) {
        break;
      }
    }

    return addStickerExif(rawWebp, { packname, author, emojis });
  } finally {
    await cleanupDir(tmpDir);
  }
}

/**
 * Mengecek apakah media (video/audio) memiliki audio stream.
 */
export async function hasAudioStream(inputBuffer) {
  const tmpDir = await createTempDir();
  try {
    const inPath = path.join(tmpDir, 'input');
    await fs.writeFile(inPath, inputBuffer);

    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a',
      '-show_entries', 'stream=codec_type',
      '-of', 'csv=p=0',
      inPath,
    ]);

    return stdout.trim().length > 0;
  } catch {
    return false;
  } finally {
    await cleanupDir(tmpDir);
  }
}

/**
 * Mengekstrak & mengonversi audio dari video/audio menjadi OGG Opus (format resmi WhatsApp).
 * Mengembalikan { buffer, seconds }.
 */
export async function extractAudioToOggOpus(inputBuffer, { maxSeconds = 5 } = {}) {
  const tmpDir = await createTempDir();
  try {
    const inPath = path.join(tmpDir, 'input');
    const outPath = path.join(tmpDir, 'audio.ogg');
    await fs.writeFile(inPath, inputBuffer);

    await execFileAsync('ffmpeg', [
      '-y',
      '-i', inPath,
      '-t', String(maxSeconds),
      '-vn',
      '-c:a', 'libopus',
      '-b:a', '64k',
      '-ar', '48000',
      '-ac', '1',
      '-application', 'audio',
      '-f', 'ogg',
      outPath,
    ]);

    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      outPath,
    ]);

    const duration = parseFloat(stdout.trim());
    const seconds = Number.isFinite(duration) ? Math.max(1, Math.round(duration)) : 1;
    const buffer = await fs.readFile(outPath);

    return { buffer, seconds };
  } finally {
    await cleanupDir(tmpDir);
  }
}
