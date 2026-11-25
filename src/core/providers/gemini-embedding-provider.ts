import { GoogleGenAI } from '@google/genai';
import { Logger } from 'pino';
import { EmbeddingProvider } from './types';

/**
 * Official Google Gemini embedding provider adapter conforming to the EmbeddingProvider interface.
 * Isolates the @google/genai SDK for vector embedding generation.
 */
export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'gemini-embedding';
  readonly name = 'Google Gemini Embedding';
  readonly modelName: string;
  private client: GoogleGenAI | null = null;

  constructor(
    apiKey: string,
    modelName: string,
    private logger?: Logger
  ) {
    this.modelName = modelName;
    if (apiKey) {
      this.client = new GoogleGenAI({ apiKey });
    }
  }

  /**
   * Generates an embedding vector for text using the Gemini embedding model.
   * Returns an empty array if client is unconfigured or generation fails.
   */
  async getEmbedding(text: string): Promise<number[]> {
    if (!this.client || !text.trim()) {
      return [];
    }

    try {
      const response = await this.client.models.embedContent({
        model: this.modelName,
        contents: text,
      });

      return response.embeddings?.[0]?.values || [];
    } catch (err) {
      this.logger?.warn(err, 'Failed to generate embedding with Gemini API, falling back');
      return [];
    }
  }
}
