import { WebpageContentResult } from './types';
import { DEFAULT_FETCH_TIMEOUT_MS, MAX_EXTRACTED_CONTENT_CHARS } from './constants';

export async function extractWithTavily(url: string, apiKey?: string): Promise<WebpageContentResult | null> {
  const tavilyKey = apiKey?.trim();
  if (!tavilyKey) return null;

  try {
    const res = await fetch('https://api.tavily.com/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: tavilyKey,
        urls: [url],
      }),
      signal: AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS),
    });

    if (res.ok) {
      const data = await res.json();
      const item = data?.results?.[0];
      if (item && item.raw_content) {
        return {
          status: 'success',
          source: 'tavily_extract',
          url,
          content: item.raw_content.slice(0, MAX_EXTRACTED_CONTENT_CHARS),
        };
      }
    }
  } catch {
    // Ignore fallback failure
  }

  return null;
}
