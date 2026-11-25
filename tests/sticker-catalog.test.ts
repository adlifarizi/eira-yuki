import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StickerCatalog } from '../src/utils/sticker-catalog';
import fs from 'node:fs';
import path from 'path';

describe('StickerCatalog', () => {
  const testDir = path.join(process.cwd(), 'storage', 'test-stickers');

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, 'smug.webp'), Buffer.from('smug-data'));
    fs.writeFileSync(path.join(testDir, 'tease_1.webp'), Buffer.from('tease-data'));

    // Create a subfolder with a sticker
    const subDir = path.join(testDir, 'confused');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'huh.webp'), Buffer.from('huh-data'));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('retrieves sticker by exact tag or auto-discovered ID', () => {
    const catalog = new StickerCatalog(testDir);
    const buf = catalog.getSticker('smug');
    expect(buf).not.toBeNull();
    expect(buf?.toString()).toBe('smug-data');
  });

  it('retrieves sticker from subfolder via auto-discovered ID', () => {
    const catalog = new StickerCatalog(testDir);
    const buf = catalog.getSticker('confused_huh');
    expect(buf).not.toBeNull();
    expect(buf?.toString()).toBe('huh-data');
  });

  it('retrieves sticker by prefix tag fallback', () => {
    const catalog = new StickerCatalog(testDir);
    const buf = catalog.getSticker('tease');
    expect(buf).not.toBeNull();
    expect(buf?.toString()).toBe('tease-data');
  });

  it('parses catalog.json and matches exact id and metadata', () => {
    const manifest = [
      {
        id: 'custom_huh',
        file: 'confused/huh.webp',
        text: 'Huh?',
        context: 'Perplexed reaction',
      },
    ];
    fs.writeFileSync(path.join(testDir, 'catalog.json'), JSON.stringify(manifest));

    const catalog = new StickerCatalog(testDir);
    const buf = catalog.getSticker('custom_huh');
    expect(buf).not.toBeNull();
    expect(buf?.toString()).toBe('huh-data');

    const desc = catalog.describeForTools();
    expect(desc).toContain('custom_huh');
    expect(desc).toContain('[text: "Huh?"]');
  });

  it('handles duplicate IDs in catalog.json gracefully by keeping the first occurrence', () => {
    const manifest = [
      { id: 'smug_dup', file: 'smug.webp', text: 'First' },
      { id: 'smug_dup', file: 'tease_1.webp', text: 'Duplicate Second' },
    ];
    fs.writeFileSync(path.join(testDir, 'catalog.json'), JSON.stringify(manifest));

    const catalog = new StickerCatalog(testDir);
    const buf = catalog.getSticker('smug_dup');
    expect(buf?.toString()).toBe('smug-data'); // kept the first one
  });

  it('skips missing files declared in catalog.json without crashing', () => {
    const manifest = [
      { id: 'ghost_sticker', file: 'non_existent_file.webp', text: 'Ghost' },
      { id: 'smug_valid', file: 'smug.webp', text: 'Valid' },
    ];
    fs.writeFileSync(path.join(testDir, 'catalog.json'), JSON.stringify(manifest));

    const catalog = new StickerCatalog(testDir);
    expect(catalog.getSticker('ghost_sticker')).toBeNull();
    expect(catalog.getSticker('smug_valid')?.toString()).toBe('smug-data');
  });

  it('handles corrupted catalog.json gracefully by falling back to disk discovery', () => {
    fs.writeFileSync(path.join(testDir, 'catalog.json'), '{ invalid json broken syntax :');

    const catalog = new StickerCatalog(testDir);
    const buf = catalog.getSticker('smug');
    expect(buf).not.toBeNull();
    expect(buf?.toString()).toBe('smug-data');
  });

  it('returns null if sticker or tag is not found', () => {
    const catalog = new StickerCatalog(testDir);
    const buf = catalog.getSticker('unknown_emotion');
    expect(buf).toBeNull();
  });
});
