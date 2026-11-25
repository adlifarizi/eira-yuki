import fs from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { locateChromeExecutable } from '../../src/core/browser/chrome-locator';

describe('locateChromeExecutable', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns custom path immediately if it exists on disk', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => p === '/custom/path/to/chrome');

    const result = locateChromeExecutable('/custom/path/to/chrome');
    expect(result).toBe('/custom/path/to/chrome');
  });

  it('falls back to discovery if custom path does not exist', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => p === '/usr/bin/google-chrome');

    const result = locateChromeExecutable('/non/existent/chrome');
    if (process.platform === 'linux') {
      expect(result).toBe('/usr/bin/google-chrome');
    }
  });

  it('returns null if no executable is found across candidate paths', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const result = locateChromeExecutable();
    expect(result).toBeNull();
  });

  it('handles filesystem errors gracefully during candidate scan', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    const result = locateChromeExecutable();
    expect(result).toBeNull();
  });
});
