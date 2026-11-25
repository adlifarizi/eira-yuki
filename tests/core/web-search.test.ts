import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWebSearchTool } from '../../src/core/tools';
import { DuckDuckGoSearchProvider, TavilySearchProvider, WebSearchService } from '../../src/core/providers/search';
import {
  parseDuckDuckGoHtml,
  SearchProvider,
  TavilySearchProvider,
  DuckDuckGoSearchProvider,
  WebSearchService,
} from '../../src/core/providers/search';
import { IncomingMessage } from '../../src/core/types';

describe('WebSearchTool & Providers', () => {
  const webSearchTool = createWebSearchTool(
    new WebSearchService([new TavilySearchProvider(), new DuckDuckGoSearchProvider()])
  );
  const originalEnv = process.env;

  const mockMsg: IncomingMessage = {
    id: '1',
    senderId: '123',
    senderName: 'Tester',
    chatId: '123',
    chatType: 'dm',
    role: 'owner',
    text: 'search info',
    timestamp: Date.now(),
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('webSearchTool', () => {
    it('returns empty status for empty or whitespace query', async () => {
      const res1 = await webSearchTool.execute({ query: '' }, mockMsg);
      expect(res1.status).toBe('empty');

      const res2 = await webSearchTool.execute({ query: '   ' }, mockMsg);
      expect(res2.status).toBe('empty');
    });
  });

  describe('WebSearchService provider orchestration', () => {
    it('uses primary provider when available and successful', async () => {
      const primary: SearchProvider = {
        name: 'primary',
        isAvailable: () => true,
        search: vi.fn().mockResolvedValue([
          { title: 'Primary Title', content: 'Primary Content', url: 'https://primary.com' },
        ]),
      };

      const fallback: SearchProvider = {
        name: 'fallback',
        isAvailable: () => true,
        search: vi.fn().mockResolvedValue([]),
      };

      const service = new WebSearchService([primary, fallback]);
      const res = await service.search('test query');

      expect(res.status).toBe('success');
      expect(res.source).toBe('primary');
      expect(res.results).toHaveLength(1);
      expect(primary.search).toHaveBeenCalledWith('test query', 3);
      expect(fallback.search).not.toHaveBeenCalled();
    });

    it('falls back to secondary provider when primary fails', async () => {
      const primary: SearchProvider = {
        name: 'primary',
        isAvailable: () => true,
        search: vi.fn().mockRejectedValue(new Error('Rate limited')),
      };

      const fallback: SearchProvider = {
        name: 'fallback',
        isAvailable: () => true,
        search: vi.fn().mockResolvedValue([
          { title: 'Fallback Title', content: 'Fallback Content', url: 'https://fallback.com' },
        ]),
      };

      const service = new WebSearchService([primary, fallback]);
      const res = await service.search('test query');

      expect(res.status).toBe('success');
      expect(res.source).toBe('fallback');
      expect(res.results?.[0].title).toBe('Fallback Title');
    });

    it('skips providers that are not available', async () => {
      const unavailable: SearchProvider = {
        name: 'unavailable',
        isAvailable: () => false,
        search: vi.fn(),
      };

      const fallback: SearchProvider = {
        name: 'fallback',
        isAvailable: () => true,
        search: vi.fn().mockResolvedValue([
          { title: 'Fallback Title', content: 'Fallback Content', url: 'https://fallback.com' },
        ]),
      };

      const service = new WebSearchService([unavailable, fallback]);
      const res = await service.search('test query');

      expect(unavailable.search).not.toHaveBeenCalled();
      expect(res.status).toBe('success');
      expect(res.source).toBe('fallback');
    });

    it('returns not_found if all providers return empty results without error', async () => {
      const primary: SearchProvider = {
        name: 'primary',
        isAvailable: () => true,
        search: vi.fn().mockResolvedValue([]),
      };

      const service = new WebSearchService([primary]);
      const res = await service.search('nonexistent query');

      expect(res.status).toBe('not_found');
      expect(res.message).toContain('No information found');
    });

    it('returns error if all available providers fail with errors', async () => {
      const p1: SearchProvider = {
        name: 'p1',
        isAvailable: () => true,
        search: vi.fn().mockRejectedValue(new Error('API failure')),
      };
      const p2: SearchProvider = {
        name: 'p2',
        isAvailable: () => true,
        search: vi.fn().mockRejectedValue(new Error('Network error')),
      };

      const service = new WebSearchService([p1, p2]);
      const res = await service.search('query');

      expect(res.status).toBe('error');
      expect(res.message).toContain('p1: API failure');
      expect(res.message).toContain('p2: Network error');
    });

    it('returns error when no providers are available', async () => {
      const service = new WebSearchService([
        {
          name: 'disabled',
          isAvailable: () => false,
          search: vi.fn(),
        },
      ]);

      const res = await service.search('query');
      expect(res.status).toBe('error');
      expect(res.message).toMatch(/No web search providers are configured or available/);
    });
  });

  describe('TavilySearchProvider', () => {
    it('isAvailable returns true only when apiKey is non-empty', () => {
      const provider1 = new TavilySearchProvider();
      expect(provider1.isAvailable()).toBe(false);

      const provider2 = new TavilySearchProvider('   ');
      expect(provider2.isAvailable()).toBe(false);

      const provider3 = new TavilySearchProvider('tvly-secret-key');
      expect(provider3.isAvailable()).toBe(true);
    });

    it('fetches and returns mapped results from Tavily API', async () => {
      const provider = new TavilySearchProvider('tvly-test');

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [
            {
              title: 'Tavily Guide',
              content: 'Tavily is designed for LLMs.',
              url: 'https://docs.tavily.com',
            },
          ],
        }),
      } as any);

      const results = await provider.search('tavily search');
      expect(results).toEqual([
        {
          title: 'Tavily Guide',
          content: 'Tavily is designed for LLMs.',
          url: 'https://docs.tavily.com',
        },
      ]);
    });

    it('throws error when Tavily response is not ok', async () => {
      const provider = new TavilySearchProvider('tvly-test');

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
      } as any);

      await expect(provider.search('query')).rejects.toThrow(/status 401/);
    });
  });

  describe('DuckDuckGoSearchProvider & parseDuckDuckGoHtml', () => {
    it('isAvailable always returns true for zero-config fallback', () => {
      const provider = new DuckDuckGoSearchProvider();
      expect(provider.isAvailable()).toBe(true);
    });

    it('parseDuckDuckGoHtml extracts results, unwraps uddg redirect, and decodes HTML entities', () => {
      const sampleHtml = `
        <div class="result results_links results_links_deep web-result ">
          <div class="links_main links_deep result__body">
            <h2 class="result__title">
              <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.typescriptlang.org%2F&amp;rut=1">TypeScript &amp; JavaScript</a>
            </h2>
            <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.typescriptlang.org%2F">TypeScript adds &quot;types&quot; to JS.</a>
          </div>
        </div>
        <div class="result results_links results_links_deep web-result ">
          <div class="links_main links_deep result__body">
            <h2 class="result__title">
              <a class="result__a" href="https://github.com/microsoft/TypeScript">GitHub - TypeScript</a>
            </h2>
            <a class="result__snippet" href="https://github.com/microsoft/TypeScript">Repository for TypeScript language.</a>
          </div>
        </div>
      `;

      const results = parseDuckDuckGoHtml(sampleHtml, 2);
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        title: 'TypeScript & JavaScript',
        content: 'TypeScript adds "types" to JS.',
        url: 'https://www.typescriptlang.org/',
      });
      expect(results[1]).toEqual({
        title: 'GitHub - TypeScript',
        content: 'Repository for TypeScript language.',
        url: 'https://github.com/microsoft/TypeScript',
      });
    });

    it('parseDuckDuckGoHtml handles empty or unparseable HTML gracefully', () => {
      expect(parseDuckDuckGoHtml('')).toEqual([]);
      expect(parseDuckDuckGoHtml('<div>No results found</div>')).toEqual([]);
    });

    it('DuckDuckGoSearchProvider queries html endpoint and parses results', async () => {
      const provider = new DuckDuckGoSearchProvider();
      const mockHtml = `
        <div class="result results_links">
          <h2 class="result__title">
            <a class="result__a" href="https://example.com/item">Direct Link</a>
          </h2>
          <a class="result__snippet">Snippet text</a>
        </div>
      `;

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => mockHtml,
      } as any);

      const results = await provider.search('test query');
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Direct Link');
      expect(results[0].url).toBe('https://example.com/item');
    });
  });
});
