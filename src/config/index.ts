import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'path';
import yaml from 'yaml';
import { z } from 'zod';
import logger from '../utils/logger';
import { BotOwners } from '../core/types';

// Load environment variables from .env
dotenv.config();

export const BotOwnersSchema: z.ZodType<BotOwners> = z.record(z.string(), z.array(z.coerce.string())).default({});
export type { BotOwners };

function isValidTimeZone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function isValidLocale(loc: string): boolean {
  try {
    Intl.DateTimeFormat(loc);
    return true;
  } catch {
    return false;
  }
}

const isTest = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  GEMINI_API_KEY: z
    .string()
    .default(isTest ? 'test-api-key' : '')
    .refine((val) => isTest || val.trim().length > 0, {
      message: 'GEMINI_API_KEY is required for Eira Yuki to function',
    }),
  TAVILY_API_KEY: z.string().optional(),
  CHROME_PATH: z.string().optional(),
});

const ConfigSchema = z.object({
  env: z.object({
    nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
    logLevel: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    geminiApiKey: z.string().min(1, 'GEMINI_API_KEY is required for Eira Yuki to function'),
    tavilyApiKey: z.string().optional(),
    chromePath: z.string().optional(),
  }),
  bot: z.object({
    ownerName: z.string().default('Master'),
    timezone: z
      .string()
      .default('Asia/Jakarta')
      .refine(isValidTimeZone, { message: 'Invalid IANA timeZone identifier' }),
    locale: z
      .string()
      .default('id-ID')
      .refine(isValidLocale, { message: 'Invalid BCP 47 language tag / locale' }),
    aliases: z.array(z.string()).default(['eira', 'yuki']),
    owners: BotOwnersSchema,
    systemInstruction: z.string().optional(),
  }),
  adapters: z.object({
    whatsapp: z.object({
      enabled: z.boolean().default(true),
      usePairingCode: z.boolean().default(false),
      phoneNumber: z.string().optional(),
    }),
  }),
  ai: z.object({
    model: z.string().default('gemini-3.1-flash-lite'),
    fallbackModel: z.string().default('gemini-3.5-flash-lite'),
    embeddingModel: z.string().default('gemini-embedding-001'),
    enableMultiHop: z.boolean().default(true),
    maxHops: z.number().int().min(1).max(10).default(4),
    multiHopTools: z.array(z.string()).default([
      'web_search',
      'read_url',
      'set_reminder',
      'list_reminders',
      'cancel_reminder',
    ]),
    enableSearchGrounding: z.boolean().default(false),
    maxHistoryLimit: z.number().int().default(30),
    temperature: z.number().default(0.7),
    maxOutputTokens: z.number().int().default(800),
    evaluator: z
      .object({
        model: z.string().default('gemini-decision-1'),
        threshold: z.number().min(0).max(1).default(0.65),
      })
      .default({
        model: 'gemini-decision-1',
        threshold: 0.65,
      }),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const envRaw = {
    NODE_ENV: process.env.NODE_ENV,
    LOG_LEVEL: process.env.LOG_LEVEL,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    TAVILY_API_KEY: process.env.TAVILY_API_KEY,
    CHROME_PATH:
      process.env.CHROME_PATH ||
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      process.env.CHROME_BIN,
  };

  const envResult = EnvSchema.safeParse(envRaw);
  if (!envResult.success) {
    logger.error(envResult.error.format(), 'Invalid environment variables');
    process.exit(1);
  }

  const configPath = path.join(process.cwd(), 'config', 'config.yaml');
  let yamlConfig: any = {};

  if (fs.existsSync(configPath)) {
    try {
      const fileContent = fs.readFileSync(configPath, 'utf8');
      yamlConfig = yaml.parse(fileContent);
    } catch (error) {
      logger.error(error, 'Failed to parse config.yaml');
    }
  } else {
    logger.warn('config.yaml not found, using defaults');
  }

  const instructionPath = path.join(process.cwd(), 'config', 'system-instruction.txt');
  let systemInstruction: string | undefined;
  if (fs.existsSync(instructionPath)) {
    try {
      const content = fs.readFileSync(instructionPath, 'utf8').trim();
      if (content) {
        systemInstruction = content;
      }
    } catch (error) {
      logger.warn(error, 'Failed to read system-instruction.txt');
    }
  }

  const fullConfigRaw = {
    env: {
      nodeEnv: envResult.data.NODE_ENV,
      logLevel: envResult.data.LOG_LEVEL,
      geminiApiKey: envResult.data.GEMINI_API_KEY,
      tavilyApiKey: envResult.data.TAVILY_API_KEY?.trim() || undefined,
      chromePath: envResult.data.CHROME_PATH?.trim() || undefined,
    },
    ...yamlConfig,
    bot: {
      ...yamlConfig?.bot,
      ...(systemInstruction ? { systemInstruction } : {}),
    },
  };

  const result = ConfigSchema.safeParse(fullConfigRaw);

  if (!result.success) {
    logger.error(result.error.format(), 'Invalid configuration');
    process.exit(1);
  }

  return result.data;
}

const config = loadConfig();

export default config;
