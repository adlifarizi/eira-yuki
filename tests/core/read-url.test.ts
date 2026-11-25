import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createReadUrlTool } from '../../src/core/tools';
import { PageFetcher } from '../../src/core/browser';
import { cleanHtmlToText, isSpaOrDynamicPage } from '../../src/core/browser/html-cleaner';
import { BrowserManager } from '../../src/core/browser/browser-manager';
import { IncomingMessage } from '../../src/core/types';

describe('readUrlTool', () => {
  const readUrlTool = createReadUrlTool(new PageFetcher());
  const mockContext: IncomingMessage = {
    id: 'msg-1',
    senderId: '123',
    senderName: 'Adli',
    chatId: '123',
    chatType: 'dm',
    role: 'owner',
    text: 'read url',
    timestamp: Date.now(),
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects invalid and non-http/https URLs', async () => {
    const emptyResult = await readUrlTool.execute({ url: '' }, mockContext);
    expect(emptyResult.status).toBe('error');

    const invalidResult = await readUrlTool.execute({ url: 'not-a-valid-url' }, mockContext);
    expect(invalidResult.status).toBe('error');

    const fileResult = await readUrlTool.execute({ url: 'file:///etc/passwd' }, mockContext);
    expect(fileResult.status).toBe('error');
    expect(fileResult.message).toMatch(/Only HTTP and HTTPS/);
  });

  it('blocks SSRF access to private IP ranges and localhost', async () => {
    const localhostResult = await readUrlTool.execute({ url: 'http://localhost:8080' }, mockContext);
    expect(localhostResult.status).toBe('error');
    expect(localhostResult.message).toMatch(/restricted/);

    const ipResult = await readUrlTool.execute({ url: 'http://127.0.0.1/admin' }, mockContext);
    expect(ipResult.status).toBe('error');

    const privateLanResult = await readUrlTool.execute({ url: 'http://192.168.1.1/setup' }, mockContext);
    expect(privateLanResult.status).toBe('error');

    const private10Result = await readUrlTool.execute({ url: 'http://10.0.0.5/' }, mockContext);
    expect(private10Result.status).toBe('error');
  });

  it('cleanHtmlToText extracts title, meta description, and strips unwanted tags', () => {
    const sampleHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Senior Backend Engineer - Tech Corp</title>
          <meta property="og:description" content="We are looking for an experienced engineer." />
          <style>body { color: red; }</style>
          <script>alert("tracker");</script>
        </head>
        <body>
          <nav>Home | Jobs | About</nav>
          <header>Company Header</header>
          <main>
            <h1>Job Requirements</h1>
            <p>Proficiency in TypeScript, Node.js, and SQLite required.</p>
          </main>
          <footer>Copyright 2026</footer>
        </body>
      </html>
    `;

    const cleaned = cleanHtmlToText(sampleHtml);
    expect(cleaned.title).toBe('Senior Backend Engineer - Tech Corp');
    expect(cleaned.description).toBe('We are looking for an experienced engineer.');
    expect(cleaned.body).toContain('Job Requirements Proficiency in TypeScript, Node.js, and SQLite required.');
    expect(cleaned.body).not.toContain('alert("tracker")');
    expect(cleaned.body).not.toContain('Company Header');
    expect(cleaned.body).not.toContain('Copyright 2026');
  });

  it('cleanHtmlToText converts valid anchors to markdown with resolved baseUrl and filters junk', () => {
    const htmlWithLinks = `
      <div>
        <nav><a href="/menu">Menu Link</a></nav>
        <p>Check this <a href="/jobs/123">Backend Developer Role</a> for details.</p>
        <p>External <a href="https://example.com/spec">API Docs</a> and <a href="#details">Section</a>.</p>
        <aside><a href="/ad">Ad Link</a></aside>
      </div>
    `;

    const cleaned = cleanHtmlToText(htmlWithLinks, 'https://careers.company.com/portal');
    expect(cleaned.body).toContain('[Backend Developer Role](https://careers.company.com/jobs/123)');
    expect(cleaned.body).toContain('[API Docs](https://example.com/spec)');
    expect(cleaned.body).not.toContain('Menu Link');
    expect(cleaned.body).not.toContain('Ad Link');
    expect(cleaned.body).not.toContain('[Section]');
  });

  it('fetches and parses generic webpage successfully', async () => {
    const mockHtml = `
      <html>
        <head><title>Understanding Distributed Systems</title></head>
        <body>
          <article>
            <p>Distributed systems are challenging because nodes can fail independently.</p>
          </article>
        </body>
      </html>
    `;

    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => mockHtml,
    } as any);

    const result = await readUrlTool.execute(
      { url: 'https://example.com/articles/distributed-systems' },
      mockContext
    );

    expect(result.status).toBe('success');
    expect(result.title).toBe('Understanding Distributed Systems');
    expect(result.content).toContain('Distributed systems are challenging');
  });

  it('handles 404 response cleanly as not found', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 404,
      ok: false,
    } as any);

    const result = await readUrlTool.execute(
      { url: 'https://example.com/non-existent-page' },
      mockContext
    );

    expect(result.status).toBe('not_found');
    expect(result.message).toMatch(/404/);
  });

  it('handles 403 bot blocking gracefully', async () => {
    delete process.env.TAVILY_API_KEY;
    global.fetch = vi.fn().mockResolvedValue({
      status: 403,
      ok: false,
    } as any);

    const result = await readUrlTool.execute(
      { url: 'https://example.com/protected-page' },
      mockContext
    );

    expect(result.status).toBe('blocked');
    expect(result.statusCode).toBe(403);
  });

  it('handles timeout error gracefully without crashing', async () => {
    delete process.env.TAVILY_API_KEY;
    const timeoutErr = new Error('The operation was aborted due to timeout');
    timeoutErr.name = 'TimeoutError';

    global.fetch = vi.fn().mockRejectedValue(timeoutErr);

    const result = await readUrlTool.execute(
      { url: 'https://slow-site.com/job' },
      mockContext
    );

    expect(result.status).toBe('timeout');
    expect(result.message).toMatch(/timeout/i);
  });

  describe('isSpaOrDynamicPage', () => {
    it('detects empty SPA root containers as dynamic pages', () => {
      const craHtml = '<html><head><title>App</title></head><body><div id="root"></div></body></html>';
      expect(isSpaOrDynamicPage(craHtml, '')).toBe(true);

      const vueHtml = '<html><head><title>Vue</title></head><body><div id="app"></div></body></html>';
      expect(isSpaOrDynamicPage(vueHtml, '')).toBe(true);

      const angularHtml = '<html><head><title>Angular</title></head><body><app-root></app-root></body></html>';
      expect(isSpaOrDynamicPage(angularHtml, '')).toBe(true);
    });

    it('detects large JS bundle with minimal visible text as SPA', () => {
      const heavyJsHtml = '<html><head><script>' + 'x'.repeat(45000) + '</script></head><body><div>Footer</div></body></html>';
      expect(isSpaOrDynamicPage(heavyJsHtml, 'Footer')).toBe(true);
    });

    it('detects noscript javascript requirement notices', () => {
      const noscriptHtml = '<html><body><noscript>You need to enable JavaScript to run this app.</noscript></body></html>';
      expect(isSpaOrDynamicPage(noscriptHtml, 'Enable JS')).toBe(true);
    });

    it('identifies standard static HTML pages as non-SPA', () => {
      const normalHtml = '<html><head><title>News</title></head><body>' + '<p>Article paragraph text here.</p>'.repeat(30) + '</body></html>';
      const cleanBody = 'Article paragraph text here. '.repeat(30);
      expect(isSpaOrDynamicPage(normalHtml, cleanBody)).toBe(false);
    });
  });

  describe('headless browser fallback', () => {
    it('automatically invokes headless browser when static fetch returns SPA skeleton', async () => {
      const spaSkeleton = '<!DOCTYPE html><html><head><title>SPA</title></head><body><div id="root"></div></body></html>';
      global.fetch = vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        text: async () => spaSkeleton,
      } as any);

      vi.spyOn(BrowserManager.prototype, 'isAvailable').mockReturnValue(true);
      vi.spyOn(BrowserManager.prototype, 'renderPage').mockResolvedValue({
        title: 'Hydrated React Dashboard',
        html: '<html><head><title>Hydrated React Dashboard</title></head><body><div id="root"><h1>Live Analytics</h1><p>Active Users: 1,420</p></div></body></html>',
      });

      const result = await readUrlTool.execute(
        { url: 'https://app.example.com/dashboard' },
        mockContext
      );

      expect(result.status).toBe('success');
      expect(result.source).toBe('headless_browser');
      expect(result.title).toBe('Hydrated React Dashboard');
      expect(result.content).toContain('Live Analytics Active Users: 1,420');
    });

    it('forces browser rendering when renderJs is explicitly true', async () => {
      vi.spyOn(BrowserManager.prototype, 'isAvailable').mockReturnValue(true);
      const renderSpy = vi.spyOn(BrowserManager.prototype, 'renderPage').mockResolvedValue({
        title: 'Rendered Stream',
        html: '<html><head><title>Rendered Stream</title></head><body><p>Live stream viewer count: 50,000</p></body></html>',
      });

      const result = await readUrlTool.execute(
        { url: 'https://example.com/live', renderJs: true },
        mockContext
      );

      expect(renderSpy).toHaveBeenCalledWith('https://example.com/live', expect.any(Object));
      expect(result.status).toBe('success');
      expect(result.source).toBe('headless_browser');
      expect(result.content).toContain('Live stream viewer count: 50,000');
    });
  });
});
