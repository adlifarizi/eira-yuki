export { DEFAULT_DESKTOP_USER_AGENT } from '../constants';

/** Default inactivity timeout in milliseconds before closing the idle headless browser. */
export const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/** Default maximum character length for extracted webpage text content. */
export const MAX_EXTRACTED_CONTENT_CHARS = 9000;

/** Maximum character length allocated to JSON-LD structured metadata snippets. */
export const MAX_JSON_LD_CHARS = 1200;

/** Default HTTP fetch timeout in milliseconds for static page and API requests. */
export const DEFAULT_FETCH_TIMEOUT_MS = 6000;

/** Default headless browser navigation timeout in milliseconds. */
export const DEFAULT_RENDER_TIMEOUT_MS = 15_000;

/** Default wait duration in milliseconds after page load for dynamic SPA hydration. */
export const DEFAULT_WAIT_AFTER_LOAD_MS = 1500;

/** Idle window in milliseconds required for network requests to be considered settled. */
export const DEFAULT_NETWORK_IDLE_TIME_MS = 500;

/** Maximum time in milliseconds to wait for network idle before proceeding. */
export const DEFAULT_NETWORK_IDLE_TIMEOUT_MS = 5000;

/** Polling interval in milliseconds used to check whether rendered DOM text has stabilized. */
export const DOM_SETTLE_INTERVAL_MS = 350;

/** Minimum character length required to accept dynamically rendered SPA content. */
export const MIN_DYNAMIC_CONTENT_CHARS = 200;

/**
 * Universal neutral Accept-Language header for web scraping and content inspection.
 *
 * Architectural Invariant:
 * This value is intentionally fixed to `'en-US,en;q=0.9,*;q=0.5'` rather than dynamically
 * reflecting the bot's conversational display locale (`config.bot.locale`, e.g. `'id-ID'`).
 *
 * Rationale:
 * 1. Prevents Unwanted Regional Redirects: Many global websites (e.g. Wikipedia, MDN, technical
 *    documentation portals) automatically redirect requests containing regional languages to
 *    localized sub-paths that may be outdated, stubbed, or missing critical content compared to
 *    the canonical English source.
 * 2. Unbiased Multilingual Research: The companion may be tasked with researching foreign sources
 *    (e.g. Japanese, German, or English sites). An English primary header with wildcard fallback (`*`)
 *    requests the most comprehensive canonical version when available while cleanly accepting native
 *    foreign-language documents without forcing unwanted regional translation proxies.
 */
export const DEFAULT_ACCEPT_LANGUAGE = 'en-US,en;q=0.9,*;q=0.5';
