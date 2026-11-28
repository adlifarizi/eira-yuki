export interface AudioStickerResult {
  sticker: Buffer;
  audio?: Buffer;
  seconds: number;
}

export interface OpusAudioResult {
  audio: Buffer;
  seconds: number;
}

/**
 * Abstraction for converting raw image, video, or audio buffers into WhatsApp-compatible sticker assets.
 */
export interface StickerConverter {
  imageToSticker(buffer: Buffer): Promise<Buffer>;
  videoToSticker(buffer: Buffer): Promise<Buffer>;
  audioToOpus?(buffer: Buffer): Promise<OpusAudioResult>;
  videoToAudioSticker?(buffer: Buffer): Promise<AudioStickerResult>;
}
