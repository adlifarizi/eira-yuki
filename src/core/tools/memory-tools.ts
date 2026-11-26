import { CoreTool } from './types';
import { MemoryService, buildGuestSenderKey } from '../memory';

/**
 * Creates the `remember_fact` tool for persisting core facts or user preferences.
 *
 * @param memoryService - The memory service instance used to store facts
 * @returns Core tool instance for remembering facts
 */
export function createRememberFactTool(memoryService: MemoryService): CoreTool {
  return {
    name: 'remember_fact',
    description:
      'Store a permanent core fact or preference about the user or Eira (e.g. hobbies, favorites, pets, key dates, job, habits). Persisted in core profile memory.',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description:
            'Fact category: "preference", "biography", "schedule", "relationship", or "general".',
        },
        fact: {
          type: 'string',
          description: 'Concise, clear fact statement to remember permanently.',
        },
      },
      required: ['category', 'fact'],
    },
    ownerOnly: false, // Eira can remember facts about anyone, tagged with their role
    execute: async (params, context) => {
      const entity = context.role === 'owner' ? 'owner' : 'guest';
      const senderId =
        entity === 'guest' ? buildGuestSenderKey(context.senderId, context.adapter) : undefined;
      const factId = await memoryService.addCoreFact(entity, params.category, params.fact, senderId);
      return {
        status: 'success',
        factId,
        remembered: params.fact,
        category: params.category,
      };
    },
  };
}

/**
 * Creates the `recall_memory` tool for searching episodic memories and past conversations.
 *
 * @param memoryService - The memory service instance used to query episodic memories
 * @returns Core tool instance for searching past memories
 */
export function createRecallMemoryTool(memoryService: MemoryService): CoreTool {
  return {
    name: 'recall_memory',
    description:
      'Search past conversation memories, previous topics, or historical episodes by topic/keywords.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Topic or keywords to search in episodic memory history.',
        },
      },
      required: ['query'],
    },
    ownerOnly: false,
    execute: async (params, context) => {
      const results = await memoryService.searchRelevantMemories(params.query, context.chatId, 3);
      if (results.length === 0) {
        return { status: 'not_found', message: 'No memories found for that topic.' };
      }
      return {
        status: 'found',
        memories: results.map((r) => r.summary),
      };
    },
  };
}

/**
 * Creates and bundles all memory-related tools (remember_fact and recall_memory).
 *
 * @param memoryService - The memory service instance used by the tools
 * @returns Array of core tools for memory management
 */
export function createMemoryTools(memoryService: MemoryService): CoreTool[] {
  return [
    createRememberFactTool(memoryService),
    createRecallMemoryTool(memoryService),
  ];
}
