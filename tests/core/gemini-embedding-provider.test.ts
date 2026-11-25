import { describe, it, expect, vi } from 'vitest';
import { GeminiEmbeddingProvider } from '../../src/core/providers/gemini-embedding-provider';
import pino from 'pino';

const logger = pino({ level: 'silent' });
const mockEmbedContent = vi.fn();

vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: class MockGoogleGenAI {
      models = {
        embedContent: mockEmbedContent,
      };
    },
  };
});

describe('GeminiEmbeddingProvider', () => {
  it('generates embedding values successfully', async () => {
    mockEmbedContent.mockResolvedValueOnce({
      embeddings: [{ values: [0.1, 0.2, 0.3] }],
    });

    const provider = new GeminiEmbeddingProvider('test-api-key', 'gemini-embedding-001', logger);
    const result = await provider.getEmbedding('hello world');

    expect(result).toEqual([0.1, 0.2, 0.3]);
    expect(mockEmbedContent).toHaveBeenCalledWith({
      model: 'gemini-embedding-001',
      contents: 'hello world',
    });
  });

  it('returns empty array when text is empty or blank', async () => {
    const provider = new GeminiEmbeddingProvider('test-api-key', 'gemini-embedding-001', logger);
    const result = await provider.getEmbedding('   ');

    expect(result).toEqual([]);
  });

  it('falls back gracefully to empty array on API error', async () => {
    mockEmbedContent.mockRejectedValueOnce(new Error('API quota exceeded'));

    const provider = new GeminiEmbeddingProvider('test-api-key', 'gemini-embedding-001', logger);
    const result = await provider.getEmbedding('test error');

    expect(result).toEqual([]);
  });

  it('returns empty array when apiKey is empty', async () => {
    const provider = new GeminiEmbeddingProvider('', logger);
    const result = await provider.getEmbedding('test');

    expect(result).toEqual([]);
  });
});
