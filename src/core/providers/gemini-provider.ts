import { Content, GenerateContentResponse, GoogleGenAI, Part, Tool } from '@google/genai';
import { Logger } from 'pino';
import { ToolCall } from '../tools/types';
import { LLMProvider, LLMRequest, LLMResult, ContinuationRequest, ContinuationResult } from './types';

/**
 * Configuration options for initializing a GeminiProvider instance.
 * Completely decouples the provider from the global application Config schema.
 */
export interface GeminiProviderOptions {
  apiKey: string;
  modelName: string;
  temperature?: number;
  maxOutputTokens?: number;
  logger?: Logger;
}

/**
 * Internal session state encapsulating the conversation contents for the Gemini SDK.
 */
interface GeminiSessionState {
  contents: Content[];
}

/**
 * Normalizes Gemini contents to strictly enforce alternating user-model-user turns.
 * Merges adjacent turns with the same role and ensures the sequence begins with 'user'.
 */
export function normalizeGeminiContents(rawContents: Content[]): Content[] {
  if (!rawContents || rawContents.length === 0) return [];

  const normalized: Content[] = [];

  for (const turn of rawContents) {
    if (!turn || !turn.parts || turn.parts.length === 0) continue;

    if (normalized.length === 0 && turn.role !== 'user') {
      continue;
    }

    const last = normalized[normalized.length - 1];
    if (last && last.role === turn.role) {
      last.parts = [...(last.parts || []), ...turn.parts];
    } else {
      normalized.push({
        role: turn.role,
        parts: [...turn.parts],
      });
    }
  }

  return normalized;
}

/**
 * Official Google Gemini provider adapter conforming to the LLMProvider interface.
 * Isolates the @google/genai SDK, handles role mapping ('assistant' <-> 'model'),
 * parses function calls, and maps grounding search citations.
 */
export class GeminiProvider implements LLMProvider {
  readonly id = 'gemini';
  readonly name = 'Google Gemini';
  readonly modelName: string;

  private client: GoogleGenAI;
  private logger?: Logger;

  constructor(private options: GeminiProviderOptions) {
    this.client = new GoogleGenAI({ apiKey: options.apiKey });
    this.modelName = options.modelName;
    this.logger = options.logger;
  }

  /**
   * Generates a single turn or initial tool calls using the Gemini models API.
   */
  async generate(request: LLMRequest): Promise<LLMResult> {
    const tools = this.buildGeminiTools(request);
    const contents = this.buildInitialContents(request);
    const targetModel = request.modelName || this.modelName;

    try {
      this.logger?.debug(
        `[GeminiProvider] Calling ${targetModel} (Tools: ${tools.length}, Grounding: ${!!request.enableSearchGrounding})`
      );

      const response = await this.client.models.generateContent({
        model: targetModel,
        contents,
        config: {
          systemInstruction: request.systemInstruction,
          tools: tools.length > 0 ? tools : undefined,
          temperature: this.options.temperature,
          maxOutputTokens: this.options.maxOutputTokens,
        },
      });

      return this.parseGeminiResponse(response);
    } catch (error) {
      this.logger?.error(error, `[GeminiProvider] Generation failed for model ${targetModel}`);
      throw error;
    }
  }

  /**
   * Continues a multi-hop turn by supplying executed tool outputs back to the Gemini model.
   * Maps tool outputs to Gemini user turn functionResponses.
   */
  async continueWithToolResults(request: ContinuationRequest): Promise<ContinuationResult> {
    const tools = this.buildGeminiTools(request.originalRequest);

    let contents: Content[];
    const state = request.sessionState as GeminiSessionState | undefined;

    if (state?.contents && state.contents.length > 0) {
      contents = [...state.contents];
    } else {
      contents = this.buildInitialContents(request.originalRequest);
    }

    contents.push({
      role: 'model',
      parts: request.toolCalls.map((fc) => ({
        functionCall: {
          name: fc.name,
          args: fc.args,
        },
        ...(fc.thoughtSignature ? { thoughtSignature: fc.thoughtSignature } : {}),
      })),
    });

    contents.push({
      role: 'user',
      parts: request.toolResults.map((tr) => ({
        functionResponse: {
          name: tr.toolName,
          response:
            typeof tr.result === 'object' && tr.result !== null ? tr.result : { output: tr.result },
        },
      })),
    });

    const targetModel = request.modelName || this.modelName;

    try {
      this.logger?.debug(
        `[GeminiProvider] Sending tool results to ${targetModel} for continuation`
      );

      const response = await this.client.models.generateContent({
        model: targetModel,
        contents,
        config: {
          systemInstruction: request.originalRequest.systemInstruction,
          tools: tools.length > 0 ? tools : undefined,
          temperature: this.options.temperature,
          maxOutputTokens: this.options.maxOutputTokens,
        },
      });

      const parsed = this.parseGeminiResponse(response);
      return {
        ...parsed,
        sessionState: { contents } as GeminiSessionState,
      };
    } catch (error) {
      this.logger?.error(error, `[GeminiProvider] Tool continuation failed on model ${targetModel}`);
      throw error;
    }
  }

  private buildGeminiTools(request: LLMRequest): Tool[] {
    const tools: Tool[] = [];
    if (request.tools && request.tools.length > 0) {
      tools.push({
        functionDeclarations: request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters as any,
        })),
      });
    }
    if (request.enableSearchGrounding) {
      tools.push({ googleSearch: {} });
    }
    return tools;
  }

  private buildInitialContents(request: LLMRequest): Content[] {
    const userParts: Part[] = [];
    if (request.images && request.images.length > 0) {
      for (const img of request.images) {
        const base64Data = Buffer.isBuffer(img.data) ? img.data.toString('base64') : img.data;
        userParts.push({
          inlineData: {
            data: base64Data,
            mimeType: img.mimeType,
          },
        });
      }
    }

    if (request.prompt) {
      userParts.push({ text: request.prompt });
    }

    const rawContents: Content[] = [];

    if (request.conversationHistory && request.conversationHistory.length > 0) {
      for (const turn of request.conversationHistory) {
        rawContents.push({
          role: turn.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: turn.content }],
        });
      }
    }

    rawContents.push({
      role: 'user',
      parts: userParts,
    });

    return normalizeGeminiContents(rawContents);
  }

  private parseGeminiResponse(response: GenerateContentResponse): LLMResult {
    const candidate = response.candidates?.[0];

    let text = '';
    if (candidate?.content?.parts) {
      for (const part of candidate.content.parts) {
        if (part.text && !part.thought) {
          text += part.text;
        }
      }
    } else if (typeof response.text === 'string') {
      text = response.text;
    }

    const toolCalls: ToolCall[] = [];
    if (candidate?.content?.parts) {
      for (const part of candidate.content.parts) {
        if (part.functionCall) {
          toolCalls.push({
            name: part.functionCall.name || '',
            args: (part.functionCall.args as Record<string, any>) || {},
            ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
          });
        }
      }
    }

    const sources: { title: string; url: string }[] = [];
    const groundingMetadata = candidate?.groundingMetadata;

    if (groundingMetadata && groundingMetadata.groundingChunks) {
      for (const chunk of groundingMetadata.groundingChunks) {
        if (chunk.web?.uri && chunk.web?.title) {
          sources.push({
            title: chunk.web.title,
            url: chunk.web.uri,
          });
        }
      }
    }

    return {
      text,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      sources: sources.length > 0 ? sources : undefined,
    };
  }
}
