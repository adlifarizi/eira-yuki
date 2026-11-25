import fs from 'node:fs';
import path from 'path';

export interface StickerEntry {
  id: string;
  file?: string;
  text?: string | null;
  context?: string;
  description?: string;
  tags?: string[];
}

export interface ResolvedSticker {
  id: string;
  filePath: string;
  text: string | null;
  context: string;
  tags: string[];
}

export class StickerCatalog {
  private baseDir: string;
  private stickers: Map<string, ResolvedSticker> = new Map();
  private catalogFile: string;

  constructor(customDir?: string) {
    this.baseDir = customDir || path.join(process.cwd(), 'assets', 'stickers');
    this.catalogFile = path.join(this.baseDir, 'catalog.json');
    fs.mkdirSync(this.baseDir, { recursive: true });
    this.reload();
  }

  /**
   * Reloads sticker catalog from disk and catalog.json.
   * Handles duplicate IDs, missing files, corrupted JSON, and auto-discovers uncataloged files.
   */
  reload(): void {
    this.stickers.clear();
    if (!fs.existsSync(this.baseDir)) return;

    // 1. Scan all supported image files in baseDir and any subdirectories
    const scannedFiles = this.scanDirectory(this.baseDir);

    // 2. Parse catalog.json if it exists
    let catalogEntries: StickerEntry[] = [];
    if (fs.existsSync(this.catalogFile)) {
      try {
        const raw = fs.readFileSync(this.catalogFile, 'utf8').trim();
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            catalogEntries = parsed;
          }
        }
      } catch {
        // Edge case: Corrupt JSON - ignore safely and proceed with filesystem discovery
      }
    }

    const registeredFilePaths = new Set<string>();

    // 3. Process catalog entries
    for (const entry of catalogEntries) {
      if (!entry || typeof entry.id !== 'string') continue;

      const cleanId = entry.id.toLowerCase().trim();
      if (!cleanId) continue;

      // Edge case: Duplicate ID in catalog.json
      if (this.stickers.has(cleanId)) {
        continue; // Keep first occurrence, discard duplicate
      }

      // Locate physical file on disk
      const targetFileName = entry.file?.trim() || `${cleanId}.webp`;
      const matched = scannedFiles.find((f) => {
        const rel = f.relativePath.toLowerCase();
        const base = path.basename(f.fullPath).toLowerCase();
        return (
          rel === targetFileName.toLowerCase() ||
          base === targetFileName.toLowerCase() ||
          rel === `${cleanId}.webp` ||
          rel === `${cleanId}.png` ||
          base === `${cleanId}.webp` ||
          base === `${cleanId}.png`
        );
      });

      // Edge case: Missing file on disk
      if (!matched || !fs.existsSync(matched.fullPath)) {
        continue;
      }

      const tags = (entry.tags || []).map((t) => t.toLowerCase().trim());
      const prefixTag = cleanId.split('_')[0];
      if (prefixTag && !tags.includes(prefixTag)) {
        tags.push(prefixTag);
      }

      this.stickers.set(cleanId, {
        id: cleanId,
        filePath: matched.fullPath,
        text: entry.text || null,
        context: entry.context || entry.description || `Sticker for ${cleanId}`,
        tags,
      });

      registeredFilePaths.add(matched.fullPath);
    }

    // 4. Auto-discovery: Index physical files on disk that are not registered in catalog.json
    for (const file of scannedFiles) {
      if (registeredFilePaths.has(file.fullPath)) continue;

      // Generate ID from relative path (e.g., "confused/huh.webp" -> "confused_huh")
      const parsedPath = path.parse(file.relativePath);
      const parts = [
        ...parsedPath.dir.split(/[\\/]/).filter(Boolean),
        parsedPath.name,
      ];
      let autoId = parts.join('_').toLowerCase().replace(/[^a-z0-9_-]/g, '_');

      // Edge case: ID collision with existing catalog item
      if (this.stickers.has(autoId)) {
        let counter = 2;
        while (this.stickers.has(`${autoId}_${counter}`)) {
          counter++;
        }
        autoId = `${autoId}_${counter}`;
      }

      const prefixTag = autoId.split('_')[0];

      this.stickers.set(autoId, {
        id: autoId,
        filePath: file.fullPath,
        text: null,
        context: `Sticker for ${autoId}`,
        tags: [prefixTag],
      });

      registeredFilePaths.add(file.fullPath);
    }
  }

  /**
   * Retrieves a sticker buffer by exact ID, filename, tag, or semantic keyword.
   */
  getSticker(idOrTag: string): Buffer | null {
    if (!idOrTag) return null;
    const query = idOrTag.toLowerCase().trim();

    // 1. Exact match on ID
    const exact = this.stickers.get(query);
    if (exact && fs.existsSync(exact.filePath)) {
      try {
        return fs.readFileSync(exact.filePath);
      } catch {
        return null;
      }
    }

    // 2. Multi-tier fuzzy & tag match
    const scoredMatches: { sticker: ResolvedSticker; score: number }[] = [];
    const stopWords = new Set(['sticker', 'stickers', 'for', 'the', 'a', 'an']);
    const queryTokens = query
      .split(/[\s_-]+/)
      .filter((t) => Boolean(t) && !stopWords.has(t));

    for (const sticker of this.stickers.values()) {
      let score = 0;
      const stickerTokens = [
        ...sticker.id.split(/[\s_-]+/),
        ...sticker.tags,
        ...(sticker.text ? sticker.text.toLowerCase().split(/[\s_-]+/) : []),
      ].filter((t) => Boolean(t) && !stopWords.has(t));

      // Substring match on ID
      if (sticker.id.includes(query) || (query.length > 2 && query.includes(sticker.id))) {
        score += 10;
      }

      // Tag exact match
      if (sticker.tags.includes(query)) {
        score += 8;
      }

      // Token overlap
      for (const qToken of queryTokens) {
        for (const sToken of stickerTokens) {
          if (qToken === sToken) {
            score += 5;
          } else if (qToken.length > 2 && sToken.length > 2 && (sToken.startsWith(qToken) || qToken.startsWith(sToken))) {
            score += 3;
          }
        }
      }

      if (score >= 3) {
        scoredMatches.push({ sticker, score });
      }
    }

    if (scoredMatches.length > 0) {
      scoredMatches.sort((a, b) => b.score - a.score);
      const topScore = scoredMatches[0].score;
      const bestCandidates = scoredMatches.filter((m) => m.score === topScore);
      const picked = bestCandidates[Math.floor(Math.random() * bestCandidates.length)].sticker;
      try {
        return fs.readFileSync(picked.filePath);
      } catch {
        return null;
      }
    }

    return null;
  }

  /**
   * Returns list of all resolved stickers in catalog.
   */
  getAllStickers(): ResolvedSticker[] {
    return Array.from(this.stickers.values());
  }

  /**
   * Returns available sticker IDs and tags.
   */
  getAvailableTags(): string[] {
    return Array.from(this.stickers.keys());
  }

  /**
   * Generates formatted description of available stickers for tool declaration.
   */
  describeForTools(): string {
    const list = this.getAllStickers();
    if (list.length === 0) {
      return 'No stickers currently available.';
    }

    return list
      .map((s) => {
        const textInfo = s.text ? ` [text: "${s.text}"]` : '';
        return `- ${s.id}${textInfo}: ${s.context} (tags: ${s.tags.join(', ')})`;
      })
      .join('\n');
  }

  /**
   * Recursively scans a directory for webp/png files.
   */
  private scanDirectory(dir: string, baseDir: string = dir): { relativePath: string; fullPath: string }[] {
    let results: { relativePath: string; fullPath: string }[] = [];
    if (!fs.existsSync(dir)) return results;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results = results.concat(this.scanDirectory(fullPath, baseDir));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === '.webp' || ext === '.png') {
          const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
          results.push({ relativePath, fullPath });
        }
      }
    }
    return results;
  }
}

export const defaultStickerCatalog = new StickerCatalog();
