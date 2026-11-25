import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { addStickerExif } from '../media.js';

const execFileAsync = promisify(execFile);

export const BRAT_THEMES = {
  white: { bg: '#ffffff', fg: '#0a0a0a' },
  green: { bg: '#8ace00', fg: '#0a0a0a' },
  dark: { bg: '#0a0a0a', fg: '#f5f5f5' },
  black: { bg: '#0a0a0a', fg: '#f5f5f5' },
  pink: { bg: '#ff85c0', fg: '#0a0a0a' },
  blue: { bg: '#69c0ff', fg: '#0a0a0a' },
  red: { bg: '#ff4d4f', fg: '#ffffff' },
  yellow: { bg: '#fadb14', fg: '#0a0a0a' },
  purple: { bg: '#b37feb', fg: '#0a0a0a' },
};

const RENDER_PY = `
import sys, os, json
from PIL import Image, ImageDraw, ImageFont, ImageFilter

cfg = json.loads(sys.argv[1])
text = cfg["text"].strip()
bg = cfg["bg"]
fg = cfg["fg"]
out_dir = cfg["out_dir"]
animated = cfg.get("animated", False)

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
]

font_path = None
for p in FONT_CANDIDATES:
    if os.path.exists(p):
        font_path = p
        break

SIZE = 512
PAD = 36
MAX_W = SIZE - PAD * 2
MAX_H = SIZE - PAD * 2

def load_font(sz):
    if font_path:
        return ImageFont.truetype(font_path, sz)
    return ImageFont.load_default()

def wrap_lines(draw, txt, font):
    words = txt.split()
    if not words:
        return [""]
    lines = []
    cur = words[0]
    for w in words[1:]:
        test = cur + " " + w
        bbox = draw.textbbox((0, 0), test, font=font)
        if bbox[2] - bbox[0] <= MAX_W:
            cur = test
        else:
            lines.append(cur)
            cur = w
    lines.append(cur)
    return lines

def render_frame(txt, out_path):
    img = Image.new("RGB", (SIZE, SIZE), bg)
    draw = ImageDraw.Draw(img)

    # Cari ukuran font terbesar yang muat rapi di dalam 512x512
    best_font = load_font(36)
    best_lines = [txt]
    best_lh = 44

    for sz in range(118, 22, -4):
        f = load_font(sz)
        lines = wrap_lines(draw, txt, f)
        lh = int(sz * 1.15)
        total_h = lh * len(lines)
        too_wide = any((draw.textbbox((0, 0), ln, font=f)[2] - draw.textbbox((0, 0), ln, font=f)[0]) > MAX_W for ln in lines)
        if not too_wide and total_h <= MAX_H:
            best_font = f
            best_lines = lines
            best_lh = lh
            break

    total_h = best_lh * len(best_lines)
    y = (SIZE - total_h) // 2

    # Efek brat: teks justified/rata kiri-kanan per baris + sedikit blur khas album brat
    for ln in best_lines:
        words = ln.split()
        if len(words) > 1 and len(best_lines) > 1:
            word_widths = [draw.textbbox((0, 0), w, font=best_font)[2] - draw.textbbox((0, 0), w, font=best_font)[0] for w in words]
            total_w = sum(word_widths)
            gap = (MAX_W - total_w) / (len(words) - 1) if MAX_W > total_w else 8
            if gap > 90:
                # Jangan terlalu renggang jika kata sedikit
                draw.text((PAD, y), ln, font=best_font, fill=fg)
            else:
                x = float(PAD)
                for w, ww in zip(words, word_widths):
                    draw.text((int(x), y), w, font=best_font, fill=fg)
                    x += ww + gap
        else:
            draw.text((PAD, y), ln, font=best_font, fill=fg)
        y += best_lh

    # Soft blur halus khas stiker brat
    img = img.filter(ImageFilter.GaussianBlur(radius=1.15))
    img.save(out_path, "PNG")

if not animated:
    render_frame(text, os.path.join(out_dir, "frame_000.png"))
else:
    words = text.split()
    if len(words) <= 1:
        # Jika hanya 1 kata, tampilkan karakter per tahap
        steps = max(2, min(len(text), 8))
        chunks = [text[:max(1, int(len(text) * (i + 1) / steps))] for i in range(steps)]
    else:
        chunks = [" ".join(words[:i + 1]) for i in range(min(len(words), 18))]
    for idx, ch in enumerate(chunks):
        render_frame(ch, os.path.join(out_dir, f"frame_{idx:03d}.png"))
    # Duplikat frame terakhir agar berhenti sejenak di akhir animasi
    last_idx = len(chunks)
    render_frame(chunks[-1], os.path.join(out_dir, f"frame_{last_idx:03d}.png"))
    render_frame(chunks[-1], os.path.join(out_dir, f"frame_{last_idx + 1:03d}.png"))
`;

/**
 * Membuat stiker Brat (statis atau animasi kata-per-kata) dalam berbagai tema warna.
 */
export async function createBratSticker({
  text,
  theme = 'white',
  animated = false,
  packname = 'Bot by Naqib',
  author = 'Naqib',
}) {
  const cleanText = String(text || '').trim();
  if (!cleanText) {
    throw new Error('Masukkan teks untuk stiker brat!');
  }

  const palette = BRAT_THEMES[theme] || BRAT_THEMES.white;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-brat-'));

  try {
    const cfg = JSON.stringify({
      text: cleanText.slice(0, 180),
      bg: palette.bg,
      fg: palette.fg,
      out_dir: tmpDir,
      animated: Boolean(animated),
    });

    await execFileAsync('python3', ['-c', RENDER_PY, cfg], { timeout: 30000 });

    const outWebp = path.join(tmpDir, 'brat.webp');

    if (!animated) {
      await execFileAsync('ffmpeg', [
        '-y',
        '-i', path.join(tmpDir, 'frame_000.png'),
        '-vcodec', 'libwebp',
        '-lossless', '0',
        '-q:v', '85',
        outWebp,
      ]);
    } else {
      await execFileAsync('ffmpeg', [
        '-y',
        '-framerate', '2.5',
        '-i', path.join(tmpDir, 'frame_%03d.png'),
        '-vcodec', 'libwebp',
        '-lossless', '0',
        '-q:v', '75',
        '-loop', '0',
        '-preset', 'default',
        '-an',
        '-vsync', '0',
        outWebp,
      ]);
    }

    const rawWebp = await fs.readFile(outWebp);
    return addStickerExif(rawWebp, {
      packname,
      author,
      emojis: ['💚'],
    });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
