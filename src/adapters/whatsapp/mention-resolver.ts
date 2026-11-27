import { WASocket, jidNormalizedUser } from '@whiskeysockets/baileys';
import { PermissionGatekeeper } from '../../core';
import { isBotJid, resolveSenderPhone } from './message';

const DEFAULT_MAX_CACHE_SIZE = 500;
const DEFAULT_GROUP_METADATA_TTL_MS = 15 * 60 * 1000;
const GENERIC_FALLBACK_NAME = 'Pengguna';

export interface MentionResolverOptions {
  gatekeeper: PermissionGatekeeper;
  ownerName?: string;
  botPhone?: string;
  maxCacheSize?: number;
  groupMetadataTtlMs?: number;
}

export interface ProcessMentionsParams {
  text: string;
  mentionedJids: string[];
  sock: WASocket;
  chatId: string;
  isGroup: boolean;
  hasImage: boolean;
  isDirectlyAddressed: boolean;
}

interface CachedGroupParticipants {
  expiresAt: number;
  namesByKey: Map<string, string>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractJidDigits(jid: string): string {
  if (!jid) return '';
  const normalized = jid.includes('@') ? jidNormalizedUser(jid) : jid;
  return normalized.split('@')[0].split(':')[0].replace(/\D/g, '');
}

/**
 * Resolves WhatsApp `@mention` JIDs/LIDs to human-readable display names using passive
 * participant name caching, owner configuration, and optional group metadata lookups.
 * Strips only mentions targeting the bot itself while preserving mentions of other users.
 */
export class MentionResolver {
  private readonly nameCache = new Map<string, string>();
  private readonly groupMetadataCache = new Map<string, CachedGroupParticipants>();
  private readonly maxCacheSize: number;
  private readonly groupMetadataTtlMs: number;

  constructor(private readonly options: MentionResolverOptions) {
    this.maxCacheSize = options.maxCacheSize ?? DEFAULT_MAX_CACHE_SIZE;
    this.groupMetadataTtlMs = options.groupMetadataTtlMs ?? DEFAULT_GROUP_METADATA_TTL_MS;
  }

  /**
   * Records a participant's display name from an incoming message so future `@mention`
   * references to that participant can be resolved without extra network calls.
   */
  recordParticipant(rawSenderId: string, canonicalSenderId: string, displayName: string): void {
    const trimmedName = displayName?.trim();
    if (!trimmedName || trimmedName === GENERIC_FALLBACK_NAME) {
      return;
    }

    const keys = new Set<string>();
    if (canonicalSenderId?.trim()) {
      keys.add(canonicalSenderId.trim());
    }
    const rawDigits = extractJidDigits(rawSenderId);
    if (rawDigits) {
      keys.add(rawDigits);
    }

    for (const key of keys) {
      this.setBoundedCacheEntry(key, trimmedName);
    }
  }

  /**
   * Strips `@mention` tags pointing to the bot and replaces tags pointing to other
   * participants with their resolved `@DisplayName`.
   */
  async processMentions(params: ProcessMentionsParams): Promise<string> {
    let result = params.text;

    for (const mJid of params.mentionedJids) {
      const digits = extractJidDigits(mJid);
      if (!digits) continue;

      const mentionPattern = new RegExp(`(?<!\\w)@${escapeRegExp(digits)}(?!\\d)`, 'g');

      if (isBotJid(mJid, params.sock, this.options.botPhone)) {
        result = result.replace(mentionPattern, '');
        continue;
      }

      const displayName = await this.resolveDisplayName(
        mJid,
        digits,
        params.sock,
        params.chatId,
        params.isGroup
      );
      if (displayName) {
        result = result.replace(mentionPattern, `@${displayName}`);
      }
    }

    result = result.replace(/\s{2,}/g, ' ').trim();

    if (params.isDirectlyAddressed && !result && !params.hasImage) {
      return 'Halo Eira';
    }

    return result;
  }

  private async resolveDisplayName(
    jid: string,
    digits: string,
    sock: WASocket,
    chatId: string,
    isGroup: boolean
  ): Promise<string | undefined> {
    const canonical = resolveSenderPhone(jid) || digits;

    if (this.options.gatekeeper.isOwner(canonical, 'whatsapp') && this.options.ownerName) {
      return this.options.ownerName;
    }

    const cached = this.nameCache.get(canonical) ?? this.nameCache.get(digits);
    if (cached) {
      return cached;
    }

    if (!isGroup || typeof sock.groupMetadata !== 'function') {
      return undefined;
    }

    const groupNames = await this.getGroupParticipantNames(sock, chatId);
    const fromGroup = groupNames.get(canonical) ?? groupNames.get(digits);
    if (fromGroup) {
      this.setBoundedCacheEntry(canonical, fromGroup);
      this.setBoundedCacheEntry(digits, fromGroup);
    }
    return fromGroup;
  }

  private async getGroupParticipantNames(
    sock: WASocket,
    chatId: string
  ): Promise<Map<string, string>> {
    const now = Date.now();
    const cached = this.groupMetadataCache.get(chatId);
    if (cached && cached.expiresAt > now) {
      return cached.namesByKey;
    }

    const namesByKey = new Map<string, string>();
    try {
      const metadata = await sock.groupMetadata(chatId);
      for (const participant of metadata?.participants ?? []) {
        const p = participant as {
          id?: string;
          lid?: string;
          notify?: string;
          name?: string;
          verifiedName?: string;
        };
        const name = (p.notify || p.name || p.verifiedName || '').trim();
        if (!name) continue;

        const idDigits = extractJidDigits(p.id ?? '');
        if (idDigits) namesByKey.set(idDigits, name);

        const lidDigits = extractJidDigits(p.lid ?? '');
        if (lidDigits) namesByKey.set(lidDigits, name);
      }
    } catch {
      // Group metadata lookup is best-effort; fall back to raw digits on failure.
    }

    this.groupMetadataCache.set(chatId, {
      expiresAt: now + this.groupMetadataTtlMs,
      namesByKey,
    });

    return namesByKey;
  }

  private setBoundedCacheEntry(key: string, value: string): void {
    if (this.nameCache.has(key)) {
      this.nameCache.delete(key);
    } else if (this.nameCache.size >= this.maxCacheSize) {
      const oldestKey = this.nameCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.nameCache.delete(oldestKey);
      }
    }
    this.nameCache.set(key, value);
  }
}
