import puppeteer, { Browser } from 'puppeteer-core';
import { Logger } from 'pino';
import { locateChromeExecutable } from './chrome-locator';
import { DEFAULT_DESKTOP_USER_AGENT, DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_RENDER_TIMEOUT_MS, DEFAULT_WAIT_AFTER_LOAD_MS } from './constants';

export interface RenderOptions {
  timeoutMs?: number;
  waitAfterLoadMs?: number;
}

export interface RenderResult {
  html: string;
  title?: string;
  finalUrl?: string;
}

export interface BrowserManagerOptions {
  chromePath?: string;
  idleTimeoutMs?: number;
  logger?: Logger;
}

/**
 * Headless Browser Manager
 *
 * Manages the headless Chromium instance lifecycle with automatic idle teardown
 * to minimize long-term RAM usage. The binary path is supplied via dependency injection.
 */
export class BrowserManager {
  private browser: Browser | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private launchPromise: Promise<Browser | null> | null = null;
  private readonly idleTimeoutMs: number;
  private resolvedExecutablePath: string | null;
  private logger?: Logger;

  /**
   * Initializes a new BrowserManager instance.
   */
  constructor(options?: BrowserManagerOptions) {
    this.idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.resolvedExecutablePath = locateChromeExecutable(options?.chromePath);
    this.logger = options?.logger;
  }

  /**
   * Checks whether a valid Chrome/Chromium executable is available on the host system.
   */
  public isAvailable(): boolean {
    return Boolean(this.resolvedExecutablePath);
  }

  /**
   * Resets the idle timer after active browser operations.
   * If the browser remains unused for `idleTimeoutMs`, it will be closed automatically.
   */
  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      this.close().catch(() => {});
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  /**
   * Lazily acquires or reuses an active headless Chromium instance.
   * Serializes concurrent launch requests to prevent race conditions during startup.
   */
  private async getBrowser(): Promise<Browser | null> {
    if (!this.resolvedExecutablePath) {
      return null;
    }

    if (this.browser && this.browser.connected) {
      this.resetIdleTimer();
      return this.browser;
    }

    if (this.launchPromise) {
      return this.launchPromise;
    }

    this.launchPromise = (async () => {
      try {
        this.browser = await puppeteer.launch({
          executablePath: this.resolvedExecutablePath!,
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-first-run',
            '--no-zygote',
            '--disable-extensions',
            '--mute-audio',
            '--renderer-process-limit=1',
          ],
        });
        this.resetIdleTimer();
        return this.browser;
      } catch (err) {
        this.logger?.warn({ err }, '[BrowserManager] Failed to launch headless browser');
        return null;
      } finally {
        this.launchPromise = null;
      }
    })();

    return this.launchPromise;
  }

  /**
   * Renders a dynamic webpage, executing client-side JavaScript and returning DOM content.
   */
  public async renderPage(url: string, options?: RenderOptions): Promise<RenderResult | null> {
    const browser = await this.getBrowser();
    if (!browser) {
      return null;
    }

    const timeout = options?.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
    const waitAfterLoad = options?.waitAfterLoadMs ?? DEFAULT_WAIT_AFTER_LOAD_MS;

    let page;
    try {
      page = await browser.newPage();

      // Intercept and abort heavy media assets to minimize network and memory footprint
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const resourceType = req.resourceType();
        if (resourceType === 'image' || resourceType === 'media' || resourceType === 'font') {
          req.abort().catch(() => {});
        } else {
          req.continue().catch(() => {});
        }
      });

      // Emulate standard desktop browser
      await page.setUserAgent(DEFAULT_DESKTOP_USER_AGENT);

      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout,
      });

      // Allow brief window for SPA frameworks (React/Vue/Angular) to mount and hydrate
      if (waitAfterLoad > 0) {
        await new Promise((r) => setTimeout(r, waitAfterLoad));
      }

      const html = await page.content();
      const title = await page.title();
      const finalUrl = page.url();

      this.resetIdleTimer();
      return { html, title, finalUrl };
    } catch (err) {
      this.logger?.warn({ err, url }, '[BrowserManager] Failed to render dynamic page');
      return null;
    } finally {
      if (page) {
        await page.close().catch(() => {});
      }
    }
  }

  /**
   * Gracefully shuts down the active headless browser instance.
   */
  public async close(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.browser) {
      const b = this.browser;
      this.browser = null;
      await b.close().catch(() => {});
    }
  }

  /**
   * Synchronously terminates the browser process during abrupt host process exit.
   */
  public closeSync(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.browser) {
      try {
        this.browser.process()?.kill('SIGKILL');
      } catch {
        // Ignore termination errors during process exit
      }
      this.browser = null;
    }
  }
}
