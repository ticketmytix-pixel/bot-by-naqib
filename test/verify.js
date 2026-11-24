import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { proto, generateWAMessageFromContent } from '@whiskeysockets/baileys';

import { patchAudioStickerProto } from '../src/patchProto.js';
import {
  imageToStickerWebp,
  videoToStickerWebp,
  hasAudioStream,
  extractAudioToOggOpus,
} from '../src/media.js';

const execFileAsync = promisify(execFile);

async function testProtoPatch() {
  console.log('1. Testing WAProto StickerMessage.audioMessage (field 26) patch...');
  patchAudioStickerProto();

  const sampleMediaKey = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const sampleAudioKey = new Uint8Array([9, 10, 11, 12, 13, 14, 15, 16]);

  const inputObj = {
    stickerMessage: {
      url: 'https://mmg.whatsapp.net/v/t62.15575-24/sticker.enc',
      mimetype: 'image/webp',
      width: 512,
      height: 512,
      isAnimated: true,
      mediaKey: sampleMediaKey,
      emojis: '🔊',
      audioMessage: {
        url: 'https://mmg.whatsapp.net/v/t62.7114-24/audio.enc',
        mimetype: 'audio/ogg; codecs=opus',
        seconds: 3,
        ptt: false,
        mediaKey: sampleAudioKey,
        directPath: '/v/t62.7114-24/audio.enc',
      },
    },
  };

  // Uji lewat generateWAMessageFromContent (jalur yang sama persis dengan sendAudioSticker)
  const waMsg = generateWAMessageFromContent('6281234567890@s.whatsapp.net', inputObj, {
    userJid: '6289999999999@s.whatsapp.net',
  });

  const encoded = proto.Message.encode(waMsg.message).finish();
  assert.ok(encoded.length > 0, 'Encoded protobuf harus tidak kosong');

  const decoded = proto.Message.decode(encoded);
  assert.equal(decoded.stickerMessage.mimetype, 'image/webp');
  assert.equal(decoded.stickerMessage.isAnimated, true);
  assert.equal(decoded.stickerMessage.emojis, '🔊');
  assert.ok(decoded.stickerMessage.audioMessage, 'audioMessage (field 26) harus ter-decode');
  assert.equal(decoded.stickerMessage.audioMessage.mimetype, 'audio/ogg; codecs=opus');
  assert.equal(decoded.stickerMessage.audioMessage.seconds, 3);
  assert.equal(decoded.stickerMessage.audioMessage.directPath, '/v/t62.7114-24/audio.enc');
  assert.deepEqual(
    Buffer.from(decoded.stickerMessage.audioMessage.mediaKey),
    Buffer.from(sampleAudioKey)
  );

  console.log('   ✅ Protobuf field 26 encode/decode lossless!');
}

async function testMediaPipeline() {
  console.log('2. Testing FFmpeg Video -> Animated WebP + OGG Opus pipeline...');
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-test-'));

  try {
    const mp4Path = path.join(tmpDir, 'sample.mp4');
    const pngPath = path.join(tmpDir, 'sample.png');

    // Buat video test 3 detik dengan audio sine 440Hz
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x320:rate=15',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-shortest',
      mp4Path,
    ]);

    // Buat gambar PNG test
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'color=c=blue:s=300x200:d=1',
      '-frames:v', '1',
      pngPath,
    ]);

    const videoBuf = await fs.readFile(mp4Path);
    const pngBuf = await fs.readFile(pngPath);

    // Cek deteksi audio stream
    assert.equal(await hasAudioStream(videoBuf), true, 'Video test harus terdeteksi punya audio');

    // Konversi video -> animated WebP dengan EXIF
    const animWebp = await videoToStickerWebp(videoBuf, {
      maxSeconds: 5,
      packname: 'Test Pack',
      author: 'Test Author',
    });
    assert.equal(animWebp.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(animWebp.subarray(8, 12).toString('ascii'), 'WEBP');
    assert.ok(animWebp.includes(Buffer.from('Test Pack')), 'EXIF packname harus tertanam di WebP');
    assert.ok(animWebp.length <= 500 * 1024, `Animated WebP (${animWebp.length} B) harus <= 500 KB`);
    console.log(`   ✅ Animated WebP OK (${(animWebp.length / 1024).toFixed(1)} KB, EXIF valid)`);

    // Ekstrak audio -> OGG Opus
    const audioRes = await extractAudioToOggOpus(videoBuf, { maxSeconds: 5 });
    assert.equal(audioRes.buffer.subarray(0, 4).toString('ascii'), 'OggS', 'Audio harus valid OGG');
    assert.equal(audioRes.seconds, 3, 'Durasi audio harus 3 detik');
    console.log(`   ✅ OGG Opus Audio OK (${(audioRes.buffer.length / 1024).toFixed(1)} KB, ${audioRes.seconds}s)`);

    // Konversi gambar -> static WebP dengan EXIF
    const staticWebp = await imageToStickerWebp(pngBuf, {
      packname: 'Test Pack',
      author: 'Test Author',
    });
    assert.equal(staticWebp.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(staticWebp.subarray(8, 12).toString('ascii'), 'WEBP');
    assert.ok(staticWebp.includes(Buffer.from('Test Author')), 'EXIF author harus tertanam di WebP');
    console.log(`   ✅ Static WebP OK (${(staticWebp.length / 1024).toFixed(1)} KB, EXIF valid)`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

await testProtoPatch();
await testMediaPipeline();
console.log('\n🎉 Semua verifikasi lulus!');
