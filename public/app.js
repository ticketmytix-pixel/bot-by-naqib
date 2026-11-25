const viewLogin = document.getElementById('view-login');
const viewDashboard = document.getElementById('view-dashboard');
const userBar = document.getElementById('user-bar');
const userNameEl = document.getElementById('user-name');
const userRoleBadge = document.getElementById('user-role-badge');
const userVerifiedBadge = document.getElementById('user-verified-badge');
const btnLogoutAccount = document.getElementById('btn-logout-account');

const oauthConfigHint = document.getElementById('oauth-config-hint');
const loginError = document.getElementById('login-error');

const statActiveBots = document.getElementById('stat-active-bots');
const statTotalStickers = document.getElementById('stat-total-stickers');
const statTotalDownloads = document.getElementById('stat-total-downloads');

const panelOtp = document.getElementById('panel-otp');
const otpSendForm = document.getElementById('otp-send-form');
const otpPhoneInput = document.getElementById('otp-phone');
const btnSendOtp = document.getElementById('btn-send-otp');
const otpVerifyForm = document.getElementById('otp-verify-form');
const otpCodeInput = document.getElementById('otp-code');
const btnVerifyOtp = document.getElementById('btn-verify-otp');
const otpSuccess = document.getElementById('otp-success');
const otpError = document.getElementById('otp-error');

const panelVipGate = document.getElementById('panel-vip-gate');
const vipGateTag = document.getElementById('vip-gate-tag');
const vipGateTitle = document.getElementById('vip-gate-title');
const vipGateDesc = document.getElementById('vip-gate-desc');
const vipWaLink = document.getElementById('vip-wa-link');

const panelPairing = document.getElementById('panel-pairing');
const panelBotsList = document.getElementById('panel-bots-list');
const panelOwner = document.getElementById('panel-owner');

const tosCheckbox = document.getElementById('tos-checkbox');
const pairForm = document.getElementById('pair-form');
const botPhoneInput = document.getElementById('bot-phone');
const botPackInput = document.getElementById('bot-pack');
const btnPair = document.getElementById('btn-pair');
const pairError = document.getElementById('pair-error');

const botsContainer = document.getElementById('bots-container');
const usersContainer = document.getElementById('users-container');

let currentUser = null;
let pollTimer = null;

function showEl(el, visible) {
  el.hidden = !visible;
}

function showMsg(el, msg) {
  if (!msg) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.textContent = msg;
  el.hidden = false;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatExpiry(ts) {
  if (!ts) return 'LIFETIME';
  const d = new Date(Number(ts));
  return d.toLocaleDateString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function updateStats(stats) {
  if (!stats) return;
  statActiveBots.textContent = String(stats.activeBots ?? 0);
  statTotalStickers.textContent = String(stats.totalStickers ?? 0);
  statTotalDownloads.textContent = String(stats.totalDownloads ?? 0);
}

function renderBots(bots) {
  if (!bots || bots.length === 0) {
    botsContainer.innerHTML = '<p class="empty-state">Belum ada nomor WhatsApp yang ditautkan.</p>';
    return;
  }

  const STATUS_TEXT = {
    idle: 'SIAP',
    connecting: 'MENGHUBUNGKAN...',
    pairing: 'MENUNGGU PAIRING',
    connected: 'TERHUBUNG',
    error: 'ERROR',
  };

  botsContainer.innerHTML = bots
    .map((b) => {
      const codeHtml = b.pairingCode
        ? `
          <div class="bot-code-bar">
            <div>
              <div class="tiny-note" style="margin:0 0 2px;color:#b6f7e2;">Masukkan kode ini di WA → Perangkat Tertaut:</div>
              <div class="bot-code-digits">${escapeHtml(b.pairingCode)}</div>
            </div>
            <button type="button" class="btn-outline-sm" data-copy="${escapeHtml(b.pairingCode.replace(/[^A-Z0-9]/gi, ''))}">Salin</button>
          </div>`
        : '';

      const errHtml = b.lastError
        ? `<div class="alert-error" style="margin:0;">${escapeHtml(b.lastError)}</div>`
        : '';

      return `
        <div class="bot-item">
          <div class="bot-item-top">
            <div>
              <div class="bot-phone">+${escapeHtml(b.phone || '-')}</div>
              <div class="bot-meta">${escapeHtml(b.packName)} • Pemilik: ${escapeHtml(b.ownerEmail)}</div>
            </div>
            <span class="bot-status" data-status="${escapeHtml(b.status)}">${STATUS_TEXT[b.status] || b.status}</span>
          </div>
          ${codeHtml}
          ${errHtml}
          <div class="bot-item-foot">
            <span>Stiker: ${(b.stats?.stickersSent || 0) + (b.stats?.audioStickersSent || 0)} • Tools/DL: ${b.stats?.downloads || 0}</span>
            <div style="display:flex;gap:6px;">
              <button type="button" class="btn-outline-sm" data-rename-bot="${escapeHtml(b.id)}" data-current-name="${escapeHtml(b.packName)}">Ubah Nama</button>
              <button type="button" class="btn-danger-sm" data-delete-bot="${escapeHtml(b.id)}">Hapus / Putuskan</button>
            </div>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderOwnerUsers(users) {
  if (!users || users.length === 0) {
    usersContainer.innerHTML = '<p class="empty-state">Belum ada akun terdaftar.</p>';
    return;
  }

  usersContainer.innerHTML = users
    .map((u) => {
      const isSelf = currentUser && u.email === currentUser.email;

      const verifiedTag = u.phoneVerified
        ? `<span class="verify-badge">✓ +${escapeHtml(u.verifiedPhone)}</span>`
        : `<span class="verify-badge" data-verified="false">BELUM OTP</span>`;

      let vipStatusTag = '';
      if (u.role === 'buyer') {
        if (u.vipExpired) {
          vipStatusTag = `<span class="verify-badge" data-verified="false">VIP EXPIRED</span>`;
        } else if (!u.vipExpiresAt) {
          vipStatusTag = `<span class="verify-badge">VIP LIFETIME</span>`;
        } else {
          vipStatusTag = `<span class="verify-badge">VIP s/d ${escapeHtml(formatExpiry(u.vipExpiresAt))}</span>`;
        }
      }

      const controls = isSelf
        ? '<span class="tiny-note">(Akun Owner)</span>'
        : `
          <select class="duration-select" data-duration-for="${escapeHtml(u.email)}">
            <option value="7">7 Hari</option>
            <option value="30" selected>30 Hari (1 Bln)</option>
            <option value="90">90 Hari (3 Bln)</option>
            <option value="365">365 Hari (1 Thn)</option>
            <option value="lifetime">Lifetime (Selamanya)</option>
          </select>
          <button type="button" class="btn-outline-sm" data-set-role="buyer" data-email="${escapeHtml(u.email)}">
            ${u.role === 'buyer' ? 'Perpanjang VIP' : 'Jadikan VIP'}
          </button>
          ${
            u.role === 'buyer'
              ? `<button type="button" class="btn-danger-sm" data-set-role="user" data-email="${escapeHtml(u.email)}">Cabut VIP</button>`
              : ''
          }
          ${
            u.phoneVerified
              ? `<button type="button" class="btn-danger-sm" data-unverify-email="${escapeHtml(u.email)}">Batal Verifikasi</button>`
              : ''
          }
        `;

      return `
        <div class="user-row">
          <div class="user-row-info">
            <span class="user-row-email">${escapeHtml(u.name)} (${escapeHtml(u.email)})</span>
            <div class="badges-row">
              <span class="role-badge" data-role="${escapeHtml(u.role)}">${escapeHtml(u.role.toUpperCase())}</span>
              ${verifiedTag}
              ${vipStatusTag}
            </div>
          </div>
          <div class="user-row-actions">
            ${controls}
          </div>
        </div>
      `;
    })
    .join('');
}

async function refreshDashboardData() {
  if (!currentUser || document.visibilityState !== 'visible') return;
  try {
    const botsRes = await fetch('/api/bots', { cache: 'no-store', credentials: 'same-origin' });
    if (botsRes.ok) {
      const data = await botsRes.json();
      updateStats(data.globalStats);
      if (currentUser.role === 'owner' || currentUser.vipActive) {
        renderBots(data.bots);
      }
    }

    if (currentUser.role === 'owner') {
      const usersRes = await fetch('/api/admin/users', { cache: 'no-store', credentials: 'same-origin' });
      if (usersRes.ok) {
        const data = await usersRes.json();
        renderOwnerUsers(data.users);
      }
    }
  } catch {
    // Abaikan error jaringan sesaat
  }
}

async function init() {
  const params = new URLSearchParams(window.location.search);
  const authErr = params.get('auth_error');
  if (authErr) {
    const errMap = {
      oauth_not_configured: 'Google OAuth belum dikonfigurasi. Isi GOOGLE_CLIENT_ID & GOOGLE_CLIENT_SECRET di .env hosting Anda.',
      invalid_state: 'Sesi login Google kadaluarsa. Silakan coba masuk lagi.',
      token_failed: 'Gagal menukar token Google OAuth. Periksa Redirect URI di Google Cloud Console.',
      email_unverified: 'Email Google Anda belum terverifikasi.',
    };
    showMsg(loginError, errMap[authErr] || 'Gagal login dengan Google.');
    window.history.replaceState({}, '', '/');
  }

  const res = await fetch('/api/me', { cache: 'no-store', credentials: 'same-origin' });
  const data = await res.json();

  currentUser = data.user || null;
  updateStats(data.globalStats);

  if (!currentUser) {
    showEl(userBar, false);
    showEl(viewDashboard, false);
    showEl(viewLogin, true);
    showEl(oauthConfigHint, !data.googleOAuthEnabled);
    if (pollTimer) clearInterval(pollTimer);
    return;
  }

  // User sudah login dengan Google -> tampilkan Dashboard
  showEl(viewLogin, false);
  showEl(viewDashboard, true);
  showEl(userBar, true);

  userNameEl.textContent = currentUser.name || currentUser.email;

  const isOwner = currentUser.role === 'owner';
  const isVipActive = Boolean(currentUser.vipActive);
  const isVipExpired = Boolean(currentUser.vipExpired);
  const isVerified = Boolean(currentUser.phoneVerified);
  const hasOnlineBot = (data.globalStats?.activeBots || 0) > 0;

  if (isOwner) {
    userRoleBadge.textContent = 'OWNER';
    userRoleBadge.dataset.role = 'owner';
  } else if (isVipActive) {
    const expLabel = currentUser.vipExpiresAt ? `s/d ${formatExpiry(currentUser.vipExpiresAt)}` : 'LIFETIME';
    userRoleBadge.textContent = `VIP (${expLabel})`;
    userRoleBadge.dataset.role = 'buyer';
  } else if (isVipExpired) {
    userRoleBadge.textContent = 'VIP EXPIRED';
    userRoleBadge.dataset.role = 'user';
  } else {
    userRoleBadge.textContent = 'FREE USER';
    userRoleBadge.dataset.role = 'user';
  }

  showEl(userVerifiedBadge, true);
  if (isVerified) {
    userVerifiedBadge.textContent = `✓ +${currentUser.verifiedPhone}`;
    userVerifiedBadge.dataset.verified = 'true';
  } else {
    userVerifiedBadge.textContent = 'BELUM OTP';
    userVerifiedBadge.dataset.verified = 'false';
  }

  // ALUR KETAT:
  // 1. Wajib Verifikasi OTP nomor WA terlebih dahulu (semua user yang belum verified)
  showEl(panelOtp, !isVerified);

  // 2. Setelah terverifikasi OTP: jika belum VIP atau VIP expired -> tampilkan kartu Beli/Perpanjang VIP ke WA 085185779714
  const showVipGate = !isOwner && isVerified && !isVipActive;
  showEl(panelVipGate, showVipGate);

  if (showVipGate) {
    const accountName = currentUser.name || currentUser.email;
    const waNumber = currentUser.verifiedPhone ? `+${currentUser.verifiedPhone}` : '-';

    if (isVipExpired) {
      vipGateTag.textContent = 'MASA AKTIF VIP HABIS';
      vipGateTitle.textContent = 'Masa Aktif VIP Anda Telah Berakhir';
      vipGateDesc.innerHTML =
        'Bot WhatsApp Anda saat ini dijeda sementara karena masa aktif VIP sudah habis. Lakukan pembayaran/perpanjangan ke Owner agar bot aktif kembali.';
      vipWaLink.textContent = 'Perpanjang VIP via WhatsApp (085185779714)';
    } else {
      vipGateTag.textContent = 'AKSES TERBATAS — KHUSUS VIP';
      vipGateTitle.textContent = 'Upgrade ke Role Buyer (VIP) untuk Jadi Bot';
      vipGateDesc.innerHTML =
        'Nomor WhatsApp Anda sudah <strong>Terverifikasi ✓</strong>. Untuk menjadikan nomor WA Anda sebagai <strong>Bot by Naqib</strong>, hubungi Owner via WhatsApp di bawah ini:';
      vipWaLink.textContent = 'Chat WhatsApp Owner (085185779714) — Beli Bot VIP';
    }

    const waText = encodeURIComponent(
      `Halo saya mau beli bot\n` +
      `Nama Akun: ${accountName}\n` +
      `Email Google: ${currentUser.email}\n` +
      `Nomor WA Terverifikasi: ${waNumber}`
    );
    vipWaLink.href = `https://wa.me/${data.vipWaIntl}?text=${waText}`;
  }

  // 3. Pairing hanya terbuka untuk Owner (termasuk bootstrap bot pertama) atau Buyer VIP aktif yang sudah OTP
  const canPairNow = isOwner || (isVipActive && isVerified);
  showEl(panelPairing, canPairNow);
  showEl(panelBotsList, isOwner || isVipActive);
  showEl(panelOwner, isOwner);

  if (isOwner && !isVerified && !hasOnlineBot) {
    showMsg(otpSuccess, 'Tips Owner: Tautkan minimal 1 bot WhatsApp di bawah terlebih dahulu agar server bisa mengirim kode OTP ke WhatsApp Anda dan user lain.');
  }

  await refreshDashboardData();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refreshDashboardData, 4000);
}

// Kirim OTP ke WhatsApp
otpSendForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  showMsg(otpError, '');
  showMsg(otpSuccess, '');
  btnSendOtp.disabled = true;
  btnSendOtp.textContent = 'Mengirim OTP ke WhatsApp...';

  try {
    const res = await fetch('/api/otp/send', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: otpPhoneInput.value.trim() }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Gagal mengirim OTP');
    showMsg(otpSuccess, data.message);
    showEl(otpVerifyForm, true);
    otpCodeInput.focus();
  } catch (err) {
    showMsg(otpError, err.message);
  } finally {
    btnSendOtp.disabled = false;
    btnSendOtp.textContent = 'Kirim Ulang Kode OTP';
  }
});

// Konfirmasi OTP 6 digit
otpVerifyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  showMsg(otpError, '');
  showMsg(otpSuccess, '');
  btnVerifyOtp.disabled = true;
  btnVerifyOtp.textContent = 'Memverifikasi...';

  try {
    const res = await fetch('/api/otp/verify', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: otpCodeInput.value.trim() }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'OTP salah');
    showMsg(otpSuccess, data.message);
    await init();
  } catch (err) {
    showMsg(otpError, err.message);
  } finally {
    btnVerifyOtp.disabled = false;
    btnVerifyOtp.textContent = 'Konfirmasi & Verifikasi Nomor';
  }
});

// Logout akun (hapus sesi di server + redirect bersih lewat /auth/logout)
btnLogoutAccount.addEventListener('click', async () => {
  btnLogoutAccount.disabled = true;
  btnLogoutAccount.textContent = 'Keluar...';
  if (pollTimer) clearInterval(pollTimer);
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {
    // Tetap redirect ke /auth/logout untuk memastikan cookie terhapus
  }
  window.location.replace('/auth/logout');
});

// Checkbox persetujuan aturan WhatsApp
tosCheckbox.addEventListener('change', () => {
  btnPair.disabled = !tosCheckbox.checked;
});

// Pairing nomor WA baru
pairForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!tosCheckbox.checked) {
    showMsg(pairError, 'Centang persetujuan aturan WhatsApp terlebih dahulu.');
    return;
  }

  showMsg(pairError, '');
  btnPair.disabled = true;
  btnPair.textContent = 'Meminta kode pairing...';

  try {
    const res = await fetch('/api/bots/pair', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: botPhoneInput.value.trim(),
        packName: botPackInput.value.trim() || 'Bot by Naqib',
        acceptedTos: true,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Gagal pairing');
    botPhoneInput.value = '';
    await refreshDashboardData();
  } catch (err) {
    showMsg(pairError, err.message);
  } finally {
    btnPair.disabled = !tosCheckbox.checked;
    btnPair.textContent = 'Generate Kode Pairing 8 Digit';
  }
});

// Delegasi tombol Salin & Hapus Bot
botsContainer.addEventListener('click', async (e) => {
  const copyBtn = e.target.closest('[data-copy]');
  if (copyBtn) {
    const code = copyBtn.getAttribute('data-copy');
    try {
      await navigator.clipboard.writeText(code);
      copyBtn.textContent = 'Tersalin!';
      setTimeout(() => (copyBtn.textContent = 'Salin'), 1600);
    } catch {
      copyBtn.textContent = 'Salin manual';
    }
    return;
  }

  const renameBtn = e.target.closest('[data-rename-bot]');
  if (renameBtn) {
    const id = renameBtn.getAttribute('data-rename-bot');
    const currentName = renameBtn.getAttribute('data-current-name') || 'Bot by Naqib';
    const nextName = window.prompt('Masukkan Nama Bot & Pack Stiker baru:', currentName);
    if (!nextName || !nextName.trim()) return;
    renameBtn.disabled = true;
    renameBtn.textContent = 'Menyimpan...';
    await fetch(`/api/bots/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packName: nextName.trim(), packAuthor: nextName.trim() }),
    });
    await refreshDashboardData();
    return;
  }

  const delBtn = e.target.closest('[data-delete-bot]');
  if (delBtn) {
    const id = delBtn.getAttribute('data-delete-bot');
    delBtn.disabled = true;
    delBtn.textContent = 'Menghapus...';
    await fetch(`/api/bots/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    await refreshDashboardData();
  }
});

// Delegasi tombol Owner ubah role, durasi VIP, & batal verifikasi OTP user
usersContainer.addEventListener('click', async (e) => {
  const unverifyBtn = e.target.closest('[data-unverify-email]');
  if (unverifyBtn) {
    const email = unverifyBtn.getAttribute('data-unverify-email');
    unverifyBtn.disabled = true;
    unverifyBtn.textContent = 'Memproses...';
    await fetch('/api/admin/users/unverify', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    await refreshDashboardData();
    return;
  }

  const btn = e.target.closest('[data-set-role]');
  if (!btn) return;
  const role = btn.getAttribute('data-set-role');
  const email = btn.getAttribute('data-email');
  const selectEl = usersContainer.querySelector(`select[data-duration-for="${CSS.escape(email)}"]`);
  const durationDays = role === 'buyer' ? (selectEl ? selectEl.value : '30') : null;

  btn.disabled = true;
  await fetch('/api/admin/users/role', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, role, durationDays }),
  });
  await refreshDashboardData();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    refreshDashboardData();
  }
});

init();
