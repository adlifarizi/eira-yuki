import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const aiChatHistory = sqliteTable('ai_chat_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: text('chat_id').notNull(),
  role: text('role').notNull(), // 'user' | 'assistant'
  content: text('content').notNull(),
  timestamp: integer('timestamp').notNull(),
});

export const coreFacts = sqliteTable('core_facts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  entity: text('entity').notNull(), // 'owner' | 'eira' | 'guest'
  senderId: text('sender_id'), // Scoped identifier (e.g. "whatsapp:123456") for 'guest' facts; null for 'owner'/'eira'
  category: text('category').notNull(), // 'preference' | 'biography' | 'schedule' | 'relationship' | 'general'
  fact: text('fact').notNull(),
  timestamp: integer('timestamp').notNull(),
});

export const episodicMemories = sqliteTable('episodic_memories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: text('chat_id').notNull(),
  summary: text('summary').notNull(),
  embedding: text('embedding'), // JSON string of float array
  importance: integer('importance').default(1),
  timestamp: integer('timestamp').notNull(),
});

export const scheduledTasks = sqliteTable('scheduled_tasks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: text('chat_id').notNull(),
  title: text('title').notNull(),
  scheduleType: text('schedule_type').notNull(), // 'once' | 'interval' | 'daily'
  scheduleConfig: text('schedule_config').notNull(), // JSON string: { targetTime, intervalMinutes, advanceMinutes }
  actionType: text('action_type').notNull(), // 'reminder' | 'watch_url'
  actionPayload: text('action_payload').notNull(), // JSON string: { url, text, prompt }
  lastStateHash: text('last_state_hash'),
  lastResultSummary: text('last_result_summary'), // recent execution snippet for conversational context
  lastExecutedAt: integer('last_executed_at'),
  nextRunAt: integer('next_run_at').notNull(),
  expiresAt: integer('expires_at'), // timestamp or null
  status: text('status').notNull().default('active'), // 'active' | 'completed' | 'cancelled'
  createdAt: integer('created_at').notNull(),
});

export const botMood = sqliteTable('bot_mood', {
  id: integer('id').primaryKey().default(1),
  energy: integer('energy').notNull().default(85),
  composure: integer('composure').notNull().default(90),
  affection: integer('affection').notNull().default(75),
  playfulness: integer('playfulness').notNull().default(80),
  lastInteraction: integer('last_interaction').notNull(),
});

