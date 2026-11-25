import { BrowserManager } from './browser-manager';
import { DEFAULT_ACCEPT_LANGUAGE, DEFAULT_DESKTOP_USER_AGENT, DEFAULT_FETCH_TIMEOUT_MS, DEFAULT_RENDER_TIMEOUT_MS, MAX_EXTRACTED_CONTENT_CHARS, MIN_DYNAMIC_CONTENT_CHARS } from './constants';
import { cleanHtmlToText, isSpaOrDynamicPage } from './html-cleaner';
import { isPrivateIpOrHost, isPrivateOrReservedHost } from './network-guard';
import { extractWithTavily } from './tavily-extractor';
import { FetchWebpageOptions, WebpageContentResult } from './types';

export interface PageFetcherOptions {
  tavilyApiKey?: string;
  chromePath?: string;
  browserManager?: BrowserManager;
}

export class PageFetcher {
  private browserManager: BrowserManager;

  constructor(private options: PageFetcherOptions = {}) {
    this.browserManager =
      options.browserManager ?? new BrowserManager({ chromePath: options.chromePath });
  }

  async fetch(rawUrl: string, options?: FetchWebpageOptions): Promise<WebpageContentResult> {
    const trimmed = rawUrl?.trim();
    if (!trimmed) {
      return { status: 'error', url: rawUrl, message: 'URL cannot be empty.' };
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(trimmed);
    } catch {
      return { status: 'error', url: trimmed, message: `Invalid URL format: "${trimmed}"` };
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return { status: 'error', url: trimmed, message: 'Only HTTP and HTTPS URLs are allowed.' };
    }

    if (await isPrivateOrReservedHost(parsedUrl.hostname)) {
      return { status: 'error', url: trimmed, message: 'Access to private or local network addresses is restricted.' };
    }

    if (options?.forceBrowser && this.browserManager.isAvailable()) {
      const rendered = await this.browserManager.renderPage(parsedUrl.toString(), {
        timeoutMs: options.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS,
      });
      if (rendered?.html) {
        if (rendered.finalUrl) {
          try {
            if (isPrivateIpOrHost(new URL(rendered.finalUrl).hostname)) {
              return {
                status: 'blocked',
                url: trimmed,
                message: 'Access to private or local network addresses is restricted.',
              };
            }
          } catch {
            // Ignore malformed finalUrl
          }
        }
        const { title, description, body } = cleanHtmlToText(rendered.html, parsedUrl.toString());
        return {
          status: 'success',
          url: trimmed,
          title: title || rendered.title || 'No title',
          description,
          content: body.slice(0, MAX_EXTRACTED_CONTENT_CHARS),
          source: 'headless_browser',
        };
      }
    }

    try {
      const response = await fetch(parsedUrl.toString(), {
        signal: AbortSignal.timeout(options?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS),
        headers: {
          'User-Agent': DEFAULT_DESKTOP_USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': DEFAULT_ACCEPT_LANGUAGE,
        },
      });

      if (response.url) {
        try {
          const finalUrl = new URL(response.url);
          if (isPrivateIpOrHost(finalUrl.hostname)) {
            return {
              status: 'blocked',
              url: trimmed,
              message: 'Access to private or local network addresses is restricted.',
            };
          }
        } catch {
          // Ignore malformed response.url
        }
      }

      if (response.status === 404) {
        return {
          status: 'not_found',
          url: trimmed,
          message: '404 Not Found: The requested webpage was not found or has been removed.',
        };
      }

      if (response.status === 403 || response.status === 429) {
        const tavilyExtract = await extractWithTavily(trimmed, this.options.tavilyApiKey);
        if (tavilyExtract) return tavilyExtract;

        return {
          status: 'blocked',
          url: trimmed,
          statusCode: response.status,
          message: `Website blocked automated access (HTTP ${response.status}). Do not fabricate page contents if blocked.`,
        };
      }

      if (!response.ok) {
        return {
          status: 'error',
          url: trimmed,
          statusCode: response.status,
          message: `Failed to load URL (HTTP status ${response.status}).`,
        };
      }

      const html = await response.text();
      const { title, description, body } = cleanHtmlToText(html, parsedUrl.toString());

      if (isSpaOrDynamicPage(html, body) && this.browserManager.isAvailable()) {
        const rendered = await this.browserManager.renderPage(parsedUrl.toString(), {
          timeoutMs: options?.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS,
        });
        if (rendered?.html) {
        if (rendered.finalUrl) {
          try {
            if (isPrivateIpOrHost(new URL(rendered.finalUrl).hostname)) {
              return {
                status: 'blocked',
                url: trimmed,
                message: 'Access to private or local network addresses is restricted.',
              };
            }
          } catch {
            // Ignore malformed finalUrl
          }
        }
          const dynamicCleaned = cleanHtmlToText(rendered.html, parsedUrl.toString());
          if (dynamicCleaned.body.length >= body.length || dynamicCleaned.body.length > MIN_DYNAMIC_CONTENT_CHARS) {
            return {
              status: 'success',
              url: trimmed,
              title: dynamicCleaned.title || rendered.title || title || 'No title',
              description: dynamicCleaned.description || description,
              content: dynamicCleaned.body.slice(0, MAX_EXTRACTED_CONTENT_CHARS),
              source: 'headless_browser',
            };
          }
        }
      }

      return {
        status: 'success',
        url: trimmed,
        title: title || 'No title',
        description,
        content: body.slice(0, MAX_EXTRACTED_CONTENT_CHARS),
        source: 'http_fetch',
      };
    } catch (err: any) {
      if (err.name === 'TimeoutError' || err.code === 20) {
        return {
          status: 'timeout',
          url: trimmed,
          message: 'Request to read URL timed out (timeout limit exceeded).',
        };
      }

      const tavilyExtract = await extractWithTavily(trimmed, this.options.tavilyApiKey);
      if (tavilyExtract) return tavilyExtract;

      return {
        status: 'error',
        url: trimmed,
        message: `Failed to access URL: ${err?.message || 'Network error'}`,
      };
    }
  }
}
