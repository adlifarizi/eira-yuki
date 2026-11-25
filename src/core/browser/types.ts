export interface WebpageContentResult {
  status: 'success' | 'not_found' | 'blocked' | 'timeout' | 'error';
  url: string;
  title?: string;
  description?: string;
  content?: string;
  statusCode?: number;
  message?: string;
  source?: string;
}

export interface FetchWebpageOptions {
  forceBrowser?: boolean;
  timeoutMs?: number;
}
