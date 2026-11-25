import { describe, it, expect, vi } from 'vitest';
import {
  EiraAgent,
  ContextAssembler,
  ExecutionLoop,
  ReflexionGuard,
} from '../../src/core/agent';
import { PermissionGatekeeper } from '../../src/core/gatekeeper/permission-gatekeeper';
import { ToolRegistry } from '../../src/core/tools/tool-registry';
import { PersonaBuilder } from '../../src/core/persona/persona-builder';
import { createSendStickerTool } from '../../src/core/tools/sticker-tool';
import { StickerCatalog } from '../../src/utils/sticker-catalog';
import { createCurrentTimeTool } from '../../src/core/tools';
import { CoreTool } from '../../src/core/tools/types';
import { IncomingMessage } from '../../src/core/types';
import { LLMProvider } from '../../src/core/providers/types';

describe('Core Integration Test: Eira Agent End-to-End Pipeline', () => {
  const owners = { whatsapp: ['628111222333'] };
  const gatekeeper = new PermissionGatekeeper(owners, ['eira', 'yuki']);
  const mockOwnerOnlyTool: CoreTool = {
    name: 'secret_owner_action',
    description: 'Owner only action.',
    parameters: { type: 'object', properties: {} },
    ownerOnly: true,
    execute: async () => ({ status: 'ok' }),
  };

  const toolRegistry = new ToolRegistry();
  toolRegistry.register(createSendStickerTool({ catalog: new StickerCatalog() }));
  toolRegistry.register(createCurrentTimeTool({ timeZone: 'Asia/Jakarta', locale: 'id-ID' }));
  toolRegistry.register(mockOwnerOnlyTool);
  const personaBuilder = new PersonaBuilder();

  function createTestAgent(mockProvider: LLMProvider): EiraAgent {
    const contextAssembler = new ContextAssembler({
      personaBuilder,
      toolRegistry,
      timeZone: 'Asia/Jakarta',
      locale: 'id-ID',
    });
    const executionLoop = new ExecutionLoop({
      llmProvider: mockProvider,
      toolRegistry,
    });
    const reflexionGuard = new ReflexionGuard({
      executionLoop,
    });
    return new EiraAgent({
      contextAssembler,
      executionLoop,
      reflexionGuard,
      llmProvider: mockProvider,
    });
  }

  it('handles multi-turn tool calling and returns sticker + answer for owner', async () => {
    const mockProvider: LLMProvider = {
      id: 'mock',
      name: 'Mock Provider',
      generate: vi.fn().mockResolvedValue({
        text: '',
        toolCalls: [
          { name: 'send_sticker', args: { tag: 'tease', reason: 'playful banter' } },
          { name: 'get_current_time', args: { timeZone: 'Asia/Jakarta' } },
        ],
      }),
      continueWithToolResults: vi.fn().mockResolvedValue({
        text: 'It is 14:00 WIB right now.',
      }),
    };

    const agent = createTestAgent(mockProvider);

    const ownerMsg: IncomingMessage = {
      id: 'msg-owner-1',
      senderId: '628111222333@s.whatsapp.net',
      senderName: 'Adli',
      chatId: '628111222333@s.whatsapp.net',
      chatType: 'dm',
      role: 'owner',
      text: 'eira what time is it?',
      timestamp: Date.now(),
    };

    const response = await agent.handleMessage(ownerMsg);

    expect(response).not.toBeNull();
    expect(response?.text).toBe('It is 14:00 WIB right now.');
    const stickerAction = response?.actionsExecuted?.find((a) => a.toolName === 'send_sticker');
    expect(stickerAction?.result?.stickerRequested).toBe('tease');
    expect(response?.actionsExecuted?.length).toBe(2);
    expect(response?.actionsExecuted?.map((a) => a.toolName)).toEqual(['send_sticker', 'get_current_time']);
  });

  it('processes guest message in group when mentioned, giving only public tools', async () => {
    let passedTools: any[] = [];
    const mockProvider: LLMProvider = {
      id: 'mock',
      name: 'Mock Provider',
      generate: vi.fn().mockImplementation(async (req) => {
        passedTools = req.tools || [];
        return {
          text: 'Hello, I am Eira Yuki.',
        };
      }),
    };

    const agent = createTestAgent(mockProvider);

    const guestGroupMsg: IncomingMessage = {
      id: 'msg-guest-1',
      senderId: '628999888777@s.whatsapp.net',
      senderName: 'Budi',
      chatId: 'group-discussion@g.us',
      chatType: 'group',
      role: 'guest',
      text: 'Hello eira, who are you?',
      timestamp: Date.now(),
    };

    const response = await agent.handleMessage(guestGroupMsg);

    expect(response).not.toBeNull();
    expect(response?.text).toBe('Hello, I am Eira Yuki.');
    // Guest should NOT see owner tools in tool declarations
    const toolNames = passedTools.map((t) => t.name);
    expect(toolNames).toContain('send_sticker');
    expect(toolNames).toContain('get_current_time');
    expect(toolNames).not.toContain('secret_owner_action');
  });
});
