const NUM_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];

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

// Antrean matchmaking per grup: groupJid -> waitingSenderJid
const groupWaiting = new Map();

// Pertandingan aktif: matchId -> { id, jid, isBotGame, playerX, playerO, board, turn }
const activeMatches = new Map();

// Peta pemain ke matchId aktif di chat tertentu: `${jid}:${playerJid}` -> matchId
const playerMatchKey = new Map();

let matchSeq = 1;

function renderBoard(board) {
  const cells = board.map((cell, idx) => {
    if (cell === 'X') return '❌';
    if (cell === 'O') return '⭕';
    return NUM_EMOJIS[idx];
  });
  return [
    `${cells[0]} ${cells[1]} ${cells[2]}`,
    `${cells[3]} ${cells[4]} ${cells[5]}`,
    `${cells[6]} ${cells[7]} ${cells[8]}`,
  ].join('\n');
}

function checkWinner(board) {
  for (const [a, b, c] of WIN_LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a];
    }
  }
  if (board.every(Boolean)) return 'DRAW';
  return null;
}

/**
 * AI Bot pintar untuk mode DM (1v1 lawan Bot):
 * 1) Menang jika ada peluang, 2) Blokir lawan, 3) Ambil tengah, 4) Sudut, 5) Acak.
 */
function chooseBotMove(board) {
  const empty = [];
  for (let i = 0; i < 9; i++) {
    if (!board[i]) empty.push(i);
  }
  if (empty.length === 0) return -1;

  // 1. Cari langkah menang untuk O
  for (const idx of empty) {
    board[idx] = 'O';
    const win = checkWinner(board) === 'O';
    board[idx] = null;
    if (win) return idx;
  }

  // 2. Blokir langkah menang X
  for (const idx of empty) {
    board[idx] = 'X';
    const danger = checkWinner(board) === 'X';
    board[idx] = null;
    if (danger) return idx;
  }

  // 3. Ambil tengah jika kosong
  if (!board[4]) return 4;

  // 4. Ambil sudut yang kosong
  const corners = [0, 2, 6, 8].filter((i) => !board[i]);
  if (corners.length > 0) {
    return corners[Math.floor(Math.random() * corners.length)];
  }

  // 5. Sisanya acak
  return empty[Math.floor(Math.random() * empty.length)];
}

function removeMatch(match) {
  activeMatches.delete(match.id);
  playerMatchKey.delete(`${match.jid}:${match.playerX}`);
  if (match.playerO && !match.isBotGame) {
    playerMatchKey.delete(`${match.jid}:${match.playerO}`);
  }
}

function getPlayerMatch(jid, sender) {
  const id = playerMatchKey.get(`${jid}:${sender}`);
  return id ? activeMatches.get(id) || null : null;
}

export async function handleXoxCommand(sock, msg, args, prefix = '.') {
  const jid = msg.key.remoteJid;
  const isGroup = jid.endsWith('@g.us');
  const sender = msg.key.participant || msg.key.remoteJid;
  const senderNum = sender.split(':')[0].split('@')[0];
  const senderTag = `@${senderNum}`;
  const sub = (args[0] || '').toLowerCase();

  // ==================== STOP / BATAL ====================
  if (sub === 'stop' || sub === 'keluar' || sub === 'reset') {
    if (isGroup && groupWaiting.get(jid) === sender) {
      groupWaiting.delete(jid);
      await sock.sendMessage(jid, { text: '🛑 Antrean matchmaking XOX Anda dibatalkan.' }, { quoted: msg });
      return;
    }

    const match = getPlayerMatch(jid, sender);
    if (!match) {
      await sock.sendMessage(jid, { text: 'Anda tidak sedang berada di dalam game XOX.' }, { quoted: msg });
      return;
    }

    removeMatch(match);
    await sock.sendMessage(
      jid,
      { text: `🛑 Permainan XOX oleh ${senderTag} telah dihentikan.`, mentions: [sender] },
      { quoted: msg }
    );
    return;
  }

  // ==================== LANGKAH 1..9 ====================
  const num = Number(sub);
  if (Number.isInteger(num) && num >= 1 && num <= 9) {
    const match = getPlayerMatch(jid, sender);
    if (!match) {
      await sock.sendMessage(
        jid,
        { text: `Anda belum berada di pertandingan XOX. Ketik \`${prefix}xox\` untuk mulai!` },
        { quoted: msg }
      );
      return;
    }

    const idx = num - 1;
    if (match.board[idx]) {
      await sock.sendMessage(jid, { text: `Kotak ${num} sudah terisi! Pilih angka lain.` }, { quoted: msg });
      return;
    }

    // ---- MODE DM LAWAN BOT ----
    if (match.isBotGame) {
      match.board[idx] = 'X';
      let result = checkWinner(match.board);

      if (result === 'X') {
        removeMatch(match);
        await sock.sendMessage(
          jid,
          { text: `🏆 *XOX vs BOT — ANDA MENANG!*\n\n${renderBoard(match.board)}\n\nMantap! Ketik \`${prefix}xox\` untuk main lagi.` },
          { quoted: msg }
        );
        return;
      }
      if (result === 'DRAW') {
        removeMatch(match);
        await sock.sendMessage(
          jid,
          { text: `🤝 *XOX vs BOT — SERI!*\n\n${renderBoard(match.board)}\n\nKetik \`${prefix}xox\` untuk tanding ulang.` },
          { quoted: msg }
        );
        return;
      }

      // Giliran Bot (⭕)
      const botMove = chooseBotMove(match.board);
      if (botMove !== -1) {
        match.board[botMove] = 'O';
      }
      result = checkWinner(match.board);

      if (result === 'O') {
        removeMatch(match);
        await sock.sendMessage(
          jid,
          { text: `🤖 *XOX vs BOT — BOT MENANG!*\n\n${renderBoard(match.board)}\n\nBot memilih kotak *${botMove + 1}*.\nKetik \`${prefix}xox\` untuk balas dendam!` },
          { quoted: msg }
        );
        return;
      }
      if (result === 'DRAW') {
        removeMatch(match);
        await sock.sendMessage(
          jid,
          { text: `🤝 *XOX vs BOT — SERI!*\n\n${renderBoard(match.board)}\n\nKetik \`${prefix}xox\` untuk main lagi.` },
          { quoted: msg }
        );
        return;
      }

      await sock.sendMessage(
        jid,
        {
          text:
            `🎮 *XOX vs BOT*\n` +
            `Anda memilih *${num}* • Bot memilih *${botMove + 1}*\n\n` +
            `${renderBoard(match.board)}\n\n` +
            `Giliran Anda (❌)! Ketik \`${prefix}xox 1\`..\`9\``,
        },
        { quoted: msg }
      );
      return;
    }

    // ---- MODE GRUP BY-ONE (PVP) ----
    const expectedPlayer = match.turn === 'X' ? match.playerX : match.playerO;
    if (sender !== expectedPlayer) {
      const expNum = expectedPlayer.split(':')[0].split('@')[0];
      await sock.sendMessage(
        jid,
        {
          text: `⏳ Sekarang giliran @${expNum} (${match.turn === 'X' ? '❌' : '⭕'}).`,
          mentions: [expectedPlayer],
        },
        { quoted: msg }
      );
      return;
    }

    match.board[idx] = match.turn;
    const winner = checkWinner(match.board);

    if (winner === 'X' || winner === 'O') {
      const winnerJid = winner === 'X' ? match.playerX : match.playerO;
      const winNum = winnerJid.split(':')[0].split('@')[0];
      removeMatch(match);
      await sock.sendMessage(
        jid,
        {
          text:
            `🏆 *XOX BY-ONE SELESAI!*\n\n` +
            `${renderBoard(match.board)}\n\n` +
            `Selamat ${winner === 'X' ? '❌' : '⭕'} @${winNum} menang!`,
          mentions: [winnerJid],
        },
        { quoted: msg }
      );
      return;
    }

    if (winner === 'DRAW') {
      removeMatch(match);
      await sock.sendMessage(
        jid,
        { text: `🤝 *XOX BY-ONE SERI!*\n\n${renderBoard(match.board)}\n\nKetik \`${prefix}xox\` untuk cari lawan lagi!` },
        { quoted: msg }
      );
      return;
    }

    match.turn = match.turn === 'X' ? 'O' : 'X';
    const nextPlayer = match.turn === 'X' ? match.playerX : match.playerO;
    const nextNum = nextPlayer.split(':')[0].split('@')[0];

    await sock.sendMessage(
      jid,
      {
        text:
          `🎮 *XOX BY-ONE*\n\n` +
          `${renderBoard(match.board)}\n\n` +
          `Giliran: ${match.turn === 'X' ? '❌' : '⭕'} @${nextNum}`,
        mentions: [nextPlayer],
      },
      { quoted: msg }
    );
    return;
  }

  // ==================== MULAI / MATCHMAKING (.xox atau .xox join) ====================
  if (!sub || sub === 'start' || sub === 'join') {
    // Jika pemain sudah sedang bertanding
    const ongoing = getPlayerMatch(jid, sender);
    if (ongoing) {
      await sock.sendMessage(
        jid,
        {
          text:
            `🎮 Anda masih memiliki game XOX aktif!\n\n` +
            `${renderBoard(ongoing.board)}\n\n` +
            `Ketik \`${prefix}xox 1\`..\`9\` untuk melangkah atau \`${prefix}xox stop\` untuk berhenti.`,
        },
        { quoted: msg }
      );
      return;
    }

    // 1. CHAT PRIBADI -> LANGSUNG MAIN LAWAN BOT
    if (!isGroup) {
      const id = `m_${matchSeq++}`;
      const match = {
        id,
        jid,
        isBotGame: true,
        playerX: sender,
        playerO: 'BOT',
        board: Array(9).fill(null),
        turn: 'X',
      };
      activeMatches.set(id, match);
      playerMatchKey.set(`${jid}:${sender}`, id);

      await sock.sendMessage(
        jid,
        {
          text:
            `🤖 *XOX vs BOT DIMULAI!*\n` +
            `Anda: ❌  •  Bot: ⭕\n\n` +
            `${renderBoard(match.board)}\n\n` +
            `Giliran Anda duluan! Ketik \`${prefix}xox 1\` sampai \`${prefix}xox 9\`\n` +
            `_(Command bot lain tetap bisa dipakai seperti biasa)_`,
        },
        { quoted: msg }
      );
      return;
    }

    // 2. GRUP -> AUTO MATCHMAKING BY-ONE
    const waitingPlayer = groupWaiting.get(jid);

    if (waitingPlayer === sender) {
      await sock.sendMessage(
        jid,
        {
          text: `⏳ Anda masih di antrean matchmaking XOX. Tunggu anggota lain mengetik \`${prefix}xox\` atau ketik \`${prefix}xox stop\` untuk batal.`,
        },
        { quoted: msg }
      );
      return;
    }

    // Ada pemain lain yang menunggu -> LANGSUNG MATCHMAKING BY-ONE!
    if (waitingPlayer) {
      groupWaiting.delete(jid);
      const id = `m_${matchSeq++}`;
      const match = {
        id,
        jid,
        isBotGame: false,
        playerX: waitingPlayer,
        playerO: sender,
        board: Array(9).fill(null),
        turn: 'X',
      };
      activeMatches.set(id, match);
      playerMatchKey.set(`${jid}:${waitingPlayer}`, id);
      playerMatchKey.set(`${jid}:${sender}`, id);

      const p1Num = waitingPlayer.split(':')[0].split('@')[0];
      await sock.sendMessage(
        jid,
        {
          text:
            `⚔️ *MATCH FOUND — XOX BY-ONE!*\n` +
            `❌ @${p1Num} vs ⭕ ${senderTag}\n\n` +
            `${renderBoard(match.board)}\n\n` +
            `Giliran pertama: ❌ @${p1Num}\n` +
            `Ketik \`${prefix}xox 1\` sampai \`${prefix}xox 9\``,
          mentions: [waitingPlayer, sender],
        },
        { quoted: msg }
      );
      return;
    }

    // Belum ada yang menunggu -> masuk antrean matchmaking
    groupWaiting.set(jid, sender);
    await sock.sendMessage(
      jid,
      {
        text:
          `🎮 *MATCHMAKING XOX (GRUP)*\n` +
          `• Menunggu lawan untuk: ❌ ${senderTag}\n\n` +
          `Siapa saja di grup ini cukup ketik \`${prefix}xox\` untuk langsung tanding *by-one*!\n` +
          `_(Command lain tetap bisa dijalankan seperti biasa)_`,
        mentions: [sender],
      },
      { quoted: msg }
    );
    return;
  }

  await sock.sendMessage(
    jid,
    {
      text:
        `🎮 *Panduan XOX:*\n` +
        `• Chat pribadi: \`${prefix}xox\` langsung main lawan Bot\n` +
        `• Grup: \`${prefix}xox\` otomatis matchmaking by-one\n` +
        `• Pilih kotak: \`${prefix}xox 1\`..\`9\`\n` +
        `• Berhenti: \`${prefix}xox stop\``,
    },
    { quoted: msg }
  );
}
