import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import ffmpeg from 'fluent-ffmpeg';
import sharp from 'sharp';
import { Logger } from 'pino';
import {
  AudioStickerResult,
  OpusAudioResult,
  StickerConverter,
} from '../adapters/whatsapp/commands/types';

const MAX_STICKER_BYTES = 1024 * 1024;
const MAX_AUDIO_STICKER_BYTES = 500 * 1024;
const MAX_VIDEO_DURATION_SECONDS = 6;
const MAX_AUDIO_VIDEO_DURATION_SECONDS = 8;
const VIDEO_COMPRESSION_TIERS = [
  { quality: 40, fps: 12 },
  { quality: 20, fps: 10 },
  { quality: 15, fps: 8 },
] as const;

interface MediaProbeInfo {
  duration: number;
  hasAudio: boolean;
}

function probeMedia(filePath: string): Promise<MediaProbeInfo> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      const duration = metadata.format.duration ?? 8;
      const hasAudio = (metadata.streams ?? []).some((s) => s.codec_type === 'audio');
      resolve({ duration, hasAudio });
    });
  });
}

/**
 * Converts an image buffer into a 512x512 transparent-padded WebP sticker buffer.
 */
export async function imageToSticker(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .resize(512, 512, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .webp()
    .toBuffer();
}

/**
 * Converts a video/GIF buffer into an animated WebP sticker buffer (max 6s).
 * Steps down quality/FPS progressively until the output fits within `maxBytes`.
 */
export async function videoToSticker(
  buffer: Buffer,
  logger?: Logger,
  maxBytes: number = MAX_STICKER_BYTES
): Promise<Buffer> {
  const tempDir = path.join(process.cwd(), 'storage', 'temp');
  fs.mkdirSync(tempDir, { recursive: true });

  const fileId = `${Date.now()}_${crypto.randomUUID()}`;
  const inputPath = path.join(tempDir, `${fileId}_in.mp4`);
  const outputPath = path.join(tempDir, `${fileId}_out.webp`);

  await fsPromises.writeFile(inputPath, buffer);

  try {
    const { duration } = await probeMedia(inputPath);
    const maxDuration = Math.min(duration, MAX_VIDEO_DURATION_SECONDS);

    const convert = (quality: number, fps: number): Promise<Buffer> =>
      new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .inputOptions(['-t', `${maxDuration}`])
          .videoFilters([
            'scale=512:512:force_original_aspect_ratio=decrease',
            `fps=${fps}`,
            'pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0',
            'format=rgba',
          ])
          .outputOptions([
            '-y',
            '-lossless',
            '0',
            '-quality',
            `${quality}`,
            '-compression_level',
            '6',
            '-loop',
            '0',
            '-an',
          ])
          .toFormat('webp')
          .save(outputPath)
          .on('end', async () => {
            try {
              const outBuffer = await fsPromises.readFile(outputPath);
              resolve(outBuffer);
            } catch (error) {
              reject(error);
            }
          })
          .on('error', (err) => {
            reject(err);
          });
      });

    let outBuffer: Buffer | undefined;
    for (const tier of VIDEO_COMPRESSION_TIERS) {
      outBuffer = await convert(tier.quality, tier.fps);
      if (outBuffer.length <= maxBytes) {
        break;
      }
      logger?.debug(
        { size: outBuffer.length, maxBytes, quality: tier.quality, fps: tier.fps },
        'Animated sticker exceeds target size, trying lower tier'
      );
    }

    return outBuffer!;
  } catch (err) {
    logger?.error({ err }, 'Failed to convert video to sticker');
    throw err;
  } finally {
    await fsPromises.unlink(inputPath).catch(() => {});
    await fsPromises.unlink(outputPath).catch(() => {});
  }
}

/**
 * Converts a video buffer into an animated WebP sticker and, if an audio stream is present,
 * extracts a clean Opus OGG audio track for native WhatsApp 1-bubble audio stickers.
 */
export async function videoToAudioSticker(
  buffer: Buffer,
  logger?: Logger
): Promise<AudioStickerResult> {
  const tempDir = path.join(process.cwd(), 'storage', 'temp');
  fs.mkdirSync(tempDir, { recursive: true });

  const fileId = `${Date.now()}_${crypto.randomUUID()}`;
  const probePath = path.join(tempDir, `${fileId}_probe.mp4`);
  await fsPromises.writeFile(probePath, buffer);

  let hasAudio: boolean;
  try {
    const info = await probeMedia(probePath);
    hasAudio = info.hasAudio;
  } finally {
    await fsPromises.unlink(probePath).catch(() => {});
  }

  if (!hasAudio) {
    const sticker = await videoToSticker(buffer, logger);
    return { sticker, seconds: 0 };
  }

  const [sticker, opus] = await Promise.all([
    videoToSticker(buffer, logger, MAX_AUDIO_STICKER_BYTES),
    audioToOpus(buffer, logger),
  ]);

  return {
    sticker,
    audio: opus.audio,
    seconds: opus.seconds,
  };
}

/**
 * Converts any audio or voice-note buffer into an Opus OGG track (max 8s) suitable for
 * WhatsApp audio stickers, stripping container metadata tags.
 */
export async function audioToOpus(buffer: Buffer, logger?: Logger): Promise<OpusAudioResult> {
  const tempDir = path.join(process.cwd(), 'storage', 'temp');
  fs.mkdirSync(tempDir, { recursive: true });

  const fileId = `${Date.now()}_${crypto.randomUUID()}`;
  const inputPath = path.join(tempDir, `${fileId}_audio_in`);
  const outputPath = path.join(tempDir, `${fileId}_audio_out.ogg`);

  await fsPromises.writeFile(inputPath, buffer);

  try {
    const { duration } = await probeMedia(inputPath).catch(() => ({
      duration: MAX_AUDIO_VIDEO_DURATION_SECONDS,
      hasAudio: true,
    }));
    const maxDuration = Math.min(duration, MAX_AUDIO_VIDEO_DURATION_SECONDS);

    const oggBuffer = await new Promise<Buffer>((resolve, reject) => {
      ffmpeg(inputPath)
        .inputOptions(['-fflags', '+genpts', '-ss', '0', '-t', `${maxDuration}`])
        .audioFilters(['aresample=async=1:first_pts=0'])
        .outputOptions([
          '-y',
          '-vn',
          '-map_metadata',
          '-1',
          '-c:a',
          'libopus',
          '-ar',
          '48000',
          '-ac',
          '1',
          '-b:a',
          '48k',
        ])
        .save(outputPath)
        .on('end', async () => {
          try {
            resolve(await fsPromises.readFile(outputPath));
          } catch (error) {
            reject(error);
          }
        })
        .on('error', reject);
    });

    return {
      audio: oggBuffer,
      seconds: Math.max(1, Math.round(maxDuration)),
    };
  } catch (err) {
    logger?.error({ err }, 'Failed to convert audio to Opus OGG');
    throw err;
  } finally {
    await fsPromises.unlink(inputPath).catch(() => {});
    await fsPromises.unlink(outputPath).catch(() => {});
  }
}

/**
 * Creates a StickerConverter backed by `sharp` and `fluent-ffmpeg`.
 */
export function createStickerMaker(logger?: Logger): StickerConverter {
  return {
    imageToSticker,
    videoToSticker: (buffer: Buffer) => videoToSticker(buffer, logger),
    audioToOpus: (buffer: Buffer) => audioToOpus(buffer, logger),
    videoToAudioSticker: (buffer: Buffer) => videoToAudioSticker(buffer, logger),
  };
}
