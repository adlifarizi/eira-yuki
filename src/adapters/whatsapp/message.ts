import { WASocket, proto, downloadMediaMessage, WAMessage, jidNormalizedUser } from '@whiskeysockets/baileys';
import path from 'path';
import fs from 'node:fs';
import { Logger } from 'pino';
import { Config } from '../../config';
import { EiraAgent, PermissionGatekeeper, IncomingMessage, IncomingMedia } from '../../core';

/**
 * Sanitizes raw text input to prevent virtex / crash bombs / excessive invisible unicode.
 */
export function sanitizeMessageText(text: string, maxLength: number = 3000): string {
  if (!text) return '';
  // Strip invisible / zero-width characters commonly used in WhatsApp crashers & virtex
  const cleaned = text.replace(/[\u200B-\u200D\uFEFF\u202A-\u202E\u2060-\u206F]/g, '');
  if (cleaned.length > maxLength) {
    return cleaned.slice(0, maxLength) + '... [truncated]';
  }
  return cleaned.trim();
}

/**
 * In-memory sliding window rate-limiter and concurrency guard.
 */
export class CooldownTracker {
  private lastActivity = new Map<string, number>();
  private activeRequests = new Set<string>();

  isRateLimited(key: string, cooldownMs: number = 3000): boolean {
    const now = Date.now();
    const last = this.lastActivity.get(key) || 0;
    if (now - last < cooldownMs) {
      return true;
    }
    this.lastActivity.set(key, now);

    // Self-prune old entries to prevent memory accumulation
    if (this.lastActivity.size > 2000) {
      const cutoff = now - 60000;
      for (const [k, t] of this.lastActivity) {
        if (t < cutoff) this.lastActivity.delete(k);
      }
    }
    return false;
  }

  isBusy(chatId: string): boolean {
    return this.activeRequests.has(chatId);
  }

  startRequest(chatId: string): void {
    this.activeRequests.add(chatId);
  }

  finishRequest(chatId: string): void {
    this.activeRequests.delete(chatId);
  }
}

/**
 * Checks if a given JID or LID corresponds to the bot itself.
 */
export function isBotJid(
  targetJid: string | undefined | null,
  sock: WASocket,
  configBotPhone?: string
): boolean {
  if (!targetJid) return false;
  const normalizedTarget = jidNormalizedUser(targetJid);
  const botJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : '';
  const botLid = (sock.user as any)?.lid ? jidNormalizedUser((sock.user as any).lid) : '';

  if (botJid && normalizedTarget === botJid) return true;
  if (botLid && normalizedTarget === botLid) return true;

  const targetDigits = normalizedTarget.split('@')[0].replace(/\D/g, '');
  const cleanConfigPhone = configBotPhone?.replace(/\D/g, '') || '';
  const cleanBotPhone = botJid ? botJid.split('@')[0].replace(/\D/g, '') : cleanConfigPhone;

  if (cleanBotPhone && targetDigits === cleanBotPhone) return true;

  if (normalizedTarget.endsWith('@lid')) {
    try {
      const cleanLid = normalizedTarget.split('@')[0].replace(/\D/g, '');
      const reverseFile = path.join(process.cwd(), 'storage', 'auth', `lid-mapping-${cleanLid}_reverse.json`);
      if (fs.existsSync(reverseFile)) {
        const mapped = JSON.parse(fs.readFileSync(reverseFile, 'utf8'));
        const mappedDigits = String(mapped).replace(/\D/g, '');
        if (mappedDigits && (mappedDigits === cleanBotPhone || mappedDigits === cleanConfigPhone)) {
          return true;
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  return false;
}

/**
 * Resolves a sender JID or LID to a normalized phone number string.
 */
export function resolveSenderPhone(senderId: string): string {
  if (!senderId) return '';
  const normalizedSender = senderId.includes('@') ? jidNormalizedUser(senderId) : senderId;
  const userPart = normalizedSender.split('@')[0].split(':')[0];
  const senderDigits = userPart.replace(/\D/g, '');
  let resolvedPhone = senderDigits;

  if (normalizedSender.endsWith('@lid')) {
    try {
      const cleanLid = userPart.replace(/\D/g, '');
      const reverseFile = path.join(process.cwd(), 'storage', 'auth', `lid-mapping-${cleanLid}_reverse.json`);
      if (fs.existsSync(reverseFile)) {
        const mapped = JSON.parse(fs.readFileSync(reverseFile, 'utf8'));
        if (mapped) resolvedPhone = String(mapped).replace(/\D/g, '');
      }
    } catch {
      // Fallback
    }
  }

  return resolvedPhone || senderDigits || senderId;
}

export class MessageHandler {
  private cooldowns = new CooldownTracker();

  constructor(
    private logger: Logger,
    private config: Config,
    private eiraAgent: EiraAgent,
    private gatekeeper: PermissionGatekeeper
  ) {}

  async handle(sock: WASocket, msg: proto.IWebMessageInfo) {
    const m = msg.message;
    if (!m) return;

    // Unwrap ephemeral, viewOnce, or other wrapper messages
    const unwrapped =
      m.ephemeralMessage?.message ||
      m.viewOnceMessage?.message ||
      m.viewOnceMessageV2?.message ||
      m.documentWithCaptionMessage?.message ||
      m;

    const extractedText = (
      unwrapped.conversation ||
      unwrapped.extendedTextMessage?.text ||
      unwrapped.imageMessage?.caption ||
      unwrapped.videoMessage?.caption ||
      ''
    ).trim();

    // Sanitize message text against virtex / zero-width bombs
    const rawText = sanitizeMessageText(extractedText);

    const chatId = msg.key?.remoteJid || '';
    if (!chatId || chatId === 'status@broadcast' || chatId.endsWith('@broadcast')) return;

    const isGroup = chatId.endsWith('@g.us');
    const rawSenderId = isGroup ? msg.key?.participant || msg.participant || '' : chatId;
    const canonicalSenderId = resolveSenderPhone(rawSenderId) || rawSenderId;

    const isOwner = this.gatekeeper.isOwner(canonicalSenderId, 'whatsapp');

    const senderName = isOwner && this.config.bot.ownerName ? this.config.bot.ownerName : (msg.pushName || 'Pengguna');

    // Check context info (quoted messages)
    const contextInfo =
      unwrapped.extendedTextMessage?.contextInfo ||
      unwrapped.imageMessage?.contextInfo ||
      unwrapped.videoMessage?.contextInfo;
    const quotedMessage = contextInfo?.quotedMessage;
    const quotedParticipant = contextInfo?.participant || '';
    const rawQuotedText =
      quotedMessage?.conversation ||
      quotedMessage?.extendedTextMessage?.text ||
      quotedMessage?.imageMessage?.caption ||
      quotedMessage?.videoMessage?.caption ||
      '';
    const quotedText = sanitizeMessageText(rawQuotedText);

    // Check if the message is quoting the bot (matching JID, LID, or mapped phone)
    const isQuotingBot = !!(quotedParticipant && isBotJid(quotedParticipant, sock, this.config.adapters.whatsapp.phoneNumber));

    // Check if the bot is tagged via @mention in contextInfo
    const mentionedJids: string[] = contextInfo?.mentionedJid || [];
    const isTagMentioned = mentionedJids.some((mJid) => isBotJid(mJid, sock, this.config.adapters.whatsapp.phoneNumber));

    const isDirectlyAddressed = isQuotingBot || isTagMentioned;

    // Clean @mention tag numbers from rawText for directly addressed messages
    let processedText = rawText;
    if (isDirectlyAddressed) {
      processedText = processedText.replace(/@\d+/g, '').trim();
      if (!processedText && !unwrapped.imageMessage) {
        processedText = 'Halo Eira';
      }
    }

    // Skip if message contains neither text nor media
    if (!processedText && !rawText && !unwrapped.imageMessage) {
      return;
    }

    const fallbackText = unwrapped.imageMessage ? '[Gambar]' : '';
    const preliminaryText = processedText || rawText || fallbackText;

    const preliminaryIncoming: IncomingMessage = {
      id: msg.key?.id || String(Date.now()),
      senderId: canonicalSenderId,
      senderName,
      chatId,
      chatType: isGroup ? 'group' : 'dm',
      role: isOwner ? 'owner' : 'guest',
      text: preliminaryText,
      timestamp: Number(msg.messageTimestamp) * 1000 || Date.now(),
      adapter: 'whatsapp',
    };

    // Gatekeeper check: Only proceed if in DM or if directly addressed / called by alias in group
    const shouldRespond = this.gatekeeper.shouldRespond(preliminaryIncoming, isDirectlyAddressed);

    if (!shouldRespond) {
      return;
    }

    // Handle media if image message with strict size limit (Max 5MB)
    let media: IncomingMedia | undefined;
    const imageMessage = unwrapped.imageMessage;
    const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

    if (imageMessage) {
      const declaredSize = Number(imageMessage.fileLength) || 0;
      if (declaredSize > MAX_IMAGE_BYTES) {
        this.logger.warn(`[Security] Dropping oversized image: ${declaredSize} bytes exceeds 5MB limit`);
        return;
      }

      try {
        const buffer = (await downloadMediaMessage(msg as any, 'buffer', {})) as Buffer;
        if (buffer && buffer.length > 0) {
          if (buffer.length > MAX_IMAGE_BYTES) {
            this.logger.warn(`[Security] Dropping downloaded image: ${buffer.length} bytes exceeds 5MB limit`);
            return;
          }

          media = {
            buffer,
            mimeType: imageMessage.mimetype || 'image/jpeg',
            type: 'image',
          };
        }
      } catch (err) {
        this.logger.error(err, 'Failed to download image for agent handling');
      }
    }

    // Skip if message contains neither text nor media
    if (!processedText && !rawText && !media) {
      return;
    }

    // Rate Limiting & Concurrency Guard for Guests
    if (!isOwner) {
      if (this.cooldowns.isRateLimited(canonicalSenderId, 3000)) {
        this.logger.debug(`[Security] Rate limit triggered: dropping rapid message from guest ${canonicalSenderId}`);
        return;
      }
      if (this.cooldowns.isBusy(chatId)) {
        this.logger.debug(`[Security] Chat ${chatId} busy processing previous turn, dropping duplicate`);
        return;
      }
    }

    this.logger.debug(
      `[WhatsApp] Received message from ${senderName} (${canonicalSenderId}) in ${chatId} | group: ${isGroup} | addressed: ${isDirectlyAddressed} | text: "${(processedText || rawText).slice(0, 60)}"`
    );

    // Create incoming message for EiraCore
    const incomingText = processedText || rawText || (media ? '[Gambar]' : '');
    const quotedSenderId = quotedParticipant
      ? resolveSenderPhone(quotedParticipant) || quotedParticipant
      : '';

    const incoming: IncomingMessage = {
      ...preliminaryIncoming,
      text: incomingText,
      media,
      quotedMessage: quotedText ? { senderId: quotedSenderId, text: quotedText } : undefined,
    };

    this.cooldowns.startRequest(chatId);

    // Keep typing indicator alive throughout LLM generation & multi-hop tool execution
    await sock.sendPresenceUpdate('composing', chatId).catch(() => {});
    const typingInterval = setInterval(() => {
      sock.sendPresenceUpdate('composing', chatId).catch(() => {});
    }, 4500);

    try {
      const response = await this.eiraAgent.handleMessage(incoming);

      this.logger.debug(
        `[Chat] ${senderName} in ${chatId} [group: ${isGroup}]: "${(processedText || rawText).slice(0, 60)}"`
      );

      // Log only when tools are executed
      if (response.actionsExecuted && response.actionsExecuted.length > 0) {
        const details = response.actionsExecuted.map((a) => a.toolName);
        this.logger.info(`[Tools] Executed: ${details.join(', ')}`);
      }

      // 1. Send text reply first if present
      if (response.text && response.text.trim().length > 0) {
        let replyText = response.text;

        if (response.sources && response.sources.length > 0) {
          replyText += '\n\n*References:*';
          const uniqueSources = response.sources.filter(
            (src, idx, self) => self.findIndex((s) => s.url === src.url) === idx
          );
          uniqueSources.forEach((src, idx) => {
            replyText += `\n${idx + 1}. ${src.title} (${src.url})`;
          });
        }

        this.logger.debug(`[Chat] Reply to ${senderName} in ${chatId}: "${replyText.slice(0, 60)}"`);

        // Send regular message in DM (natural chat); quote message in Group to specify recipient
        const sendOptions = isGroup ? { quoted: msg as WAMessage } : undefined;
        await sock.sendMessage(chatId, { text: replyText, linkPreview: null }, sendOptions);
      } else if (!response.attachment) {
        // Fallback if response returned neither text nor attachment
        const sendOptions = isGroup ? { quoted: msg as WAMessage } : undefined;
        await sock.sendMessage(
          chatId,
          { text: 'No response could be generated at this time.', linkPreview: null },
          sendOptions
        );
      }

      // 2. Dispatch rich media attachment if present in standardized response
      if (response.attachment) {
        const payloadBuffer =
          response.attachment.payload instanceof Buffer
            ? response.attachment.payload
            : Buffer.from(response.attachment.payload);

        if (response.attachment.type === 'sticker') {
          this.logger.info(
            `[Attachment] Sending sticker (${payloadBuffer.length} bytes) to ${chatId}`
          );
          try {
            await sock.sendMessage(chatId, { sticker: payloadBuffer });
          } catch (stickerErr) {
            this.logger.error(stickerErr, `[Attachment] Failed to send sticker to ${chatId}`);
          }
        } else if (response.attachment.type === 'image') {
          this.logger.info(
            `[Attachment] Sending image (${payloadBuffer.length} bytes) to ${chatId}`
          );
          try {
            await sock.sendMessage(chatId, { image: payloadBuffer });
          } catch (imageErr) {
            this.logger.error(imageErr, `[Attachment] Failed to send image to ${chatId}`);
          }
        }
      }
    } catch (err: any) {
      this.logger.error(err, 'Error in EiraAgent message handling');

      // Inform chat about processing failure without emojis
      try {
        const errMsg = err?.message || '';
        const isUnavailable =
          err?.status === 503 ||
          errMsg.includes('503') ||
          errMsg.includes('high demand') ||
          errMsg.includes('UNAVAILABLE');
        const isTimeout =
          errMsg.includes('ETIMEDOUT') ||
          errMsg.includes('timeout') ||
          err?.code === 'ETIMEDOUT';

        let failureNotice = 'A system error occurred while processing the message.';
        if (isUnavailable) {
          failureNotice = 'AI system is experiencing heavy load (503). Please try again shortly.';
        } else if (isTimeout) {
          failureNotice = 'Connection to the AI system timed out. Please try again.';
        }

        const sendOptions = isGroup ? { quoted: msg as WAMessage } : undefined;
        await sock.sendMessage(chatId, { text: failureNotice, linkPreview: null }, sendOptions);
      } catch (notifyErr) {
        this.logger.error(notifyErr, 'Failed to send failure notification to chat');
      }
    } finally {
      clearInterval(typingInterval);
      await sock.sendPresenceUpdate('paused', chatId).catch(() => {});
      this.cooldowns.finishRequest(chatId);
    }
  }
}
