import crypto from 'node:crypto';

/**
 * Pool token 6 angka acak untuk XOX Live PvP lintas semua bot & grup.
 * - Setiap room PvP mendapat token 6 angka unik (100000..999999) yang tidak sedang dipakai bot/grup lain.
 * - Begitu permainan selesai (menang/seri) atau idle > 10 menit, token otomatis dilepas kembali agar bisa dipakai bot/grup lain.
 */
const activeRooms = new Map(); // token(6 digit) -> roomState
const sseClients = new Map(); // token -> Set<http.ServerResponse>

const IDLE_TTL_MS = 10 * 60 * 1000; // 10 menit idle -> otomatis lepas token
const FINISHED_RELEASE_MS = 30 * 1000; // 30 detik setelah game selesai -> otomatis lepas token

const WIN_LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

function checkWinner(board) {
  for (const [a, b, c] of WIN_LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a];
    }
  }
  if (board.every(Boolean)) return 'DRAW';
  return null;
}

function generateUniqueToken() {
  for (let i = 0; i < 50; i++) {
    const token = String(crypto.randomInt(100000, 1000000));
    if (!activeRooms.has(token)) return token;
  }
  throw new Error('Semua slot token XOX sedang penuh. Coba lagi sebentar.');
}

function broadcastRoom(token, payloadObj) {
  const clients = sseClients.get(token);
  if (!clients) return;
  const line = `data: ${JSON.stringify(payloadObj)}\n\n`;
  for (const res of clients) {
    try {
      res.write(line);
    } catch {
      clients.delete(res);
    }
  }
}

export function releaseXoxToken(token) {
  const room = activeRooms.get(token);
  if (room?.releaseTimer) {
    clearTimeout(room.releaseTimer);
  }
  activeRooms.delete(token);

  const clients = sseClients.get(token);
  if (clients) {
    for (const res of clients) {
      try {
        res.end();
      } catch {
        // Abaikan
      }
    }
    sseClients.delete(token);
  }
}

/**
 * Buat room PvP baru dengan token 6 angka acak unik (tidak bentrok dengan bot/grup lain).
 */
export function allocateXoxRoom({ botId = '', groupJid = '' } = {}) {
  const token = generateUniqueToken();
  const room = {
    token,
    botId,
    groupJid,
    playerX: null,
    playerO: null,
    board: Array(9).fill(null),
    turn: 'X',
    winner: null,
    scores: { X: 0, O: 0, D: 0 },
    status: 'waiting', // waiting | playing | finished
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    releaseTimer: null,
  };
  activeRooms.set(token, room);
  return token;
}

export function getXoxRoomPublicState(room) {
  if (!room) return null;
  return {
    token: room.token,
    playerX: Boolean(room.playerX),
    playerO: Boolean(room.playerO),
    board: room.board,
    turn: room.turn,
    winner: room.winner,
    scores: room.scores,
    status: room.status,
  };
}

export function attachXoxSseClient(token, res) {
  if (!sseClients.has(token)) sseClients.set(token, new Set());
  const clients = sseClients.get(token);
  clients.add(res);

  const room = activeRooms.get(token);
  if (room) {
    res.write(`data: ${JSON.stringify(getXoxRoomPublicState(room))}\n\n`);
  } else {
    res.write(`data: ${JSON.stringify({ expired: true })}\n\n`);
  }

  return () => {
    clients.delete(res);
    if (clients.size === 0) sseClients.delete(token);
  };
}

export function handleXoxRoomAction({ token, clientId, action, idx }) {
  const cleanToken = String(token || '').replace(/\D/g, '');
  const room = activeRooms.get(cleanToken);

  if (!room) {
    return {
      ok: false,
      expired: true,
      error: 'Token 6 angka sudah selesai dipakai atau kadaluarsa. Ketik .xox lagi di grup untuk token baru!',
    };
  }

  room.lastActivityAt = Date.now();
  let changed = false;

  // Tentukan simbol pemain (X / O / Penonton)
  let symbol = 'SPEC';
  if (room.playerX === clientId) {
    symbol = 'X';
  } else if (room.playerO === clientId) {
    symbol = 'O';
  } else if (!room.playerX) {
    room.playerX = clientId;
    symbol = 'X';
    changed = true;
  } else if (!room.playerO) {
    room.playerO = clientId;
    room.status = 'playing';
    symbol = 'O';
    changed = true;
  }

  if (action === 'move' && symbol === room.turn && room.status === 'playing') {
    const cell = Number(idx);
    if (Number.isInteger(cell) && cell >= 0 && cell < 9 && !room.board[cell]) {
      room.board[cell] = symbol;
      const win = checkWinner(room.board);
      if (win) {
        room.winner = win;
        room.status = 'finished';
        if (win === 'DRAW') room.scores.D += 1;
        else room.scores[win] += 1;

        // Jadwalkan pelepasan token otomatis agar bisa dipakai bot/grup lain
        if (room.releaseTimer) clearTimeout(room.releaseTimer);
        room.releaseTimer = setTimeout(() => {
          broadcastRoom(cleanToken, { ...getXoxRoomPublicState(room), tokenReleased: true });
          releaseXoxToken(cleanToken);
        }, FINISHED_RELEASE_MS);
      } else {
        room.turn = room.turn === 'X' ? 'O' : 'X';
      }
      changed = true;
    }
  } else if (action === 'close' && (symbol === 'X' || symbol === 'O')) {
    const finalState = { ...getXoxRoomPublicState(room), tokenReleased: true };
    broadcastRoom(cleanToken, finalState);
    releaseXoxToken(cleanToken);
    return { ok: true, symbol, room: finalState, tokenReleased: true };
  }

  const publicState = getXoxRoomPublicState(room);
  if (changed) {
    broadcastRoom(cleanToken, publicState);
  }

  return { ok: true, symbol, room: publicState };
}

// Bersihkan room idle otomatis setiap 60 detik agar token kembali ke pool
setInterval(() => {
  const now = Date.now();
  for (const [token, room] of activeRooms) {
    if (now - room.lastActivityAt > IDLE_TTL_MS) {
      releaseXoxToken(token);
    }
  }
}, 60_000).unref();
