import { CoreTool } from './types';
import { PageFetcher } from '../browser';

export function createReadUrlTool(fetcher: PageFetcher): CoreTool {

  return {
    name: 'read_url',
    description:
      'Fetch and inspect the real live text content of a webpage URL. Automatically executes client-side JavaScript for dynamic Single-Page Applications (SPAs) and dynamic sites.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The exact HTTP or HTTPS URL to fetch and read.',
        },
        renderJs: {
          type: 'boolean',
          description:
            'Optional: explicitly force headless browser rendering to execute client-side JavaScript. Defaults to automatic detection.',
        },
      },
      required: ['url'],
    },
    ownerOnly: false,
    operationalDirective:
      'Multi-Step Verification with read_url: When conducting research, finding articles, checking vacancies, or verifying factual claims from the web, do not rely solely on brief search snippets. Call "read_url" on candidate URLs to inspect the real, live webpage content, verify that the page is active and not removed/404, and extract exact details before finalizing your answer.',
    execute: async (params) => {
      return await fetcher.fetch(params.url, {
        forceBrowser: params.renderJs,
      });
    },
  };
}
