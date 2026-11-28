import { BrowserManager, RenderResult } from './browser-manager';
import { DEFAULT_ACCEPT_LANGUAGE, DEFAULT_DESKTOP_USER_AGENT, DEFAULT_FETCH_TIMEOUT_MS, DEFAULT_RENDER_TIMEOUT_MS, MAX_EXTRACTED_CONTENT_CHARS, MIN_DYNAMIC_CONTENT_CHARS } from './constants';
import { cleanHtmlToText, isSpaOrDynamicPage, normalizeRenderedText } from './html-cleaner';
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

  private buildRenderedResult(
    rendered: RenderResult,
    parsedUrl: URL,
    trimmedUrl: string,
    fallbackTitle?: string,
    fallbackDescription?: string
  ): WebpageContentResult {
    if (rendered.finalUrl) {
      try {
        if (isPrivateIpOrHost(new URL(rendered.finalUrl).hostname)) {
          return {
            status: 'blocked',
            url: trimmedUrl,
            message: 'Access to private or local network addresses is restricted.',
          };
        }
      } catch {
        // Ignore malformed finalUrl
      }
    }

    const cleaned = cleanHtmlToText(rendered.html, parsedUrl.toString());
    const visibleText = rendered.text ? normalizeRenderedText(rendered.text) : '';
    // Prefer visible DOM innerText when substantive so header/aside widgets aren't stripped by static HTML regexes.
    const content =
      visibleText.length >= MIN_DYNAMIC_CONTENT_CHARS || visibleText.length >= cleaned.body.length
        ? visibleText
        : cleaned.body;

    return {
      status: 'success',
      url: trimmedUrl,
      title: cleaned.title || rendered.title || fallbackTitle || 'No title',
      description: cleaned.description || fallbackDescription,
      content: content.slice(0, MAX_EXTRACTED_CONTENT_CHARS),
      source: 'headless_browser',
    };
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

    if (options?.forceBrowser) {
      if (!this.browserManager.isAvailable()) {
        return {
          status: 'error',
          url: trimmed,
          message: 'Headless browser rendering was requested, but no Chrome/Chromium executable is available.',
        };
      }

      const rendered = await this.browserManager.renderPage(parsedUrl.toString(), {
        timeoutMs: options.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS,
      });
      if (rendered?.html || rendered?.text) {
        return this.buildRenderedResult(rendered, parsedUrl, trimmed);
      }

      return {
        status: 'error',
        url: trimmed,
        message: 'Headless browser rendering failed or timed out for this page.',
      };
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
        if (rendered?.html || rendered?.text) {
          const renderedResult = this.buildRenderedResult(
            rendered,
            parsedUrl,
            trimmed,
            title,
            description
          );
          if (renderedResult.status !== 'success') {
            return renderedResult;
          }
          const renderedLength = renderedResult.content?.length ?? 0;
          if (renderedLength >= body.length || renderedLength > MIN_DYNAMIC_CONTENT_CHARS) {
            return renderedResult;
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
