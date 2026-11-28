import puppeteer, { Browser, Page } from 'puppeteer-core';
import { Logger } from 'pino';
import { locateChromeExecutable } from './chrome-locator';
import { DEFAULT_DESKTOP_USER_AGENT, DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_NETWORK_IDLE_TIME_MS, DEFAULT_NETWORK_IDLE_TIMEOUT_MS, DEFAULT_RENDER_TIMEOUT_MS, DEFAULT_WAIT_AFTER_LOAD_MS, DOM_SETTLE_INTERVAL_MS } from './constants';

export interface RenderOptions {
  timeoutMs?: number;
  waitAfterLoadMs?: number;
}

export interface RenderResult {
  html: string;
  text?: string;
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

      if (waitAfterLoad > 0) {
        await this.waitForPageSettled(page, timeout, waitAfterLoad);
      }

      const html = await page.content();
      const text = await this.extractVisibleText(page);
      const title = await page.title();
      const finalUrl = page.url();

      this.resetIdleTimer();
      return {
        html,
        ...(text ? { text } : {}),
        title,
        finalUrl,
      };
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
   * Waits for async XHR/fetch activity and client-side DOM mutations to settle without
   * failing if long-polling connections keep the network open.
   */
  private async waitForPageSettled(
    page: Page,
    timeoutMs: number,
    waitAfterLoadMs: number
  ): Promise<void> {
    if (typeof page.waitForNetworkIdle === 'function') {
      await page
        .waitForNetworkIdle({
          idleTime: DEFAULT_NETWORK_IDLE_TIME_MS,
          timeout: Math.min(timeoutMs, DEFAULT_NETWORK_IDLE_TIMEOUT_MS),
        })
        .catch(() => {});
    }

    if (typeof page.evaluate !== 'function') {
      await new Promise((r) => setTimeout(r, waitAfterLoadMs));
      return;
    }

    const readTextLength = async (): Promise<number> => {
      try {
        return await page.evaluate(() => document.body?.innerText?.trim().length ?? 0);
      } catch {
        return 0;
      }
    };

    const deadline = Date.now() + waitAfterLoadMs;
    let previousLength = await readTextLength();
    while (Date.now() < deadline) {
      const stepMs = Math.min(DOM_SETTLE_INTERVAL_MS, Math.max(50, deadline - Date.now()));
      await new Promise((r) => setTimeout(r, stepMs));
      const currentLength = await readTextLength();
      if (currentLength > 0 && currentLength === previousLength) {
        break;
      }
      previousLength = currentLength;
    }
  }

  private async extractVisibleText(page: Page): Promise<string | undefined> {
    if (typeof page.evaluate !== 'function') {
      return undefined;
    }
    try {
      const raw = await page.evaluate(() => document.body?.innerText ?? '');
      const trimmed = typeof raw === 'string' ? raw.trim() : '';
      return trimmed || undefined;
    } catch {
      return undefined;
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
