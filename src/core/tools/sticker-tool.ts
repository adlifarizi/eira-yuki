import { StickerResolver } from '../types';
import { CoreTool } from './types';

/** Canonical tool name for sending reaction stickers. */
export const SEND_STICKER_TOOL_NAME = 'send_sticker';

/**
 * Standardized result returned by the send_sticker tool.
 */
export interface StickerToolResult {
  status: 'success';
  stickerRequested: string;
  reason?: string;
}

/**
 * Type guard verifying whether an arbitrary tool result conforms to StickerToolResult.
 */
export function isStickerToolResult(result: unknown): result is StickerToolResult {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as StickerToolResult).status === 'success' &&
    typeof (result as StickerToolResult).stickerRequested === 'string' &&
    (result as StickerToolResult).stickerRequested.length > 0
  );
}

/**
 * Options for creating the send sticker tool.
 */
export interface SendStickerToolOptions {
  /** Sticker resolver instance used to describe and resolve available stickers. */
  catalog: StickerResolver;
}

/**
 * Factory function that instantiates the reaction sticker tool for EiraAgent.
 * Injects sticker descriptions dynamically from the disk catalog rather than hardcoded lists.
 *
 * @param options - Configuration options with injected sticker catalog.
 * @returns Executable CoreTool for sending reaction stickers.
 */
export function createSendStickerTool(options: SendStickerToolOptions): CoreTool {
  const catalog = options.catalog;

  return {
    name: SEND_STICKER_TOOL_NAME,
    description:
      'Send an expressive sticker sparingly for rare, high-impact emotional reactions (e.g. utter disbelief, strong refusal). Do NOT call this on every turn.',
    parameters: {
      type: 'object',
      properties: {
        tag: {
          type: 'string',
          description: `Sticker ID or emotion to send. Installed stickers:\n${catalog.describeForTools()}`,
        },
        stickerId: {
          type: 'string',
          description: 'Optional specific sticker ID from catalog.',
        },
        reason: {
          type: 'string',
          description: 'Brief reason for choosing this specific sticker.',
        },
      },
      required: ['tag'],
    },
    ownerOnly: false,
    operationalDirective:
      'Sticker Frequency: Use reaction stickers SPARINGLY (at most once every few turns, NOT on every message). Never spam stickers on consecutive turns. Only send a sticker when an extreme emotion or reaction truly benefits from visual punch. When words are sufficient, rely purely on natural text and DO NOT call this tool.',
    execute: async (params) => {
      return {
        status: 'success',
        stickerRequested: params.stickerId || params.tag,
        reason: params.reason,
      };
    },
  };
}
