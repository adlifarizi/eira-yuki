import { SearchProvider, SearchResult } from './types';
import { DEFAULT_SEARCH_TIMEOUT_MS } from './constants';

export class TavilySearchProvider implements SearchProvider {
  readonly name = 'tavily';

  constructor(private apiKey?: string) {}

  isAvailable(): boolean {
    return Boolean(this.apiKey?.trim());
  }

  async search(query: string, maxResults = 3): Promise<SearchResult[]> {
    const key = this.apiKey?.trim();
    if (!key) {
      return [];
    }

    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        query,
        max_results: maxResults,
      }),
      signal: AbortSignal.timeout(DEFAULT_SEARCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Tavily search request failed with status ${response.status}`);
    }

    const data = await response.json();
    if (!Array.isArray(data?.results)) {
      return [];
    }

    return data.results.map((r: any) => ({
      title: String(r.title || ''),
      content: String(r.content || ''),
      url: String(r.url || ''),
    }));
  }
}
