import { describe, it, expect, vi } from 'vitest';
import { TaskNotificationFormatter } from '../../src/core/scheduler/task-notification-formatter';
import { LLMProvider } from '../../src/core/providers';
import { PersonaBuilder } from '../../src/core/persona';
import { TaskDispatchEvent } from '../../src/core/scheduler/types';

describe('TaskNotificationFormatter', () => {
  const personaBuilder = new PersonaBuilder();

  it('formats reminder event using natural companion tone without emojis', async () => {
    const mockProvider: LLMProvider = {
      id: 'mock',
      name: 'Mock Provider',
      generate: vi.fn().mockResolvedValue({
        text: 'Jangan lupa minum obat ya, Adli.',
      }),
    };

    const formatter = new TaskNotificationFormatter(mockProvider, personaBuilder);
    const event: TaskDispatchEvent = {
      id: 1,
      chatId: '628111222@s.whatsapp.net',
      actionType: 'reminder',
      text: 'minum obat',
    };

    const formatted = await formatter.format(event, 'Adli');
    expect(formatted).toBe('Jangan lupa minum obat ya, Adli.');
    expect(mockProvider.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('minum obat'),
      })
    );
  });

  it('formats watch_url event with diff summary without emojis', async () => {
    const mockProvider: LLMProvider = {
      id: 'mock',
      name: 'Mock Provider',
      generate: vi.fn().mockResolvedValue({
        text: 'Ada update pada halaman contoh: Versi baru v2.0 telah dirilis di https://example.com',
      }),
    };

    const formatter = new TaskNotificationFormatter(mockProvider, personaBuilder);
    const event: TaskDispatchEvent = {
      id: 2,
      chatId: '628111222@s.whatsapp.net',
      actionType: 'watch_url',
      text: 'Contoh Web',
      url: 'https://example.com',
      diffSnippet: '+ Versi 2.0 dirilis hari ini',
    };

    const formatted = await formatter.format(event, 'Adli');
    expect(formatted).toContain('https://example.com');
    expect(mockProvider.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('https://example.com'),
      })
    );
  });

  it('falls back gracefully if LLM provider fails for reminder', async () => {
    const mockProvider: LLMProvider = {
      id: 'mock',
      name: 'Mock Provider',
      generate: vi.fn().mockRejectedValue(new Error('LLM connection error')),
    };

    const formatter = new TaskNotificationFormatter(mockProvider, personaBuilder);
    const event: TaskDispatchEvent = {
      id: 3,
      chatId: '628111222@s.whatsapp.net',
      actionType: 'reminder',
      text: 'rapat jam 3',
    };

    const formatted = await formatter.format(event, 'Adli');
    expect(formatted).toBe('[Reminder] It is time for: rapat jam 3. (Adli)');
  });

  it('falls back gracefully if LLM provider fails for watch_url', async () => {
    const mockProvider: LLMProvider = {
      id: 'mock',
      name: 'Mock Provider',
      generate: vi.fn().mockRejectedValue(new Error('LLM connection error')),
    };

    const formatter = new TaskNotificationFormatter(mockProvider, personaBuilder);
    const event: TaskDispatchEvent = {
      id: 4,
      chatId: '628111222@s.whatsapp.net',
      actionType: 'watch_url',
      text: 'Blog Post',
      url: 'https://example.com/blog',
      diffSnippet: 'Content updated',
    };

    const formatted = await formatter.format(event, 'Adli');
    expect(formatted).toContain('[Web Update]');
    expect(formatted).toContain('https://example.com/blog');
  });
});
