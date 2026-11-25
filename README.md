# Bot by Naqib — Multi-Bot WhatsApp Platform (24/7)

Platform Multi-Bot WhatsApp futuristik yang memungkinkan **banyak nomor WhatsApp menjadi bot secara bersamaan**, dilengkapi:
- **Login Resmi Google OAuth2** (Akun pertama / `OWNER_EMAIL` otomatis menjadi **OWNER**)
- **Verifikasi OTP 6 Digit ke WhatsApp** di backend (`phoneVerified: true`)
- **Sistem Role (`OWNER`, `BUYER` VIP, `USER`)** — upgrade VIP via WhatsApp **`085185779714`**
- **Peringatan Resmi Aturan WhatsApp (ToS)** sebelum pairing
- **Ringan & Anti-Lag** (Gzip RAM Cache, IP Rate Limiter, Debounced DB Writes, Visibility-Aware Polling)
- **Fitur Bot Lengkap:**
  - `.s --audio` / `.sa` — **Sound Sticker** (video maks 5 detik / gambar+VN maks 10 detik)
  - `.s` — Sticker biasa gambar/video (tambah `--crop` untuk 1:1)
  - `.dl <link>` / `.tiktok <link>` — Download video sosmed **tanpa watermark**
  - `.spotify <judul/link>` / `.play <judul>` — Dengar & unduh musik MP3
  - `.toaudio` / `.tomp3` — Ekstrak audio MP3 dari video
  - `.removebg` / `.nobg` — Hapus background foto jadi PNG transparan
  - `.antidelete on/off`, `.antiedit on/off`, `.antikudeta on/off` — Proteksi Grup
  - `.xox` — Minigame Tic-Tac-Toe (XOX)

---

## Tutorial Aktifkan 24 Jam Nonstop (Lewat HP)

### Langkah 1 — Upload ke GitHub
1. Ekstrak file `bot-by-naqib.zip` di HP Anda.
2. Buka https://github.com/new → buat repo baru (misal: `bot-by-naqib`) → klik **Create repository**.
3. Pilih **uploading an existing file** → upload seluruh isi folder hasil ekstrak (`Dockerfile`, `package.json`, `package-lock.json`, `src/`, `public/`, dll.) → klik **Commit changes**.

### Langkah 2 — Deploy 24/7 di Railway (atau Koyeb)
1. Buka https://railway.app → Login pakai **GitHub**.
2. Klik **New Project → Deploy from GitHub repo → pilih `bot-by-naqib`**.
3. Railway otomatis memakai `Dockerfile` (Node.js 22 + FFmpeg + yt-dlp + Python Pillow langsung terpasang).
4. Buka tab **Settings → Networking → Generate Domain** (catat domain Anda, contoh: `https://bot-naqib.up.railway.app`).
5. Buka tab **Volumes → Add Volume** agar sesi & data user tidak hilang saat restart:
   - Mount Path 1: `/app/sessions`
   - Mount Path 2: `/app/data`

### Langkah 3 — Aktifkan Login Google Resmi (OAuth2)
1. Buka https://console.cloud.google.com/apis/credentials
2. Klik **Create Credentials → OAuth client ID → Web application**.
3. Pada **Authorized redirect URIs**, masukkan:
   ```
   https://DOMAIN-ANDA/auth/google/callback
   ```
4. Salin **Client ID** dan **Client Secret**, lalu masukkan ke menu **Variables** di Railway/Koyeb:
   - `GOOGLE_CLIENT_ID` = `<Client ID Anda>`
   - `GOOGLE_CLIENT_SECRET` = `<Client Secret Anda>`
   - `PUBLIC_URL` = `https://DOMAIN-ANDA`
   - `OWNER_EMAIL` = `<email.gmail.anda@gmail.com>`

### Langkah 4 — Pairing Bot Pertama & Verifikasi OTP
1. Buka `https://DOMAIN-ANDA` di browser HP Anda.
2. Klik **Lanjutkan dengan Google** dengan akun Gmail `OWNER_EMAIL` Anda → Anda otomatis masuk sebagai **OWNER**.
3. Centang persetujuan aturan WhatsApp → masukkan nomor WA bot pertama → klik **Generate Kode Pairing 8 Digit** → masukkan di **WhatsApp → Perangkat Tertaut → Tautkan dengan nomor telepon saja**.
4. Setelah bot pertama **TERHUBUNG**, fitur **Verifikasi OTP WhatsApp** aktif untuk semua user & bot Anda jalan **24 jam nonstop**!
