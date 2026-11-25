import { CoreTool } from './types';
import { WebSearchService } from '../providers/search';

export function createWebSearchTool(searchService: WebSearchService): CoreTool {

  return {
    name: 'web_search',
    description:
      'Search the web for real-time facts, encyclopedic knowledge, people, places, or current information.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search keywords or topic query string to look up.',
        },
      },
      required: ['query'],
    },
    ownerOnly: false,
    operationalDirective:
      'Zero-Tolerance URL Fabrication: You are strictly forbidden from inventing, guessing, or synthesizing URLs or URL paths (such as generating fake slugs, UUIDs, or timestamps). You may ONLY output a URL if that exact URL was returned verbatim in the output of a search or webpage reading tool.',
    execute: async (params) => {
      return await searchService.search(params.query);
    },
  };
}
