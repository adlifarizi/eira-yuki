import { SearchProvider, SearchResult } from './types';

export interface WebSearchResult {
  status: 'success' | 'empty' | 'not_found' | 'error';
  source?: string;
  results?: SearchResult[];
  message?: string;
}

export class WebSearchService {
  constructor(private readonly providers: SearchProvider[]) {}

  async search(query?: string, maxResults = 3): Promise<WebSearchResult> {
    const trimmed = query?.trim();
    if (!trimmed) {
      return { status: 'empty', message: 'Search query cannot be empty.' };
    }

    const availableProviders = this.providers.filter((p) => p.isAvailable());
    if (availableProviders.length === 0) {
      return {
        status: 'error',
        message: 'No web search providers are configured or available.',
      };
    }

    const errors: string[] = [];
    for (const provider of availableProviders) {
      try {
        const results = await provider.search(trimmed, maxResults);
        if (results.length > 0) {
          return {
            status: 'success',
            source: provider.name,
            results,
          };
        }
      } catch (err: any) {
        errors.push(`${provider.name}: ${err?.message || 'Request failed'}`);
      }
    }

    if (errors.length === availableProviders.length) {
      return {
        status: 'error',
        message: `Web search failed: ${errors.join('; ')}`,
      };
    }

    return {
      status: 'not_found',
      message: `No information found for "${trimmed}".`,
    };
  }
}
