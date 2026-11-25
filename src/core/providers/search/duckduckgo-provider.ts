import { DEFAULT_DESKTOP_USER_AGENT } from '../../constants';
import { SearchProvider, SearchResult } from './types';
import { DEFAULT_SEARCH_TIMEOUT_MS } from './constants';

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function parseDuckDuckGoHtml(html: string, maxResults = 3): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split(/<div\s+class="[^"]*result\s+results_links/gi).slice(1);

  for (const block of blocks) {
    if (results.length >= maxResults) break;

    const titleMatch = block.match(/<a\s+class="result__a"\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const snippetMatch = block.match(/<a\s+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;

    const rawHref = titleMatch[1];
    let resolvedUrl = rawHref;
    try {
      const parsed = new URL(rawHref, 'https://duckduckgo.com');
      const uddg = parsed.searchParams.get('uddg');
      if (uddg) {
        resolvedUrl = decodeURIComponent(uddg);
      }
    } catch {
      // Keep rawHref if parsing fails
    }

    const title = decodeHtmlEntities(titleMatch[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    const content = snippetMatch
      ? decodeHtmlEntities(snippetMatch[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
      : '';

    if (title && resolvedUrl) {
      results.push({
        title,
        content,
        url: resolvedUrl,
      });
    }
  }

  return results;
}

export class DuckDuckGoSearchProvider implements SearchProvider {
  readonly name = 'duckduckgo';

  isAvailable(): boolean {
    return true;
  }

  async search(query: string, maxResults = 3): Promise<SearchResult[]> {
    const body = new URLSearchParams({ q: query }).toString();
    const response = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': DEFAULT_DESKTOP_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      body,
      signal: AbortSignal.timeout(DEFAULT_SEARCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`DuckDuckGo request failed with status ${response.status}`);
    }

    const html = await response.text();
    return parseDuckDuckGoHtml(html, maxResults);
  }
}
