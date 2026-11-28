import { MAX_EXTRACTED_CONTENT_CHARS, MAX_JSON_LD_CHARS } from './constants';

/**
 * Normalizes visible text extracted directly from a rendered browser DOM (`document.body.innerText`).
 */
export function normalizeRenderedText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_EXTRACTED_CONTENT_CHARS);
}

export function cleanHtmlToText(
  html: string,
  baseUrl?: string
): { title?: string; description?: string; body: string } {
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : undefined;

  const ogDescMatch = html.match(
    /<meta[^>]+(?:property|name)=["'](?:og:description|description)["'][^>]+content=["']([^"']+)["']/i
  );
  const description = ogDescMatch ? ogDescMatch[1].trim() : undefined;

  const jsonLdMatches = html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );
  const jsonLdSnippets: string[] = [];
  for (const match of jsonLdMatches) {
    try {
      const parsed = JSON.parse(match[1]);
      const obj = Array.isArray(parsed) ? parsed[0] : parsed;
      if (obj && typeof obj === 'object') {
        const headline = obj.headline || obj.name || obj.title;
        const desc = typeof obj.description === 'string' ? obj.description.replace(/<\/?[^>]+(>|$)/g, ' ') : '';
        const bodyText = typeof obj.articleBody === 'string' ? obj.articleBody.replace(/<\/?[^>]+(>|$)/g, ' ') : '';

        if (headline || desc || bodyText) {
          jsonLdSnippets.push(
            `[Structured Metadata]: ${headline ? `Title: ${headline}. ` : ''}${desc ? `Description: ${desc.slice(0, 400)}. ` : ''}${bodyText ? `Body: ${bodyText.slice(0, 600)}` : ''}`
          );
        }
      }
    } catch {
      // Ignore malformed JSON-LD
    }
  }

  let cleaned = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, ' ')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ')
    .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, ' ')
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, ' ')
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, ' ')
    .replace(/<aside\b[^<]*(?:(?!<\/aside>)<[^<]*)*<\/aside>/gi, ' ')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, ' ');

  cleaned = cleaned.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, innerContent) => {
    const rawHref = href?.trim() || '';
    if (
      !rawHref ||
      rawHref.startsWith('#') ||
      rawHref.toLowerCase().startsWith('javascript:') ||
      rawHref.toLowerCase().startsWith('mailto:') ||
      rawHref.toLowerCase().startsWith('tel:')
    ) {
      return innerContent;
    }

    const cleanText = innerContent.replace(/<\/?[^>]+(>|$)/g, ' ').replace(/\s+/g, ' ').trim();
    if (!cleanText || cleanText.length < 2) {
      return '';
    }

    let resolvedUrl = rawHref;
    if (baseUrl) {
      try {
        resolvedUrl = new URL(rawHref, baseUrl).href;
      } catch {
        return cleanText;
      }
    }

    if (!resolvedUrl.startsWith('http://') && !resolvedUrl.startsWith('https://')) {
      return cleanText;
    }

    return ` [${cleanText.slice(0, 100)}](${resolvedUrl}) `;
  });

  cleaned = cleaned.replace(/<\/?[^>]+(>|$)/g, ' ');

  cleaned = cleaned
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  let combined = '';
  if (jsonLdSnippets.length > 0) {
    combined += jsonLdSnippets.join('\n').slice(0, MAX_JSON_LD_CHARS) + '\n\n';
  }
  combined += cleaned;

  return {
    title,
    description,
    body: combined.slice(0, MAX_EXTRACTED_CONTENT_CHARS),
  };
}

export function isSpaOrDynamicPage(html: string, bodyText: string): boolean {
  const cleanBody = bodyText.replace(/\s+/g, ' ').trim();

  if (html.length > 1000 && cleanBody.length < 350) {
    return true;
  }

  if (html.length > 40000 && cleanBody.length < 1200) {
    return true;
  }

  const hasEmptySpaRoot =
    /<div\s+id=["'](?:root|app|__next)["']\s*>\s*<\/div>/i.test(html) ||
    /<(?:app-root|main-app)\s*>\s*<\/(?:app-root|main-app)>/i.test(html);
  if (hasEmptySpaRoot && cleanBody.length < 600) {
    return true;
  }

  const hasJsRequiredNotice =
    /<noscript[^>]*>[\s\S]*?(?:enable|require|activate|need)\s+javascript[\s\S]*?<\/noscript>/i.test(
      html
    );
  if (hasJsRequiredNotice && cleanBody.length < 600) {
    return true;
  }

  const hasAriaLoadingIndicator =
    /aria-busy=["']true["']/i.test(html) || /role=["']progressbar["']/i.test(html);
  if (hasAriaLoadingIndicator && cleanBody.length < 1500) {
    return true;
  }

  const hasSpaFrameworkMarkers =
    /<script[^>]+type=["']module["']/i.test(html) ||
    /__NEXT_DATA__|data-reactroot|ng-version|data-v-/i.test(html);
  if (hasSpaFrameworkMarkers && html.length > 20000 && cleanBody.length < 1800) {
    return true;
  }

  return false;
}
