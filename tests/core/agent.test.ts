import { describe, it, expect, vi } from 'vitest';
import {
  EiraAgent,
  ContextAssembler,
  ExecutionLoop,
  ReflexionGuard,
  isFailoverEligibleError,
} from '../../src/core/agent';
import { ToolRegistry } from '../../src/core/tools/tool-registry';
import { PersonaBuilder } from '../../src/core/persona/persona-builder';
import { createSendStickerTool } from '../../src/core/tools/sticker-tool';
import { createCurrentTimeTool } from '../../src/core/tools/time-tool';
import { IncomingMessage } from '../../src/core/types';
import { LLMProvider, LLMRequest, LLMResult } from '../../src/core/providers/types';
import { ActionOmissionEvaluator } from '../../src/core/evaluator';
import { TaskService } from '../../src/core/scheduler';
import { StickerCatalog } from '../../src/utils/sticker-catalog';

describe('EiraAgent', () => {
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(createSendStickerTool({ catalog: new StickerCatalog() }));
  toolRegistry.register(createCurrentTimeTool({ timeZone: 'Asia/Jakarta', locale: 'id-ID' }));
  const personaBuilder = new PersonaBuilder();

  function createTestAgent(options: {
    llmProvider: LLMProvider;
    toolRegistry?: ToolRegistry;
    personaBuilder?: PersonaBuilder;
    taskService?: TaskService;
    actionEvaluator?: ActionOmissionEvaluator;
    stickerCatalog?: StickerCatalog;
    enableMultiHop?: boolean;
    maxHops?: number;
    multiHopTools?: string[];
    fallbackModel?: string;
    enableSearchGrounding?: boolean;
  }): EiraAgent {
    const tools = options.toolRegistry ?? toolRegistry;
    const persona = options.personaBuilder ?? personaBuilder;
    const contextAssembler = new ContextAssembler({
      personaBuilder: persona,
      toolRegistry: tools,
      taskService: options.taskService,
      timeZone: 'Asia/Jakarta',
      locale: 'id-ID',
    });
    const executionLoop = new ExecutionLoop({
      llmProvider: options.llmProvider,
      toolRegistry: tools,
      enableMultiHop: options.enableMultiHop,
      maxHops: options.maxHops,
      multiHopTools: options.multiHopTools,
      fallbackModel: options.fallbackModel,
      enableSearchGrounding: options.enableSearchGrounding,
    });
    const reflexionGuard = new ReflexionGuard({
      executionLoop,
      actionEvaluator: options.actionEvaluator,
    });
    return new EiraAgent({
      contextAssembler,
      executionLoop,
      reflexionGuard,
      stickerCatalog: options.stickerCatalog,
    });
  }

  it('delegates to injected sub-components cleanly', async () => {
    const mockContextAssembler = {
      assemble: vi.fn().mockResolvedValue({
        systemInstruction: 'sys',
        prompt: 'hello',
        conversationHistory: [],
        tools: [],
      }),
    } as unknown as ContextAssembler;

    const mockExecutionLoop = {
      run: vi.fn().mockResolvedValue({
        text: 'Loop response',
        actionsExecuted: [],
        sources: [],
      }),
    } as unknown as ExecutionLoop;

    const mockReflexionGuard = {
      evaluate: vi.fn().mockImplementation((_inc, _ctx, res) => Promise.resolve(res)),
    } as unknown as ReflexionGuard;

    const mockProvider: LLMProvider = {
      id: 'mock',
      name: 'Mock',
      generate: vi.fn(),
    };

    const agent = new EiraAgent({
      contextAssembler: mockContextAssembler,
      executionLoop: mockExecutionLoop,
      reflexionGuard: mockReflexionGuard,
      llmProvider: mockProvider,
    });

    const msg: IncomingMessage = {
      id: 'msg-isolated',
      senderId: '123',
      senderName: 'Test',
      chatId: 'chat-1',
      chatType: 'dm',
      role: 'owner',
      text: 'hello',
      timestamp: Date.now(),
    };

    const res = await agent.handleMessage(msg);
    expect(res.text).toBe('Loop response');
    expect(mockContextAssembler.assemble).toHaveBeenCalledWith(msg);
    expect(mockExecutionLoop.run).toHaveBeenCalled();
    expect(mockReflexionGuard.evaluate).toHaveBeenCalled();
  });

  it('processes DM message and returns natural response', async () => {
    const mockProvider: LLMProvider = {
      id: 'mock',
      name: 'Mock Provider',
      generate: vi.fn().mockResolvedValue({
        text: 'Halo! Aku Eira, lagi santai aja nih.',
      }),
    };

    const agent = createTestAgent({ llmProvider: mockProvider });

    const dmMsg: IncomingMessage = {
      id: 'msg-2',
      senderId: '628123456789',
      senderName: 'Adli',
      chatId: '628123456789',
      chatType: 'dm',
      role: 'owner',
      text: 'lagi ngapain?',
      timestamp: Date.now(),
    };

    const response = await agent.handleMessage(dmMsg);
    expect(response).not.toBeNull();
    expect(response?.text).toBe('Halo! Aku Eira, lagi santai aja nih.');
    expect(mockProvider.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'lagi ngapain?',
      })
    );
  });

  it('executes tool call and attaches sticker action when requested by LLM', async () => {
    const mockProvider: LLMProvider = {
      id: 'mock',
      name: 'Mock Provider',
      generate: vi.fn().mockResolvedValue({
        text: 'I acknowledge your confidence.',
        toolCalls: [
          {
            name: 'send_sticker',
            args: { tag: 'smug', reason: 'playful tease' },
          },
        ],
      }),
    };

    const mockCatalog = {
      getSticker: vi.fn().mockReturnValue(Buffer.from('mock-sticker-webp')),
    } as unknown as StickerCatalog;

    const agent = createTestAgent({ llmProvider: mockProvider, stickerCatalog: mockCatalog });

    const msg: IncomingMessage = {
      id: 'msg-3',
      senderId: '628123456789',
      senderName: 'Adli',
      chatId: '628123456789',
      chatType: 'dm',
      role: 'owner',
      text: 'I am great at games.',
      timestamp: Date.now(),
    };

    const response = await agent.handleMessage(msg);
    expect(response).not.toBeNull();
    expect(response?.text).toBe('I acknowledge your confidence.');
    expect(response?.attachment).toBeDefined();
    expect(response?.attachment?.type).toBe('sticker');
    expect(response?.attachment?.payload).toEqual(Buffer.from('mock-sticker-webp'));
    expect(response?.attachment?.metadata?.id).toBe('smug');
    const stickerAction = response?.actionsExecuted?.find((a) => a.toolName === 'send_sticker');
    expect(stickerAction?.result?.stickerRequested).toBe('smug');
    expect(stickerAction?.result?.reason).toBe('playful tease');
    expect(response?.actionsExecuted?.[0].toolName).toBe('send_sticker');
  });

  it('triggers continuation when tool call has no initial text', async () => {
    const mockProvider: LLMProvider = {
      id: 'mock',
      name: 'Mock Provider',
      generate: vi.fn().mockResolvedValue({
        text: '',
        toolCalls: [
          {
            name: 'get_current_time',
            args: {},
          },
        ],
      }),
      continueWithToolResults: vi.fn().mockResolvedValue({
        text: 'The current time is 14:00.',
      }),
    };

    const agent = createTestAgent({ llmProvider: mockProvider });

    const msg: IncomingMessage = {
      id: 'msg-4',
      senderId: '628123456789',
      senderName: 'Adli',
      chatId: '628123456789',
      chatType: 'dm',
      role: 'owner',
      text: 'what time is it?',
      timestamp: Date.now(),
    };

    const response = await agent.handleMessage(msg);
    expect(response).not.toBeNull();
    expect(response?.text).toBe('The current time is 14:00.');
    expect(mockProvider.continueWithToolResults).toHaveBeenCalled();
  });

  it('throws error without fake success when tool continuation fails and no sticker dispatched', async () => {
    const mockProvider: LLMProvider = {
      id: 'mock',
      name: 'Mock Provider',
      generate: vi.fn().mockResolvedValue({
        text: '',
        toolCalls: [
          {
            name: 'get_current_time',
            args: {},
          },
        ],
      }),
      continueWithToolResults: vi.fn().mockRejectedValue(new Error('Continuation timeout')),
    };

    const agent = createTestAgent({ llmProvider: mockProvider });

    const msg: IncomingMessage = {
      id: 'msg-5',
      senderId: '628123456789',
      senderName: 'Adli',
      chatId: '628123456789',
      chatType: 'dm',
      role: 'owner',
      text: 'what time is it?',
      timestamp: Date.now(),
    };

    await expect(agent.handleMessage(msg)).rejects.toThrow('Continuation timeout');
  });

  it('handles multiple parallel tool calls and records all actions executed', async () => {
    const mockProvider: LLMProvider = {
      id: 'mock',
      name: 'Mock Provider',
      generate: vi.fn().mockResolvedValue({
        text: 'Both tasks executed.',
        toolCalls: [
          {
            name: 'send_sticker',
            args: { tag: 'smug', reason: 'parallel test' },
          },
          {
            name: 'get_current_time',
            args: {},
          },
        ],
      }),
    };

    const agent = createTestAgent({ llmProvider: mockProvider });

    const msg: IncomingMessage = {
      id: 'msg-6',
      senderId: '628123456789',
      senderName: 'Adli',
      chatId: '628123456789',
      chatType: 'dm',
      role: 'owner',
      text: 'do both',
      timestamp: Date.now(),
    };

    const response = await agent.handleMessage(msg);
    expect(response).not.toBeNull();
    expect(response?.text).toBe('Both tasks executed.');
    const stickerAction = response?.actionsExecuted?.find((a) => a.toolName === 'send_sticker');
    expect(stickerAction?.result?.stickerRequested).toBe('smug');
    expect(stickerAction?.result?.reason).toBe('parallel test');
    expect(response?.actionsExecuted?.length).toBe(2);
    expect(response?.actionsExecuted?.[0].toolName).toBe('send_sticker');
    expect(response?.actionsExecuted?.[1].toolName).toBe('get_current_time');
  });

  it('performs multi-hop iterations when tool returns further function calls', async () => {
    const mockProvider: LLMProvider = {
      id: 'mock',
      name: 'Mock Provider',
      generate: vi.fn().mockResolvedValue({
        text: '',
        toolCalls: [
          {
            name: 'web_search',
            args: { query: 'Initial topic' },
          },
        ],
      }),
      continueWithToolResults: vi
        .fn()
        // Hop 1 returns second tool call
        .mockResolvedValueOnce({
          text: '',
          toolCalls: [
            {
              name: 'web_search',
              args: { query: 'Refined topic' },
            },
          ],
          sessionState: { contents: [{ role: 'user', parts: [{ text: 'query' }] }] },
        })
        // Hop 2 returns final text
        .mockResolvedValueOnce({
          text: 'Comprehensive answer after two hops.',
          toolCalls: [],
        }),
    };

    const agent = createTestAgent({
      llmProvider: mockProvider,
      enableMultiHop: true,
      maxHops: 4,
      multiHopTools: ['web_search'],
    });

    const msg: IncomingMessage = {
      id: 'msg-7',
      senderId: '628123456789',
      senderName: 'Adli',
      chatId: '628123456789',
      chatType: 'dm',
      role: 'owner',
      text: 'research this thoroughly',
      timestamp: Date.now(),
    };

    const response = await agent.handleMessage(msg);
    expect(response).not.toBeNull();
    expect(response?.text).toBe('Comprehensive answer after two hops.');
    expect(mockProvider.continueWithToolResults).toHaveBeenCalledTimes(2);
    expect(response?.actionsExecuted?.length).toBe(2);
    expect(response?.actionsExecuted?.[0].toolName).toBe('web_search');
    expect(response?.actionsExecuted?.[1].toolName).toBe('web_search');
  });

  it('guards against duplicate identical tool calls in multi-hop loop', async () => {
    const mockProvider: LLMProvider = {
      id: 'mock',
      name: 'Mock Provider',
      generate: vi.fn().mockResolvedValue({
        text: '',
        toolCalls: [
          {
            name: 'web_search',
            args: { query: 'repeated query' },
          },
        ],
      }),
      continueWithToolResults: vi.fn().mockResolvedValue({
        text: 'Partial text before repeating',
        toolCalls: [
          {
            name: 'web_search',
            args: { query: 'repeated query' }, // Exact duplicate
          },
        ],
      }),
    };

    const agent = createTestAgent({
      llmProvider: mockProvider,
      enableMultiHop: true,
      maxHops: 4,
    });

    const msg: IncomingMessage = {
      id: 'msg-8',
      senderId: '628123456789',
      senderName: 'Adli',
      chatId: '628123456789',
      chatType: 'dm',
      role: 'owner',
      text: 'research with duplicate',
      timestamp: Date.now(),
    };

    const response = await agent.handleMessage(msg);
    expect(response).not.toBeNull();
    // Only 1 continuation call should be made because second hop attempts duplicate
    expect(mockProvider.continueWithToolResults).toHaveBeenCalledTimes(1);
    expect(response?.actionsExecuted?.length).toBe(1);
  });

  it('triggers agentic reflexion guard when action commitment is made without tool execution', async () => {
    const { TaskService } = await import('../../src/core/scheduler');
    const { createReminderTools } = await import('../../src/core/tools/reminder-tools');
    const { db } = await import('../../src/database');
    const taskService = new TaskService(db);
    const reminderTools = createReminderTools(taskService, { timeZone: 'Asia/Jakarta', locale: 'id-ID' });
    const testRegistry = new ToolRegistry();
    testRegistry.registerAll(reminderTools);

    const testChatId = `self-verify-${Date.now()}`;

    // Seed 1 active task
    await taskService.createScheduledTask({
      chatId: testChatId,
      title: 'Pantau Hacker News',
      scheduleType: 'interval',
      scheduleConfig: { intervalMinutes: 5 },
      actionType: 'watch_url',
      actionPayload: { url: 'https://news.ycombinator.com/newest' },
      nextRunAt: Date.now() + 60000,
    });

    const pendingBefore = await taskService.getPendingTasks(testChatId);
    expect(pendingBefore.length).toBe(1);

    // Mock LLM:
    // 1st call (turn 1): Hallucinates cancellation in text without toolCalls
    // 2nd call (reflexion turn): Self-corrects and emits cancel_reminder toolCall
    const mockProvider: LLMProvider = {
      id: 'mock',
      name: 'Mock Provider',
      generate: vi
        .fn()
        .mockResolvedValueOnce({
          text: 'Sudah saya batalkan. Sepertinya Anda sedang tidak ingin membaca berita hari ini.',
        })
        .mockResolvedValueOnce({
          text: '',
          toolCalls: [{ name: 'cancel_reminder', args: { keyword: 'hacker news' } }],
        }),
      continueWithToolResults: vi.fn().mockResolvedValue({
        text: 'Tugas pemantauan telah berhasil dibatalkan dari sistem.',
      }),
    };

    const mockEvaluator: ActionOmissionEvaluator = {
      isActionOmitted: vi.fn().mockResolvedValue(true),
    };

    const agent = createTestAgent({
      toolRegistry: testRegistry,
      llmProvider: mockProvider,
      taskService,
      actionEvaluator: mockEvaluator,
    });

    const msg: IncomingMessage = {
      id: 'msg-verify-1',
      senderId: '628123456789',
      senderName: 'Adli',
      chatId: testChatId,
      chatType: 'dm',
      role: 'owner',
      text: 'batalkan pemantauan',
      timestamp: Date.now(),
    };

    const response = await agent.handleMessage(msg);
    expect(response).not.toBeNull();
    // Guard caught the omission via ActionEvaluator, prompted the model, and executed the emitted tool
    expect(mockEvaluator.isActionOmitted).toHaveBeenCalledTimes(1);
    expect(mockProvider.generate).toHaveBeenCalledTimes(2);
    expect(response?.actionsExecuted?.some((a) => a.toolName === 'cancel_reminder')).toBe(true);
    expect(response?.text).toBe('Tugas pemantauan telah berhasil dibatalkan dari sistem.');

    const pendingAfter = await taskService.getPendingTasks(testChatId);
    expect(pendingAfter.length).toBe(0);
  });

  it('triggers agentic reflexion guard on monitoring creation omission', async () => {
    const { TaskService } = await import('../../src/core/scheduler');
    const { createReminderTools } = await import('../../src/core/tools/reminder-tools');
    const { db } = await import('../../src/database');
    const taskService = new TaskService(db);
    const reminderTools = createReminderTools(taskService, { timeZone: 'Asia/Jakarta', locale: 'id-ID' });
    const testRegistry = new ToolRegistry();
    testRegistry.registerAll(reminderTools);

    const testChatId = `create-verify-${Date.now()}`;

    // Mock LLM:
    // 1st call: Model responds conversationally "Baik, saya pantau..." without toolCalls
    // 2nd call: Reflexion Guard prompts, model emits set_reminder toolCall
    const mockProvider: LLMProvider = {
      id: 'mock',
      name: 'Mock Provider',
      generate: vi
        .fn()
        .mockResolvedValueOnce({
          text: 'Baik, saya pantau. Setiap 5 menit akan saya cek apakah ada konten baru di sana.',
        })
        .mockResolvedValueOnce({
          text: '',
          toolCalls: [
            {
              name: 'set_reminder',
              args: {
                text: 'Pantau Hacker News',
                url: 'https://news.ycombinator.com/newest',
                repeatType: 'interval',
                intervalMinutes: 5,
              },
            },
          ],
        }),
      continueWithToolResults: vi.fn().mockResolvedValue({
        text: 'Hacker News terbaru akan saya pantau setiap 5 menit untuk Anda.',
      }),
    };

    const mockEvaluator: ActionOmissionEvaluator = {
      isActionOmitted: vi.fn().mockResolvedValue(true),
    };

    const agent = createTestAgent({
      toolRegistry: testRegistry,
      llmProvider: mockProvider,
      taskService,
      actionEvaluator: mockEvaluator,
    });

    const msg: IncomingMessage = {
      id: 'msg-verify-2',
      senderId: '628123456789',
      senderName: 'Adli',
      chatId: testChatId,
      chatType: 'dm',
      role: 'owner',
      text: 'Eira, tolong pantau website https://news.ycombinator.com/newest setiap 5 menit sekali kalau ada update baru.',
      timestamp: Date.now(),
    };

    const response = await agent.handleMessage(msg);
    expect(response).not.toBeNull();
    expect(mockEvaluator.isActionOmitted).toHaveBeenCalledTimes(1);
    expect(mockProvider.generate).toHaveBeenCalledTimes(2);
    expect(response?.actionsExecuted?.some((a) => a.toolName === 'set_reminder')).toBe(true);

    const pending = await taskService.getPendingTasks(testChatId);
    expect(pending.length).toBe(1);
    expect(pending[0].actionType).toBe('watch_url');
  });

  describe('encapsulation and pipeline boundaries', () => {
    it('verifies that scheduler and gatekeeper proxy methods are not exposed on EiraAgent', () => {
      expect(Object.getOwnPropertyDescriptor(EiraAgent.prototype, 'gatekeeper')).toBeUndefined();
      expect(Object.getOwnPropertyDescriptor(EiraAgent.prototype, 'taskScheduler')).toBeUndefined();
      expect(Object.getOwnPropertyDescriptor(EiraAgent.prototype, 'isOwner')).toBeUndefined();
      expect(Object.getOwnPropertyDescriptor(EiraAgent.prototype, 'shouldRespond')).toBeUndefined();
      expect(Object.getOwnPropertyDescriptor(EiraAgent.prototype, 'startScheduler')).toBeUndefined();
      expect(Object.getOwnPropertyDescriptor(EiraAgent.prototype, 'stopScheduler')).toBeUndefined();
      expect(Object.getOwnPropertyDescriptor(EiraAgent.prototype, 'formatProactiveNotification')).toBeUndefined();
    });
  });

  describe('true failover and fallback model handling', () => {
    it('correctly classifies failover-eligible errors', () => {
      expect(isFailoverEligibleError({ status: 429 })).toBe(true);
      expect(isFailoverEligibleError({ code: 503 })).toBe(true);
      expect(isFailoverEligibleError(new Error('RESOURCE_EXHAUSTED: quota exceeded'))).toBe(true);
      expect(isFailoverEligibleError(new Error('Too Many Requests: 429'))).toBe(true);
      expect(isFailoverEligibleError({ status: 400, message: 'Invalid field' })).toBe(false);
      expect(isFailoverEligibleError(new Error('Syntax error'))).toBe(false);
      expect(isFailoverEligibleError(null)).toBe(false);
    });

    it('fails over to fallbackModel when primary model encounters 429 on initial generation', async () => {
      const mockProvider: LLMProvider = {
        id: 'mock-gemini',
        name: 'Mock Gemini',
        modelName: 'primary-model',
        generate: vi.fn().mockImplementation(async (req) => {
          if (req.modelName === 'primary-model' || !req.modelName) {
            const err = new Error('RESOURCE_EXHAUSTED: quota exceeded');
            (err as any).status = 429;
            throw err;
          }
          if (req.modelName === 'fallback-model') {
            return { text: 'Fallback model response' };
          }
          throw new Error('Unexpected model');
        }),
      };

      const agent = createTestAgent({
        llmProvider: mockProvider,
        fallbackModel: 'fallback-model',
      });

      const msg: IncomingMessage = {
        id: 'msg-fallback-1',
        senderId: '123',
        senderName: 'Adli',
        chatId: 'chat-fallback-1',
        chatType: 'dm',
        role: 'owner',
        text: 'Hello Eira',
        timestamp: Date.now(),
      };

      const res = await agent.handleMessage(msg);
      expect(res.text).toBe('Fallback model response');
      expect(mockProvider.generate).toHaveBeenCalledTimes(2);
      expect(mockProvider.generate).toHaveBeenNthCalledWith(1, expect.objectContaining({ modelName: 'primary-model' }));
      expect(mockProvider.generate).toHaveBeenNthCalledWith(2, expect.objectContaining({ modelName: 'fallback-model' }));
    });

    it('fails over to fallbackModel when primary model encounters 429 during tool continuation', async () => {
      const mockProvider: LLMProvider = {
        id: 'mock-gemini',
        name: 'Mock Gemini',
        modelName: 'primary-model',
        generate: vi.fn().mockResolvedValue({
          text: '',
          toolCalls: [{ name: 'send_sticker', args: { tag: 'smug' } }],
        }),
        continueWithToolResults: vi.fn().mockImplementation(async (req) => {
          if (req.modelName === 'primary-model') {
            const err = new Error('429 Too Many Requests');
            (err as any).status = 429;
            throw err;
          }
          if (req.modelName === 'fallback-model') {
            return { text: 'Continuation succeeded on fallback model' };
          }
          throw new Error('Unexpected model');
        }),
      };

      const agent = createTestAgent({
        llmProvider: mockProvider,
        fallbackModel: 'fallback-model',
      });

      const msg: IncomingMessage = {
        id: 'msg-fallback-2',
        senderId: '123',
        senderName: 'Adli',
        chatId: 'chat-fallback-2',
        chatType: 'dm',
        role: 'owner',
        text: 'Send sticker',
        timestamp: Date.now(),
      };

      const res = await agent.handleMessage(msg);
      expect(res.text).toBe('Continuation succeeded on fallback model');
      expect(mockProvider.continueWithToolResults).toHaveBeenCalledTimes(2);
      expect(mockProvider.continueWithToolResults).toHaveBeenNthCalledWith(1, expect.objectContaining({ modelName: 'primary-model' }));
      expect(mockProvider.continueWithToolResults).toHaveBeenNthCalledWith(2, expect.objectContaining({ modelName: 'fallback-model' }));
    });

    it('does not fail over and rethrows when primary model encounters a non-eligible error', async () => {
      const mockProvider: LLMProvider = {
        id: 'mock-gemini',
        name: 'Mock Gemini',
        modelName: 'primary-model',
        generate: vi.fn().mockRejectedValue(new Error('Invalid configuration parameter')),
      };

      const agent = createTestAgent({
        llmProvider: mockProvider,
        fallbackModel: 'fallback-model',
      });

      const msg: IncomingMessage = {
        id: 'msg-fallback-3',
        senderId: '123',
        senderName: 'Adli',
        chatId: 'chat-fallback-3',
        chatType: 'dm',
        role: 'owner',
        text: 'Trigger error',
        timestamp: Date.now(),
      };

      await expect(agent.handleMessage(msg)).rejects.toThrow('Invalid configuration parameter');
      expect(mockProvider.generate).toHaveBeenCalledTimes(1);
    });
  });

  describe('Mood evaluation throttling', () => {
    function createMoodTestSetup(moodEvaluationInterval?: number) {
      const history = [
        { role: 'user' as const, content: 'turn 1 user' },
        { role: 'assistant' as const, content: 'turn 1 assistant' },
        { role: 'user' as const, content: 'turn 2 user' },
        { role: 'assistant' as const, content: 'turn 2 assistant' },
      ];

      const mockContextAssembler = {
        assemble: vi.fn().mockResolvedValue({
          systemInstruction: 'sys',
          prompt: 'hello',
          conversationHistory: history,
          tools: [],
        }),
      } as unknown as ContextAssembler;

      const mockExecutionLoop = {
        run: vi.fn().mockResolvedValue({
          text: 'Eira reply',
          actionsExecuted: [],
        }),
      } as unknown as ExecutionLoop;

      const mockReflexionGuard = {
        evaluate: vi.fn().mockImplementation((_inc, _ctx, res) => Promise.resolve(res)),
      } as unknown as ReflexionGuard;

      const mockMemoryService = {
        saveChatMessage: vi.fn().mockResolvedValue(undefined),
      } as any;

      const mockMoodService = {
        applyDelta: vi.fn().mockResolvedValue(undefined),
      } as any;

      const mockMoodEvaluator = {
        evaluate: vi.fn().mockResolvedValue({ energy: 1 }),
      };

      const agent = new EiraAgent({
        contextAssembler: mockContextAssembler,
        executionLoop: mockExecutionLoop,
        reflexionGuard: mockReflexionGuard,
        memoryService: mockMemoryService,
        moodService: mockMoodService,
        moodEvaluator: mockMoodEvaluator,
        moodEvaluationInterval,
      });

      return { agent, mockMoodEvaluator, mockMoodService };
    }

    it('evaluates mood only every N turns per chat and includes recentHistory', async () => {
      const { agent, mockMoodEvaluator, mockMoodService } = createMoodTestSetup(3);

      const makeMsg = (id: string, chatId = 'chat-a'): IncomingMessage => ({
        id,
        senderId: '123',
        senderName: 'Adli',
        chatId,
        chatType: 'dm',
        role: 'owner',
        text: `message ${id}`,
        timestamp: Date.now(),
      });

      await agent.handleMessage(makeMsg('1'));
      await agent.handleMessage(makeMsg('2'));
      expect(mockMoodEvaluator.evaluate).not.toHaveBeenCalled();

      // Turn 3 triggers evaluation with prior (3 - 1) * 2 = 4 messages from conversationHistory
      await agent.handleMessage(makeMsg('3'));
      await vi.waitFor(() => {
        expect(mockMoodEvaluator.evaluate).toHaveBeenCalledTimes(1);
        expect(mockMoodService.applyDelta).toHaveBeenCalledTimes(1);
      });

      expect(mockMoodEvaluator.evaluate).toHaveBeenCalledWith({
        userText: 'message 3',
        assistantText: 'Eira reply',
        senderRole: 'owner',
        recentHistory: [
          { role: 'user', content: 'turn 1 user' },
          { role: 'assistant', content: 'turn 1 assistant' },
          { role: 'user', content: 'turn 2 user' },
          { role: 'assistant', content: 'turn 2 assistant' },
        ],
      });

      // Another chat has its own independent counter
      await agent.handleMessage(makeMsg('4', 'chat-b'));
      expect(mockMoodEvaluator.evaluate).toHaveBeenCalledTimes(1);
    });

    it('disables mood evaluation when moodEvaluationInterval is 0', async () => {
      const { agent, mockMoodEvaluator } = createMoodTestSetup(0);

      await agent.handleMessage({
        id: '1',
        senderId: '123',
        senderName: 'Adli',
        chatId: 'chat-disabled',
        chatType: 'dm',
        role: 'owner',
        text: 'hello',
        timestamp: Date.now(),
      });

      expect(mockMoodEvaluator.evaluate).not.toHaveBeenCalled();
    });
  });
});
