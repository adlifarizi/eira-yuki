export interface SearchResult {
  title: string;
  content: string;
  url: string;
}

export interface SearchProvider {
  readonly name: string;
  isAvailable(): boolean;
  search(query: string, maxResults?: number): Promise<SearchResult[]>;
}
