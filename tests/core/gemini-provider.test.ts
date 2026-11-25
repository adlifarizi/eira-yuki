import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GeminiProvider,
  GeminiProviderOptions,
  normalizeGeminiContents,
} from '../../src/core/providers/gemini-provider';
import pino from 'pino';

const logger = pino({ level: 'silent' });

const mockGenerateContent = vi.fn();

vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: class MockGoogleGenAI {
      models = {
        generateContent: mockGenerateContent,
      };
    },
  };
});

describe('GeminiProvider', () => {
  const providerOptions: GeminiProviderOptions = {
    apiKey: 'test_key',
    modelName: 'gemini-3.1-flash-lite',
    temperature: 0.7,
    maxOutputTokens: 500,
    logger,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generates content and parses text & function calls correctly', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      text: '',
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: 'send_sticker',
                  args: { tag: 'smug' },
                },
              },
            ],
          },
        },
      ],
    });

    const provider = new GeminiProvider(providerOptions);
    const result = await provider.generate({
      systemInstruction: 'Test Instruction',
      prompt: 'kirim stiker dong',
      tools: [
        {
          name: 'send_sticker',
          description: 'Send a sticker',
          parameters: { type: 'object' },
        },
      ],
    });

    expect(mockGenerateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-3.1-flash-lite',
        contents: [
          {
            role: 'user',
            parts: [{ text: 'kirim stiker dong' }],
          },
        ],
        config: expect.objectContaining({
          systemInstruction: 'Test Instruction',
        }),
      })
    );

    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls?.[0].name).toBe('send_sticker');
    expect(result.toolCalls?.[0].args).toEqual({ tag: 'smug' });
  });

  it('parses Google Search grounding sources from metadata', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      text: 'Menurut berita terbaru...',
      candidates: [
        {
          content: { parts: [{ text: 'Menurut berita terbaru...' }] },
          groundingMetadata: {
            groundingChunks: [
              { web: { title: 'Kompas', uri: 'https://kompas.com' } },
            ],
          },
        },
      ],
    });

    const provider = new GeminiProvider(providerOptions);
    const result = await provider.generate({
      systemInstruction: 'Test',
      prompt: 'berita hari ini',
      enableSearchGrounding: true,
    });

    expect(result.sources).toBeDefined();
    expect(result.sources?.[0].title).toBe('Kompas');
    expect(result.sources?.[0].url).toBe('https://kompas.com');
  });

  it('continues generation with tool results and returns final text', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      text: 'Sticker has been sent.',
      candidates: [
        {
          content: { parts: [{ text: 'Sticker has been sent.' }] },
        },
      ],
    });

    const provider = new GeminiProvider(providerOptions);
    const result = await provider.continueWithToolResults({
      originalRequest: {
        systemInstruction: 'Test',
        prompt: 'send sticker',
      },
      toolCalls: [{ name: 'send_sticker', args: { tag: 'smug' } }],
      toolResults: [{ toolName: 'send_sticker', result: { status: 'success' } }],
    });

    expect(mockGenerateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        contents: expect.arrayContaining([
          expect.objectContaining({ role: 'user' }),
          expect.objectContaining({
            role: 'model',
            parts: [{ functionCall: { name: 'send_sticker', args: { tag: 'smug' } } }],
          }),
          expect.objectContaining({
            role: 'user',
            parts: [{ functionResponse: { name: 'send_sticker', response: { status: 'success' } } }],
          }),
        ]),
      })
    );

    expect(result.text).toBe('Sticker has been sent.');
  });

  it('preserves and echoes thoughtSignature on functionCall parts', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      text: '',
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: 'send_sticker',
                  args: { tag: 'smug' },
                },
                thoughtSignature: 'sig_abc123',
              },
            ],
          },
        },
      ],
    });

    const provider = new GeminiProvider(providerOptions);
    const firstResult = await provider.generate({
      systemInstruction: 'Test',
      prompt: 'kirim stiker',
    });

    expect(firstResult.toolCalls?.[0].thoughtSignature).toBe('sig_abc123');

    mockGenerateContent.mockResolvedValueOnce({
      text: 'Done.',
      candidates: [{ content: { parts: [{ text: 'Done.' }] } }],
    });

    await provider.continueWithToolResults({
      originalRequest: {
        systemInstruction: 'Test',
        prompt: 'kirim stiker',
      },
      toolCalls: firstResult.toolCalls!,
      toolResults: [{ toolName: 'send_sticker', result: { status: 'success' } }],
    });

    expect(mockGenerateContent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        contents: expect.arrayContaining([
          expect.objectContaining({
            role: 'model',
            parts: [
              {
                functionCall: { name: 'send_sticker', args: { tag: 'smug' } },
                thoughtSignature: 'sig_abc123',
              },
            ],
          }),
        ]),
      })
    );
  });

  it('supports continuation options with model override and existing contents', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      text: 'Final chained result.',
      candidates: [
        {
          content: { parts: [{ text: 'Final chained result.' }] },
        },
      ],
    });

    const provider = new GeminiProvider(providerOptions);
    const existing = [
      { role: 'user', parts: [{ text: 'initial prompt' }] },
      { role: 'model', parts: [{ text: 'hop 1' }] },
    ];

    const result = await provider.continueWithToolResults({
      originalRequest: {
        systemInstruction: 'Test',
        prompt: 'initial prompt',
      },
      toolCalls: [{ name: 'web_search', args: { query: 'subquery' } }],
      toolResults: [{ toolName: 'web_search', result: { status: 'success' } }],
      modelName: 'gemini-3.5-flash-lite',
      sessionState: { contents: existing },
    });

    expect(mockGenerateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-3.5-flash-lite',
        contents: expect.arrayContaining([
          expect.objectContaining({ role: 'user' }),
          expect.objectContaining({
            role: 'user',
            parts: [{ functionResponse: { name: 'web_search', response: { status: 'success' } } }],
          }),
        ]),
      })
    );

    expect(result.text).toBe('Final chained result.');
    expect(result.sessionState).toBeDefined();
  });

  describe('normalizeGeminiContents', () => {
    it('drops leading model turn and merges consecutive same roles', () => {
      const raw = [
        { role: 'model', parts: [{ text: 'stray model turn' }] },
        { role: 'user', parts: [{ text: 'hello' }] },
        { role: 'user', parts: [{ text: 'world' }] },
        { role: 'model', parts: [{ text: 'hi' }] },
        { role: 'model', parts: [{ text: 'there' }] },
        { role: 'user', parts: [{ text: 'bye' }] },
      ];

      const normalized = normalizeGeminiContents(raw);

      expect(normalized).toHaveLength(3);
      expect(normalized[0].role).toBe('user');
      expect(normalized[0].parts).toEqual([{ text: 'hello' }, { text: 'world' }]);
      expect(normalized[1].role).toBe('model');
      expect(normalized[1].parts).toEqual([{ text: 'hi' }, { text: 'there' }]);
      expect(normalized[2].role).toBe('user');
      expect(normalized[2].parts).toEqual([{ text: 'bye' }]);
    });
  });
});
