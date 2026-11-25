/**
 * Mengirim pesan link Spotify Live / XOX Live dalam format teks standar WhatsApp.
 * 100% pasti muncul di semua perangkat (Android, iOS, Web, self-chat, maupun grup)
 * tanpa risiko blank atau di-drop oleh filter interactiveMessage / externalAdReply.
 */
export async function sendWebviewCard(sock, jid, {
  title,
  subtitle,
  body,
  url,
  quoted,
}) {
  const lines = [
    `*${title}*`,
    subtitle ? `_${subtitle}_` : '',
    '',
    body,
    '',
    `🔗 ${url}`,
  ].filter((line, idx, arr) => !(line === '' && arr[idx - 1] === ''));

  await sock.sendMessage(
    jid,
    { text: lines.join('\n') },
    { quoted }
  );
}
