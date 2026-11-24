const statusBadge = document.getElementById('status-badge');
const statusText = document.getElementById('status-text');
const panelPair = document.getElementById('panel-pair');
const panelConnected = document.getElementById('panel-connected');

const pairForm = document.getElementById('pair-form');
const phoneInput = document.getElementById('phone-input');
const pairBtn = document.getElementById('pair-btn');
const pairBtnLabel = pairBtn.querySelector('.btn-label');

const errorBox = document.getElementById('error-box');
const codeSection = document.getElementById('code-section');
const pairingCodeEl = document.getElementById('pairing-code');
const copyBtn = document.getElementById('copy-btn');

const connectedNumberEl = document.getElementById('connected-number');
const statAudioEl = document.getElementById('stat-audio');
const statNormalEl = document.getElementById('stat-normal');
const logoutBtn = document.getElementById('logout-btn');

let isRequesting = false;

const STATUS_LABELS = {
  idle: 'Siap Pairing',
  connecting: 'Menghubungkan...',
  pairing: 'Menunggu kode dimasukkan di WA',
  connected: 'Terhubung',
  error: 'Perlu pairing ulang',
};

function showError(msg) {
  if (!msg) {
    errorBox.hidden = true;
    errorBox.textContent = '';
    return;
  }
  errorBox.textContent = msg;
  errorBox.hidden = false;
}

function renderStatus(data) {
  const state = data.status || 'idle';
  statusBadge.dataset.state = state;
  statusText.textContent = STATUS_LABELS[state] || state;

  if (state === 'connected') {
    panelPair.hidden = true;
    panelConnected.hidden = false;
    const phone = data.connectedUser?.phone ? `+${data.connectedUser.phone}` : 'WhatsApp';
    const name = data.connectedUser?.name ? ` (${data.connectedUser.name})` : '';
    connectedNumberEl.textContent = `${phone}${name}`;
    statAudioEl.textContent = String(data.stats?.audioStickersSent ?? 0);
    statNormalEl.textContent = String(data.stats?.stickersSent ?? 0);
    showError('');
    return;
  }

  panelPair.hidden = false;
  panelConnected.hidden = true;

  if (data.pairingCode) {
    pairingCodeEl.textContent = data.pairingCode;
    codeSection.hidden = false;
  } else if (!isRequesting) {
    codeSection.hidden = true;
  }

  if (data.lastError && !isRequesting) {
    showError(data.lastError);
  }
}

async function pollStatus() {
  try {
    const res = await fetch('/api/status', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      renderStatus(data);
    }
  } catch {
    // Abaikan error jaringan sesaat saat polling
  }
}

pairForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const phone = phoneInput.value.trim();
  if (!phone) {
    showError('Masukkan nomor WhatsApp terlebih dahulu.');
    phoneInput.focus();
    return;
  }

  isRequesting = true;
  showError('');
  pairBtn.disabled = true;
  pairBtnLabel.textContent = 'Meminta kode pairing...';

  try {
    const res = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'Gagal mendapatkan kode pairing.');
    }

    pairingCodeEl.textContent = data.code;
    codeSection.hidden = false;
    if (data.status) renderStatus(data.status);
  } catch (err) {
    showError(err.message || 'Gagal meminta kode pairing.');
  } finally {
    isRequesting = false;
    pairBtn.disabled = false;
    pairBtnLabel.textContent = 'Dapatkan Kode Pairing';
  }
});

copyBtn.addEventListener('click', async () => {
  const cleanCode = pairingCodeEl.textContent.replace(/[^A-Z0-9]/gi, '');
  if (!cleanCode) return;
  try {
    await navigator.clipboard.writeText(cleanCode);
    copyBtn.textContent = 'Tersalin!';
    setTimeout(() => {
      copyBtn.textContent = 'Salin';
    }, 1800);
  } catch {
    copyBtn.textContent = 'Salin manual';
  }
});

logoutBtn.addEventListener('click', async () => {
  logoutBtn.disabled = true;
  logoutBtn.textContent = 'Memutuskan...';
  try {
    const res = await fetch('/api/logout', { method: 'POST' });
    const data = await res.json();
    if (data.status) renderStatus(data.status);
  } finally {
    logoutBtn.disabled = false;
    logoutBtn.textContent = 'Ganti Nomor';
  }
});

pollStatus();
setInterval(pollStatus, 2000);
