import { describe, it, expect, vi, beforeEach } from 'vitest';
import puppeteer from 'puppeteer-core';
import { BrowserManager } from '../../src/core/browser/browser-manager';
import * as locator from '../../src/core/browser/chrome-locator';

describe('BrowserManager', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reports availability based on locator result', () => {
    vi.spyOn(locator, 'locateChromeExecutable').mockReturnValue('/usr/bin/google-chrome');
    const manager = new BrowserManager();
    expect(manager.isAvailable()).toBe(true);

    vi.spyOn(locator, 'locateChromeExecutable').mockReturnValue(null);
    const unavailableManager = new BrowserManager();
    expect(unavailableManager.isAvailable()).toBe(false);
  });

  it('passes custom chromePath to locator', () => {
    const locatorSpy = vi.spyOn(locator, 'locateChromeExecutable').mockReturnValue('/custom/chrome');
    const manager = new BrowserManager({ chromePath: '/custom/chrome' });
    expect(locatorSpy).toHaveBeenCalledWith('/custom/chrome');
    expect(manager.isAvailable()).toBe(true);
  });

  it('returns null from renderPage when browser is not available', async () => {
    vi.spyOn(locator, 'locateChromeExecutable').mockReturnValue(null);
    const manager = new BrowserManager();

    const result = await manager.renderPage('https://example.com');
    expect(result).toBeNull();
  });

  it('renders page and closes page tab afterwards', async () => {
    vi.spyOn(locator, 'locateChromeExecutable').mockReturnValue('/usr/bin/google-chrome');

    const mockPage = {
      setRequestInterception: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      setUserAgent: vi.fn().mockResolvedValue(undefined),
      goto: vi.fn().mockResolvedValue(undefined),
      content: vi.fn().mockResolvedValue('<html><body>Rendered DOM</body></html>'),
      title: vi.fn().mockResolvedValue('Test Title'),
      url: vi.fn().mockReturnValue('https://example.com'),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const mockBrowser = {
      connected: true,
      newPage: vi.fn().mockResolvedValue(mockPage),
      close: vi.fn().mockResolvedValue(undefined),
    };

    vi.spyOn(puppeteer, 'launch').mockResolvedValue(mockBrowser as any);

    const manager = new BrowserManager({ idleTimeoutMs: 5000 });
    const result = await manager.renderPage('https://example.com', { waitAfterLoadMs: 0 });

    expect(result).toEqual({
      html: '<html><body>Rendered DOM</body></html>',
      title: 'Test Title',
      finalUrl: 'https://example.com',
    });
    expect(mockPage.close).toHaveBeenCalled();

    await manager.close();
    expect(mockBrowser.close).toHaveBeenCalled();
  });

  it('supports closeSync with SIGKILL for abrupt exits', () => {
    vi.spyOn(locator, 'locateChromeExecutable').mockReturnValue('/usr/bin/google-chrome');
    const mockProcess = {
      kill: vi.fn(),
    };
    const mockBrowser = {
      connected: true,
      process: vi.fn().mockReturnValue(mockProcess),
    };

    const manager = new BrowserManager();
    // Simulate active browser
    (manager as any).browser = mockBrowser;

    manager.closeSync();
    expect(mockProcess.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
