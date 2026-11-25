import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import path from 'path';
import fs from 'node:fs';
import logger from '../utils/logger';
import * as schema from './schema';

const isTest = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
const dbDir = path.join(process.cwd(), 'storage');

if (!isTest) {
  // Ensure storage directory exists
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = isTest ? ':memory:' : path.join(dbDir, 'bot.db');

const sqlite = new Database(dbPath);

// Ensure tables exist (Simple alternative to migrations)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS ai_chat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ai_chat_history_chat_id_id ON ai_chat_history (chat_id, id DESC);

  CREATE TABLE IF NOT EXISTS core_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity TEXT NOT NULL,
    category TEXT NOT NULL,
    fact TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_core_facts_entity ON core_facts (entity);

  CREATE TABLE IF NOT EXISTS episodic_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    embedding TEXT,
    importance INTEGER DEFAULT 1,
    timestamp INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_episodic_memories_chat_id ON episodic_memories (chat_id);

  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    title TEXT NOT NULL,
    schedule_type TEXT NOT NULL,
    schedule_config TEXT NOT NULL,
    action_type TEXT NOT NULL,
    action_payload TEXT NOT NULL,
    last_state_hash TEXT,
    last_result_summary TEXT,
    last_executed_at INTEGER,
    next_run_at INTEGER NOT NULL,
    expires_at INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_status_next ON scheduled_tasks (status, next_run_at);
  CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_chat_id ON scheduled_tasks (chat_id);

  CREATE TABLE IF NOT EXISTS bot_mood (
    id INTEGER PRIMARY KEY DEFAULT 1,
    energy INTEGER NOT NULL DEFAULT 85,
    composure INTEGER NOT NULL DEFAULT 90,
    affection INTEGER NOT NULL DEFAULT 75,
    playfulness INTEGER NOT NULL DEFAULT 80,
    last_interaction INTEGER NOT NULL
  );
`);

const db = drizzle(sqlite, { schema });

logger.info('Database initialized at %s', dbPath);

export type AppDatabase = typeof db;
export { db, sqlite };
