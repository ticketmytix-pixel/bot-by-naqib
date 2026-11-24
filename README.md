# WhatsApp Audio Sticker Bot (Sound Sticker + Pairing Code)

Bot WhatsApp siap pakai (**tinggal pairing**) yang mendukung fitur **Sound Sticker / Sticker Audio** sesuai update terbaru WhatsApp (protobuf `StickerMessage.audioMessage` field `26`).

## Fitur

- **Tinggal Pairing**: Login langsung menggunakan **Pairing Code 8 digit** (tanpa perlu scan QR).
- **Sound Sticker dari Video (`.s --audio` / `.sa`)**:
  - Kirim video dengan caption `.s --audio` atau reply video dengan `.s --audio`.
  - Otomatis mengubah video menjadi stiker animasi WebP 512×512 (maks 5 detik, dikompresi otomatis `<= 500 KB`) + mengekstrak audio ke OGG Opus dan menggabungkannya sebagai Sound Sticker.
- **Sound Sticker dari Gambar + Audio/VN**:
  - Reply pesan audio/VN lalu kirim gambar dengan caption `.s --audio` (atau sebaliknya: reply gambar/stiker lalu kirim audio/VN).
  - Mendukung durasi audio hingga **10 detik** untuk stiker statis.
- **Sticker Biasa (`.s`)**:
  - Mendukung gambar maupun video/GIF.
  - Mendukung opsi `--crop` / `-c` untuk crop 1:1 penuh.
- **Auto-Patch WAProto**: Otomatis menambahkan dukungan field `26` (`audioMessage`) pada `StickerMessage` Baileys saat runtime.

## Prasyarat

- **Node.js** v18+ (disarankan v20 / v22)
- **FFmpeg** (termasuk `ffprobe`)

Install FFmpeg:
- **Ubuntu/Debian**: `sudo apt update && sudo apt install -y ffmpeg`
- **Termux (Android)**: `pkg install nodejs-lts ffmpeg`
- **Windows**: `winget install Gyan.FFmpeg`

## Cara Menjalankan

1. Masuk ke folder project dan install dependensi:
   ```bash
   cd wa-audio-sticker-bot
   npm install
   ```

2. *(Opsional)* Salin `.env.example` ke `.env` untuk mengatur nomor pairing, packname, author, atau prefix:
   ```bash
   cp .env.example .env
   ```

3. Jalankan bot:
   ```bash
   npm start
   ```

4. Masukkan nomor WhatsApp bot (format internasional tanpa `+`, contoh: `6281234567890`) saat diminta di terminal.
5. Terminal akan menampilkan **Kode Pairing 8 digit** (misalnya `ABCD-1234`).
6. Di HP Anda, buka **WhatsApp → Perangkat Tertaut → Tautkan Perangkat → Tautkan dengan nomor telepon saja**, lalu masukkan kode tersebut.

## Daftar Command

| Command | Fungsi |
|---|---|
| `.s --audio` / `.sa` | Buat **Sound Sticker** dari video (maks 5 detik) atau gambar + reply audio (maks 10 detik) |
| `.s --audio --crop` | Buat Sound Sticker dengan crop 1:1 penuh |
| `.s` / `.stiker` | Buat stiker biasa (statis/animasi) |
| `.menu` / `.help` | Tampilkan panduan penggunaan |

> **Catatan:** Ikon speaker (`🔇`/`🔊`) dan pemutaran suara pada Sound Sticker hanya muncul di aplikasi WhatsApp versi terbaru / WhatsApp Beta yang sudah mengaktifkan fitur Sound Stickers. Pada versi WhatsApp lama, stiker tetap tampil sebagai stiker normal.
