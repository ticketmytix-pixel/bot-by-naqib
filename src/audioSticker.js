import {
  prepareWAMessageMedia,
  generateWAMessageFromContent,
} from '@whiskeysockets/baileys';

/**
 * Mengirim Sound Sticker (StickerMessage dengan audioMessage pada protobuf field 26)
 * sesuai format update terbaru WhatsApp.
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} jid - Target chat JID
 * @param {object} params
 * @param {Buffer} params.webpBuffer - Buffer stiker WebP 512x512 (dengan EXIF)
 * @param {Buffer} params.audioBuffer - Buffer audio OGG Opus
 * @param {number} params.seconds - Durasi audio dalam detik (1..10)
 * @param {boolean} [params.isAnimated=false] - True jika stiker animasi
 * @param {object} [params.quoted] - Pesan yang di-quote/reply
 */
export async function sendAudioSticker(sock, jid, {
  webpBuffer,
  audioBuffer,
  seconds = 3,
  isAnimated = false,
  quoted,
}) {
  // 1. Upload WebP sticker ke server media WhatsApp (WhatsApp Image Keys)
  const stickerMedia = await prepareWAMessageMedia(
    { sticker: webpBuffer, isAnimated },
    { upload: sock.waUploadToServer }
  );

  // 2. Upload OGG Opus audio ke server media WhatsApp (WhatsApp Audio Keys)
  const audioMedia = await prepareWAMessageMedia(
    {
      audio: audioBuffer,
      mimetype: 'audio/ogg; codecs=opus',
      ptt: false,
    },
    { upload: sock.waUploadToServer }
  );

  if (!stickerMedia?.stickerMessage || !audioMedia?.audioMessage) {
    throw new Error('Gagal mengunggah media stiker atau audio ke server WhatsApp');
  }

  audioMedia.audioMessage.seconds = seconds;
  audioMedia.audioMessage.ptt = false;

  // 3. Gabungkan audioMessage ke dalam StickerMessage (field 26)
  const stickerMessage = {
    ...stickerMedia.stickerMessage,
    width: 512,
    height: 512,
    isAnimated: Boolean(isAnimated),
    stickerSentTs: Date.now(),
    audioMessage: audioMedia.audioMessage,
  };

  // 4. Bungkus menjadi WAMessage (mendukung quote reply seperti di screenshot)
  const waMessage = generateWAMessageFromContent(
    jid,
    { stickerMessage },
    {
      quoted,
      userJid: sock.user?.id,
    }
  );

  // 5. Kirim lewat relayMessage agar protobuf field 26 ter-encode oleh patchProto
  await sock.relayMessage(jid, waMessage.message, {
    messageId: waMessage.key.id,
  });

  return waMessage;
}
