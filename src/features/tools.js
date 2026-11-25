import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const execFileAsync = promisify(execFile);

const MAX_MEDIA_BYTES = 28 * 1024 * 1024; // 28 MB agar aman dikirim di WhatsApp

async function createTmpDir(prefix = 'wa-tools-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function rmDir(dir) {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Abaikan
  }
}

/**
 * Download video media sosial tanpa watermark (TikTok, Instagram, YouTube Shorts, FB, X).
 */
export async function downloadSocialVideo(url) {
  const cleanUrl = String(url || '').trim();
  if (!/^https?:\/\//i.test(cleanUrl)) {
    throw new Error('Link tidak valid. Pastikan diawali http:// atau https://');
  }

  // 1. Khusus TikTok: gunakan TikWM API agar 100% tanpa watermark
  if (/tiktok\.com|vt\.tiktok\.com|vm\.tiktok\.com/i.test(cleanUrl)) {
    try {
      const apiRes = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(cleanUrl)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      const json = await apiRes.json();
      const videoUrl = json?.data?.play;
      if (videoUrl) {
        const mediaRes = await fetch(videoUrl);
        if (mediaRes.ok) {
          const buf = Buffer.from(await mediaRes.arrayBuffer());
          if (buf.length > 0 && buf.length <= MAX_MEDIA_BYTES) {
            return {
              buffer: buf,
              title: json.data.title || 'TikTok Video (No Watermark)',
              platform: 'TikTok',
            };
          }
        }
      }
    } catch {
      // Fallback ke yt-dlp
    }
  }

  // 2. General downloader via yt-dlp (IG, FB, YT, X, TikTok fallback)
  const tmpDir = await createTmpDir('wa-dl-');
  try {
    const outTemplate = path.join(tmpDir, 'video.%(ext)s');
    const { stdout } = await execFileAsync(
      'yt-dlp',
      [
        '--no-simulate',
        '--js-runtimes', 'node',
        '--remote-components', 'ejs:github',
        '--no-playlist',
        '--max-filesize', '28M',
        '-f', 'best[ext=mp4][filesize<28M]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
        '--print', 'title',
        '-o', outTemplate,
        cleanUrl,
      ],
      { timeout: 60000 }
    );

    const lines = stdout.trim().split('\n').filter(Boolean);
    const title = lines[0] || 'Video Sosmed';
    const files = await fs.readdir(tmpDir);
    const mediaFile = files.find((f) => /\.(mp4|mkv|webm|mov)$/i.test(f));

    if (!mediaFile) {
      throw new Error('Video tidak ditemukan atau ukurannya melebihi batas 28 MB.');
    }

    const buffer = await fs.readFile(path.join(tmpDir, mediaFile));
    if (buffer.length > MAX_MEDIA_BYTES) {
      throw new Error('Ukuran video terlalu besar (> 28 MB) untuk dikirim lewat WhatsApp.');
    }

    return { buffer, title, platform: 'Sosmed' };
  } finally {
    await rmDir(tmpDir);
  }
}

/**
 * Cari & unduh musik dari Spotify (link track Spotify atau judul lagu).
 * Menggunakan SoundCloud (scsearch1) sebagai sumber utama agar stabil di IP server/cloud,
 * dengan fallback otomatis ke YouTube (ytsearch1).
 */
export async function downloadSpotifyMusic(queryOrUrl) {
  let searchQuery = String(queryOrUrl || '').trim();
  if (!searchQuery) {
    throw new Error('Masukkan judul lagu atau link Spotify.');
  }

  let spotifyTitle = '';

  // Jika link Spotify, ambil judul & artis via official Spotify oEmbed (tanpa API key)
  if (/open\.spotify\.com\/track\//i.test(searchQuery)) {
    try {
      const oembedRes = await fetch(
        `https://open.spotify.com/oembed?url=${encodeURIComponent(searchQuery)}`
      );
      if (oembedRes.ok) {
        const data = await oembedRes.json();
        if (data?.title) {
          spotifyTitle = data.title;
          searchQuery = data.title;
        }
      }
    } catch {
      // Lanjut pakai query asli
    }
  }

  const tmpDir = await createTmpDir('wa-music-');
  try {
    const outTemplate = path.join(tmpDir, 'track.%(ext)s');
    const attempts = [
      {
        target: `scsearch1:${searchQuery}`,
        extraArgs: [],
      },
      {
        target: `ytsearch1:${searchQuery} official audio`,
        extraArgs: ['--js-runtimes', 'node', '--remote-components', 'ejs:github'],
      },
    ];

    let resolvedTitle = spotifyTitle || queryOrUrl;

    for (const attempt of attempts) {
      try {
        const { stdout } = await execFileAsync(
          'yt-dlp',
          [
            '--no-simulate',
            '--no-playlist',
            ...attempt.extraArgs,
            '-x',
            '--audio-format', 'mp3',
            '--audio-quality', '128K',
            '--max-filesize', '18M',
            '--print', 'title',
            '-o', outTemplate,
            attempt.target,
          ],
          { timeout: 60000 }
        );

        const files = await fs.readdir(tmpDir);
        const mp3File = files.find((f) => f.endsWith('.mp3'));
        if (mp3File) {
          const parsedTitle = stdout.trim().split('\n').filter(Boolean)[0];
          resolvedTitle = spotifyTitle || parsedTitle || resolvedTitle;
          const buffer = await fs.readFile(path.join(tmpDir, mp3File));
          return { buffer, title: resolvedTitle };
        }
      } catch {
        // Coba sumber berikutnya
      }
    }

    throw new Error('Lagu tidak ditemukan atau gagal dikonversi.');
  } finally {
    await rmDir(tmpDir);
  }
}

const spotifySearchCache = new Map(); // query -> { tracks, expiresAt }
const spotifyFileCache = new Map(); // url -> { filePath, expiresAt }

/**
 * Mencari daftar lagu (maks 8 hasil) lengkap dengan judul, artis, durasi, dan cover art
 * untuk tampilan Spotify Live WebView.
 */
export async function searchSpotifyTracks(query) {
  const cleanQ = String(query || '').trim() || 'Tulus Teh Hijau';
  const cacheKey = cleanQ.toLowerCase();
  const cached = spotifySearchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.tracks;
  }

  const { stdout } = await execFileAsync(
    'yt-dlp',
    [
      '--flat-playlist',
      '--dump-json',
      '--no-warnings',
      `scsearch8:${cleanQ}`,
    ],
    { timeout: 30000 }
  );

  const tracks = stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        const j = JSON.parse(line);
        const url = j.webpage_url || j.url;
        if (!url) return null;
        return {
          id: j.id || url,
          title: j.title || 'Unknown Track',
          uploader: j.uploader || j.channel || 'Spotify Live',
          duration: Math.round(Number(j.duration) || 0),
          thumbnail: j.thumbnail || (Array.isArray(j.thumbnails) && j.thumbnails.at(-1)?.url) || '',
          url,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  if (spotifySearchCache.size > 100) {
    spotifySearchCache.delete(spotifySearchCache.keys().next().value);
  }
  spotifySearchCache.set(cacheKey, {
    tracks,
    expiresAt: Date.now() + 15 * 60 * 1000,
  });

  return tracks;
}

/**
 * Mengunduh/cache file MP3 sementara di /tmp untuk streaming HTML5 audio di Spotify Live WebView.
 */
export async function getSpotifyStreamFile(trackUrl) {
  const cleanUrl = String(trackUrl || '').trim();
  if (!/^https?:\/\//i.test(cleanUrl)) {
    throw new Error('URL lagu tidak valid');
  }

  const cached = spotifyFileCache.get(cleanUrl);
  if (cached && cached.expiresAt > Date.now()) {
    try {
      await fs.access(cached.filePath);
      return cached.filePath;
    } catch {
      spotifyFileCache.delete(cleanUrl);
    }
  }

  const hash = crypto.createHash('sha256').update(cleanUrl).digest('hex').slice(0, 20);
  const outDir = path.join(os.tmpdir(), 'wa-spotify-cache');
  await fs.mkdir(outDir, { recursive: true });
  const outTemplate = path.join(outDir, `${hash}.%(ext)s`);
  const targetMp3 = path.join(outDir, `${hash}.mp3`);

  await execFileAsync(
    'yt-dlp',
    [
      '--no-simulate',
      '--no-playlist',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '128K',
      '--max-filesize', '18M',
      '-o', outTemplate,
      cleanUrl,
    ],
    { timeout: 60000 }
  );

  spotifyFileCache.set(cleanUrl, {
    filePath: targetMp3,
    expiresAt: Date.now() + 15 * 60 * 1000,
  });
  return targetMp3;
}

/**
 * Ekstrak audio dari video menjadi file MP3 128kbps.
 */
export async function extractVideoToMp3(videoBuffer) {
  const tmpDir = await createTmpDir('wa-mp3-');
  try {
    const inPath = path.join(tmpDir, 'input.mp4');
    const outPath = path.join(tmpDir, 'output.mp3');
    await fs.writeFile(inPath, videoBuffer);

    await execFileAsync('ffmpeg', [
      '-y',
      '-i', inPath,
      '-vn',
      '-c:a', 'libmp3lame',
      '-b:a', '128k',
      '-ar', '44100',
      outPath,
    ]);

    return fs.readFile(outPath);
  } finally {
    await rmDir(tmpDir);
  }
}

/**
 * Hapus background foto secara presisi menggunakan AI.
 * - Jika REMOVE_BG_API_KEY diisi di .env, gunakan API remove.bg.
 * - Secara default gunakan AI neural network lokal `rembg` (model `u2netp`, ringan & akurat untuk wajah/objek di latar ramai).
 */
export async function removeImageBackground(imageBuffer) {
  const apiKey = (process.env.REMOVE_BG_API_KEY || '').trim();

  if (apiKey) {
    const form = new FormData();
    form.append('image_file', new Blob([imageBuffer]), 'image.png');
    form.append('size', 'auto');

    const res = await fetch('https://api.remove.bg/v1.0/removebg', {
      method: 'POST',
      headers: { 'X-Api-Key': apiKey },
      body: form,
    });

    if (res.ok) {
      return Buffer.from(await res.arrayBuffer());
    }
  }

  const tmpDir = await createTmpDir('wa-nobg-');
  try {
    const inPath = path.join(tmpDir, 'in.png');
    const outPath = path.join(tmpDir, 'out.png');
    await fs.writeFile(inPath, imageBuffer);

    const pyScript = `
import sys
from PIL import Image, ImageOps
from rembg import remove, new_session

img = Image.open(sys.argv[1])
img = ImageOps.exif_transpose(img).convert("RGB")

# Batasi sisi maksimum 1600px agar hemat RAM & cepat di server cloud
max_side = 1600
if max(img.size) > max_side:
    img.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)

session = new_session("u2netp")
result = remove(img, session=session)
result.save(sys.argv[2], "PNG")
`;

    await execFileAsync('python3', ['-c', pyScript, inPath, outPath], { timeout: 90000 });
    return fs.readFile(outPath);
  } finally {
    await rmDir(tmpDir);
  }
}
