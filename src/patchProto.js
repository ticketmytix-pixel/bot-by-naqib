import { proto } from '@whiskeysockets/baileys';
import $protobuf from 'protobufjs/minimal.js';

const { Reader, Writer } = $protobuf;

/**
 * Patch runtime untuk WAProto StickerMessage agar mendukung fitur Sound Sticker
 * (WhatsApp update terbaru: field 24 premium, field 25 emojis, field 26 audioMessage).
 *
 * Aman dan idempoten: jika versi Baileys di masa depan sudah mendukung field 26
 * secara native, patch otomatis dilewati.
 */
export function patchAudioStickerProto() {
  const StickerMessage = proto?.Message?.StickerMessage;
  const AudioMessage = proto?.Message?.AudioMessage;

  if (!StickerMessage || !AudioMessage) {
    throw new Error('WAProto StickerMessage atau AudioMessage tidak ditemukan di @whiskeysockets/baileys');
  }

  // Skip jika sudah dipatch atau sudah didukung native oleh Baileys
  if (
    StickerMessage.__audioStickerPatched ||
    StickerMessage.encode.toString().includes('audioMessage')
  ) {
    return false;
  }

  const origEncode = StickerMessage.encode.bind(StickerMessage);
  const origDecode = StickerMessage.decode.bind(StickerMessage);
  const origFromObject = StickerMessage.fromObject.bind(StickerMessage);
  const origToObject = StickerMessage.toObject.bind(StickerMessage);

  StickerMessage.encode = function encode(message, writer) {
    if (!writer) writer = Writer.create();
    origEncode(message, writer);

    if (message.premium != null && Object.prototype.hasOwnProperty.call(message, 'premium')) {
      // field 24, wire type 0 (varint): (24 << 3) | 0 = 192
      writer.uint32(192).int32(message.premium);
    }
    if (message.emojis != null && Object.prototype.hasOwnProperty.call(message, 'emojis')) {
      // field 25, wire type 2 (length-delimited): (25 << 3) | 2 = 202
      writer.uint32(202).string(message.emojis);
    }
    if (message.audioMessage != null && Object.prototype.hasOwnProperty.call(message, 'audioMessage')) {
      // field 26, wire type 2 (length-delimited): (26 << 3) | 2 = 210
      AudioMessage.encode(message.audioMessage, writer.uint32(210).fork()).ldelim();
    }

    return writer;
  };

  StickerMessage.decode = function decode(reader, length) {
    const r = reader instanceof Reader ? reader : Reader.create(reader);
    const startPos = r.pos;
    const message = origDecode(r, length);
    const endPos = r.pos;

    // Scan ulang rentang byte yang baru didecode untuk membaca field 24, 25, 26
    const scan = Reader.create(r.buf);
    scan.pos = startPos;
    while (scan.pos < endPos) {
      const tag = scan.uint32();
      const fieldNo = tag >>> 3;
      const wireType = tag & 7;
      if (fieldNo === 24 && wireType === 0) {
        message.premium = scan.int32();
      } else if (fieldNo === 25 && wireType === 2) {
        message.emojis = scan.string();
      } else if (fieldNo === 26 && wireType === 2) {
        message.audioMessage = AudioMessage.decode(scan, scan.uint32());
      } else {
        scan.skipType(wireType);
      }
    }

    return message;
  };

  StickerMessage.fromObject = function fromObject(object) {
    const message = origFromObject(object);
    if (object && typeof object === 'object') {
      if (object.premium != null) {
        message.premium = object.premium | 0;
      }
      if (object.emojis != null) {
        message.emojis = String(object.emojis);
      }
      if (object.audioMessage != null) {
        if (typeof object.audioMessage !== 'object') {
          throw TypeError('.proto.Message.StickerMessage.audioMessage: object expected');
        }
        message.audioMessage = AudioMessage.fromObject(object.audioMessage);
      }
    }
    return message;
  };

  StickerMessage.toObject = function toObject(message, options) {
    const object = origToObject(message, options);
    if (message.premium != null && Object.prototype.hasOwnProperty.call(message, 'premium')) {
      object.premium = message.premium;
    }
    if (message.emojis != null && Object.prototype.hasOwnProperty.call(message, 'emojis')) {
      object.emojis = message.emojis;
    }
    if (message.audioMessage != null && Object.prototype.hasOwnProperty.call(message, 'audioMessage')) {
      object.audioMessage = AudioMessage.toObject(message.audioMessage, options);
    }
    return object;
  };

  if (typeof StickerMessage.verify === 'function') {
    const origVerify = StickerMessage.verify.bind(StickerMessage);
    StickerMessage.verify = function verify(message) {
      const err = origVerify(message);
      if (err) return err;
      if (message.audioMessage != null && Object.prototype.hasOwnProperty.call(message, 'audioMessage')) {
        const audioErr = AudioMessage.verify(message.audioMessage);
        if (audioErr) return 'audioMessage.' + audioErr;
      }
      return null;
    };
  }

  StickerMessage.__audioStickerPatched = true;
  return true;
}
