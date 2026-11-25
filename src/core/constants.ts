/**
 * Canonical Windows desktop Chrome User-Agent string.
 *
 * This specific User-Agent is intentionally chosen to emulate a standard, modern
 * desktop Chrome browser on Windows. Default headless identifiers (e.g. `HeadlessChrome/...`
 * or runtime `undici`/`node-fetch` strings) are frequently flagged and blocked with HTTP 403
 * by modern Web Application Firewalls (Cloudflare, Akamai, AWS WAF, and DuckDuckGo).
 */
export const DEFAULT_DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
