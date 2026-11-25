import { getGroupSettings } from '../store.js';

const MAX_CACHE_PER_BOT = 1500;

function bareId(jid) {
  if (!jid) return '';
  return String(jid).split(':')[0].split('@')[0];
}

function getParticipantIds(p) {
  const ids = new Set();
  if (!p) return ids;
  if (p.id) ids.add(bareId(p.id));
  if (p.lid) ids.add(bareId(p.lid));
  if (p.phoneNumber) ids.add(bareId(p.phoneNumber));
  if (p.jid) ids.add(bareId(p.jid));
  return ids;
}

function extractTextFromMsg(m) {
  if (!m) return '';
  const inner =
    m.ephemeralMessage?.message ||
    m.viewOnceMessage?.message ||
    m.viewOnceMessageV2?.message ||
    m.documentWithCaptionMessage?.message ||
    m;
  return (
    inner.conversation ||
    inner.extendedTextMessage?.text ||
    inner.imageMessage?.caption ||
    inner.videoMessage?.caption ||
    ''
  ).trim();
}

function isRevokeType(type) {
  return type === 0 || type === 'REVOKE';
}

function isEditType(type) {
  return type === 14 || type === 'MESSAGE_EDIT';
}

/**
 * Proteksi Grup: Anti-Delete, Anti-Edit (mendukung messages.upsert & messages.update),
 * dan Anti-Kudeta (mendukung JID @s.whatsapp.net maupun @lid di Baileys v7).
 */
export class GroupGuard {
  constructor() {
    this.msgCache = new Map();
    this.demoteTracker = new Map();
  }

  cacheMessage(msg, text) {
    const id = msg?.key?.id;
    const jid = msg?.key?.remoteJid;
    if (!id || !jid || !jid.endsWith('@g.us')) return;

    if (this.msgCache.size >= MAX_CACHE_PER_BOT) {
      const oldestKey = this.msgCache.keys().next().value;
      this.msgCache.delete(oldestKey);
    }

    const sender = msg.key.participant || msg.key.remoteJid;
    const m = msg.message || {};
    let mediaLabel = '';
    if (m.imageMessage) mediaLabel = '[Gambar]';
    else if (m.videoMessage) mediaLabel = '[Video]';
    else if (m.audioMessage) mediaLabel = '[Audio/VN]';
    else if (m.stickerMessage) mediaLabel = '[Stiker]';
    else if (m.documentMessage) mediaLabel = '[Dokumen]';

    this.msgCache.set(`${jid}:${id}`, {
      sender,
      pushName: msg.pushName || bareId(sender),
      text: text || '',
      mediaLabel,
      timestamp: Date.now(),
    });
  }

  async notifyEdit(sock, jid, editedId, newText, actor) {
    if (!newText) return;
    const cached = editedId ? this.msgCache.get(`${jid}:${editedId}`) : null;
    const senderJid = cached?.sender || actor || '';
    const senderTag = senderJid ? `@${bareId(senderJid)}` : 'Seseorang';

    if (cached && cached.text === newText) return; // Tidak ada perubahan teks

    const oldText = cached?.text || '_(pesan dikirim sebelum bot aktif)_';
    await sock.sendMessage(jid, {
      text:
        `✏️ *ANTI-EDIT AKTIF*\n` +
        `• Pengirim: ${senderTag}\n` +
        `• Teks asli:\n${oldText}\n\n` +
        `• Diubah menjadi:\n${newText}`,
      mentions: [senderJid, actor].filter(Boolean),
    });

    if (cached) {
      cached.text = newText;
    } else if (editedId) {
      this.msgCache.set(`${jid}:${editedId}`, {
        sender: senderJid,
        text: newText,
        mediaLabel: '',
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Deteksi pesan dihapus (REVOKE) & pesan diedit (MESSAGE_EDIT) dari event `messages.upsert`.
   */
  async handleProtocolEvent(sock, msg, unwrapped) {
    const jid = msg?.key?.remoteJid;
    if (!jid || !jid.endsWith('@g.us')) return false;

    const protoMsg =
      unwrapped?.protocolMessage ||
      unwrapped?.editedMessage?.message?.protocolMessage ||
      msg?.message?.editedMessage?.message?.protocolMessage ||
      msg?.message?.protocolMessage;

    if (!protoMsg) return false;

    const settings = await getGroupSettings(jid);

    // 1. ANTI-DELETE
    if (isRevokeType(protoMsg.type) && settings.antidelete) {
      const deletedId = protoMsg.key?.id;
      const cached = deletedId ? this.msgCache.get(`${jid}:${deletedId}`) : null;
      const actor = msg.key.participant || protoMsg.key?.participant || '';
      const actorTag = actor ? `@${bareId(actor)}` : 'Seseorang';

      if (cached) {
        const content = [cached.mediaLabel, cached.text].filter(Boolean).join(' ') || '(pesan kosong)';
        await sock.sendMessage(jid, {
          text:
            `🛡️ *ANTI-DELETE AKTIF*\n` +
            `• Pengirim: @${bareId(cached.sender)}\n` +
            `• Dihapus oleh: ${actorTag}\n` +
            `• Isi pesan:\n${content}`,
          mentions: [cached.sender, actor].filter(Boolean),
        });
      }
      return true;
    }

    // 2. ANTI-EDIT
    if (isEditType(protoMsg.type) && settings.antiedit) {
      const editedId = protoMsg.key?.id;
      const newText = extractTextFromMsg(protoMsg.editedMessage);
      const actor = msg.key.participant || protoMsg.key?.participant || '';
      await this.notifyEdit(sock, jid, editedId, newText, actor);
      return true;
    }

    return false;
  }

  /**
   * Deteksi pesan diedit dari event `messages.update` (penting di Baileys v7!).
   */
  async handleMessagesUpdate(sock, updates) {
    if (!Array.isArray(updates)) return;
    for (const item of updates) {
      try {
        const jid = item?.key?.remoteJid;
        if (!jid || !jid.endsWith('@g.us')) continue;

        const msgUpdate = item?.update?.message;
        if (!msgUpdate) continue;

        const protoMsg =
          msgUpdate?.editedMessage?.message?.protocolMessage ||
          msgUpdate?.protocolMessage;

        if (!protoMsg || !isEditType(protoMsg.type)) continue;

        const settings = await getGroupSettings(jid);
        if (!settings.antiedit) continue;

        const editedId = protoMsg.key?.id || item.key?.id;
        const newText = extractTextFromMsg(protoMsg.editedMessage);
        const actor = item.key?.participant || protoMsg.key?.participant || '';
        await this.notifyEdit(sock, jid, editedId, newText, actor);
      } catch (err) {
        console.error('[ANTI-EDIT UPDATE ERROR]', err?.message || err);
      }
    }
  }

  /**
   * ANTI-KUDETA PENUH (mendukung JID @lid dan @s.whatsapp.net di Baileys v7):
   * 1. Admin di-demote -> demote pelaku + promote kembali admin korban.
   * 2. Anggota di-kick -> demote pelaku + masukkan kembali anggota korban (fallback: kirim link undangan ke DM korban).
   * 3. Bot sendiri kena demote -> kirim Alert Darurat + Call Link ke DM Pemilik Asli Grup & mention di grup.
   */
  async handleParticipantsUpdate(sock, update) {
    const { id: groupJid, participants = [], action, author } = update;
    if (!groupJid || !groupJid.endsWith('@g.us')) return;
    if (!['demote', 'remove'].includes(action)) return;

    const settings = await getGroupSettings(groupJid);
    if (!settings.antikudeta) return;

    const botIds = new Set([bareId(sock.user?.id), bareId(sock.user?.lid)].filter(Boolean));
    const actor = author || '';
    const actorBare = bareId(actor);

    // Abaikan jika aksi dilakukan oleh bot sendiri
    if (!actor || botIds.has(actorBare)) return;

    try {
      const meta = await sock.groupMetadata(groupJid);
      const groupName = meta.subject || groupJid;

      // Kumpulkan semua kemungkinan ID pemilik grup (owner, ownerPn, ownerLid, superadmin)
      const ownerIds = new Set([
        bareId(meta.owner),
        bareId(meta.ownerPn),
        bareId(meta.ownerLid),
      ].filter(Boolean));

      let ownerContactJid = meta.ownerPn || meta.owner || '';
      for (const p of meta.participants || []) {
        if (p.admin === 'superadmin') {
          for (const id of getParticipantIds(p)) ownerIds.add(id);
          if (!ownerContactJid) ownerContactJid = p.phoneNumber || p.id;
        }
      }

      // Pemilik asli / superadmin grup bebas mengatur grup
      if (ownerIds.has(actorBare)) return;

      // Cari JID pelaku yang tepat di daftar participants (mendukung @lid & @s.whatsapp.net)
      const actorEntry = (meta.participants || []).find((p) => getParticipantIds(p).has(actorBare));
      const targetDemoteJid = actorEntry?.id || actor;

      // Filter korban (bukan pelaku sendiri)
      const victims = participants.filter((p) => {
        const b = bareId(typeof p === 'string' ? p : p?.id);
        return b && b !== actorBare;
      }).map((p) => (typeof p === 'string' ? p : p.id));

      // ==================== KASUS 1: BOT SENDIRI KENA DEMOTE ====================
      const botWasDemoted =
        action === 'demote' && victims.some((v) => botIds.has(bareId(v)));

      if (botWasDemoted) {
        let callLinkLine = '';
        if (typeof sock.createCallLink === 'function') {
          try {
            const token = await sock.createCallLink('audio');
            if (token) callLinkLine = `\n📞 Call Link Darurat: https://call.whatsapp.com/voice/${token}`;
          } catch {
            // Abaikan jika createCallLink tidak tersedia
          }
        }

        const alertText =
          `🚨 *DARURAT ANTI-KUDETA — BOT DICOPOT DARI ADMIN!*\n` +
          `• Grup: *${groupName}*\n` +
          `• Pelaku: @${actorBare}\n` +
          `• Status: Bot tidak bisa membalas demote karena hak admin bot dicabut.\n` +
          `Segera cek grup dan jadikan bot admin kembali!${callLinkLine}`;

        if (ownerContactJid) {
          try {
            await sock.sendMessage(ownerContactJid, {
              text: alertText,
              mentions: [targetDemoteJid],
            });
          } catch (dmErr) {
            console.error('[ANTI-KUDETA OWNER DM ERROR]', dmErr?.message || dmErr);
          }
        }

        await sock.sendMessage(groupJid, {
          text:
            `🚨 *ANTI-KUDETA: BOT KENA DEMOTE!*\n` +
            `• Pelaku: @${actorBare}\n` +
            `• Pemilik grup ${ownerContactJid ? `@${bareId(ownerContactJid)}` : ''} telah diberi peringatan darurat!`,
          mentions: [targetDemoteJid, ownerContactJid].filter(Boolean),
        });
        return;
      }

      // ==================== KASUS 2: ADMIN DI-DEMOTE -> DEMOTE PELAKU + PROMOTE KORBAN ====================
      if (action === 'demote') {
        const actionsLog = [];

        try {
          await sock.groupParticipantsUpdate(groupJid, [targetDemoteJid], 'demote');
          actionsLog.push(`• Pelaku @${actorBare} dicopot dari admin ✅`);
        } catch {
          actionsLog.push(`• Gagal mencopot pelaku @${actorBare} (pastikan bot adalah admin)`);
        }

        const restoreVictims = victims.filter((v) => !botIds.has(bareId(v)));
        if (restoreVictims.length > 0) {
          try {
            await sock.groupParticipantsUpdate(groupJid, restoreVictims, 'promote');
            const tags = restoreVictims.map((v) => `@${bareId(v)}`).join(', ');
            actionsLog.push(`• Admin korban (${tags}) diangkat kembali jadi admin ✅`);
          } catch {
            actionsLog.push('• Gagal mengangkat kembali admin korban');
          }
        }

        await sock.sendMessage(groupJid, {
          text: `🚨 *ANTI-KUDETA TERPICU (DEMOTE)!*\n${actionsLog.join('\n')}`,
          mentions: [targetDemoteJid, ...restoreVictims],
        });
        return;
      }

      // ==================== KASUS 3: ANGGOTA DI-KICK -> DEMOTE PELAKU + MASUKKAN KORBAN KEMBALI ====================
      if (action === 'remove') {
        // Jika korban keluar sendiri (actor === victim), abaikan!
        const kickedVictims = victims.filter((v) => !botIds.has(bareId(v)));
        if (kickedVictims.length === 0) return;

        const actionsLog = [];

        try {
          await sock.groupParticipantsUpdate(groupJid, [targetDemoteJid], 'demote');
          actionsLog.push(`• Admin pelaku kick (@${actorBare}) dicopot dari admin ✅`);
        } catch {
          actionsLog.push(`• Gagal mencopot pelaku @${actorBare} (pastikan bot adalah admin)`);
        }

        try {
          await sock.groupParticipantsUpdate(groupJid, kickedVictims, 'add');
          const tags = kickedVictims.map((v) => `@${bareId(v)}`).join(', ');
          actionsLog.push(`• Anggota yang di-kick (${tags}) dimasukkan kembali ke grup ✅`);
        } catch {
          // Fallback jika pengaturan privasi korban menolak auto-add: kirim link undangan grup ke DM korban
          let inviteSent = false;
          try {
            const code = await sock.groupInviteCode(groupJid);
            if (code) {
              const inviteUrl = `https://chat.whatsapp.com/${code}`;
              for (const v of kickedVictims) {
                await sock.sendMessage(v, {
                  text: `🛡️ Anda baru saja dikeluarkan secara tidak sah dari grup *${groupName}*.\nSilakan masuk kembali lewat link ini:\n${inviteUrl}`,
                });
              }
              inviteSent = true;
            }
          } catch {
            // Abaikan
          }
          actionsLog.push(
            inviteSent
              ? '• Privasi korban membatasi auto-add → link undangan sudah dikirim ke DM korban ✅'
              : '• Gagal memasukkan kembali korban (privasi WA korban membatasi auto-add)'
          );
        }

        await sock.sendMessage(groupJid, {
          text: `🚨 *ANTI-KUDETA TERPICU (KICK ANGGOTA)!*\n${actionsLog.join('\n')}`,
          mentions: [targetDemoteJid, ...kickedVictims],
        });
      }
    } catch (err) {
      console.error('[ANTI-KUDETA ERROR]', err?.message || err);
    }
  }
}
