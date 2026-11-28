import { Logger } from 'pino';
import { Config } from '../config';
import { AppDatabase } from '../database';
import { EiraAgent, ContextAssembler, ExecutionLoop, ReflexionGuard } from './agent';
import { ActionOmissionEvaluator } from './evaluator';
import { PermissionGatekeeper } from './gatekeeper';
import { MemoryConsolidator, MemoryService } from './memory';
import { MoodService, PersonaBuilder, SemanticMoodEvaluator } from './persona';
import { DuckDuckGoSearchProvider, GeminiDecisionProvider, GeminiEmbeddingProvider, GeminiProvider, TavilySearchProvider, WebSearchService } from './providers';
import { TaskExecutor, TaskNotificationFormatter, TaskScheduler, TaskService } from './scheduler';
import { createCurrentTimeTool, createMemoryTools, createReadUrlTool, createReminderTools, createWebSearchTool, createSendStickerTool, ToolRegistry } from './tools';
import { BrowserManager, PageFetcher } from './browser';
import { StickerResolver } from './types';
import { CommandRouter, createHelpCommand } from './commands';

export * from './types';
export * from './commands';
export { EiraAgent, type EiraAgentOptions, ContextAssembler, ExecutionLoop, ReflexionGuard } from './agent';
export { PermissionGatekeeper } from './gatekeeper';
export { TaskScheduler, TaskNotificationFormatter, type TaskDispatchEvent } from './scheduler';
export { ToolRegistry } from './tools';
export { type DecisionProvider, type DecisionScore, type EmbeddingProvider, GeminiDecisionProvider, GeminiEmbeddingProvider, GeminiProvider, type GeminiProviderOptions } from './providers';
export { BrowserManager, PageFetcher } from './browser';

/**
 * Encapsulates the initialized core subsystem components of the Eira application.
 */
export interface EiraCore {
  agent: EiraAgent;
  gatekeeper: PermissionGatekeeper;
  commandRouter: CommandRouter;
  taskScheduler: TaskScheduler;
  notificationFormatter: TaskNotificationFormatter;
  browserManager: BrowserManager;
}

/**
 * Composition root that bootstraps and wires together all core dependencies,
 * returning distinct modular services adhering to the Single Responsibility Principle.
 */
export function createEiraCore(
  config: Config,
  logger: Logger,
  db: AppDatabase,
  stickerCatalog: StickerResolver
): EiraCore {
  const browserManager = new BrowserManager({ chromePath: config.env.chromePath, logger });

  const gatekeeper = new PermissionGatekeeper(
    config.bot.owners,
    config.bot.aliases
  );
  const toolRegistry = new ToolRegistry();

  const pageFetcher = new PageFetcher({
    tavilyApiKey: config.env.tavilyApiKey,
    chromePath: config.env.chromePath,
    browserManager,
  });
  const webSearchService = new WebSearchService([
    new TavilySearchProvider(config.env.tavilyApiKey),
    new DuckDuckGoSearchProvider(),
  ]);

  toolRegistry.register(createSendStickerTool({ catalog: stickerCatalog }));
  toolRegistry.register(
    createCurrentTimeTool({
      timeZone: config.bot.timezone,
      locale: config.bot.locale,
    })
  );
  toolRegistry.register(createWebSearchTool(webSearchService));
  toolRegistry.register(createReadUrlTool(pageFetcher));

  const embeddingProvider = new GeminiEmbeddingProvider(
    config.env.geminiApiKey,
    config.ai.embeddingModel,
    logger
  );
  const memoryService = new MemoryService(db, embeddingProvider, logger);
  const personaBuilder = new PersonaBuilder(config.bot.systemInstruction);
  const llmProvider = new GeminiProvider({
    apiKey: config.env.geminiApiKey,
    modelName: config.ai.model,
    temperature: config.ai.temperature,
    maxOutputTokens: config.ai.maxOutputTokens,
    logger,
  });
  const memoryConsolidator = new MemoryConsolidator(memoryService, llmProvider, logger);

  toolRegistry.registerAll(createMemoryTools(memoryService));

  const taskService = new TaskService(db, logger);
  const taskExecutor = new TaskExecutor(logger, pageFetcher);
  const taskScheduler = new TaskScheduler(taskService, taskExecutor, logger, config.bot.timezone);
  toolRegistry.registerAll(
    createReminderTools(taskService, {
      timeZone: config.bot.timezone,
      locale: config.bot.locale,
    })
  );

  const moodService = new MoodService(db, logger);
  const moodEvaluator =
    config.ai.moodEvaluationInterval > 0
      ? new SemanticMoodEvaluator(llmProvider, personaBuilder, logger)
      : undefined;
  const decisionProvider = new GeminiDecisionProvider({
    apiKey: config.env.geminiApiKey,
    modelName: config.ai.evaluator.model,
    logger,
  });
  const actionEvaluator = new ActionOmissionEvaluator({
    decisionProvider,
    threshold: config.ai.evaluator.threshold,
    logger,
  });

  const contextAssembler = new ContextAssembler({
    personaBuilder,
    toolRegistry,
    memoryService,
    moodService,
    taskService,
    logger,
    maxHistoryLimit: config.ai.maxHistoryLimit,
    timeZone: config.bot.timezone,
    locale: config.bot.locale,
  });

  const executionLoop = new ExecutionLoop({
    llmProvider,
    toolRegistry,
    logger,
    enableMultiHop: config.ai.enableMultiHop,
    maxHops: config.ai.maxHops,
    multiHopTools: config.ai.multiHopTools,
    fallbackModel: config.ai.fallbackModel,
    enableSearchGrounding: config.ai.enableSearchGrounding,
  });

  const reflexionGuard = new ReflexionGuard({
    executionLoop,
    actionEvaluator,
    logger,
  });

  const agent = new EiraAgent({
    contextAssembler,
    executionLoop,
    reflexionGuard,
    logger,
    memoryService,
    memoryConsolidator,
    moodService,
    moodEvaluator,
    moodEvaluationInterval: config.ai.moodEvaluationInterval,
    stickerCatalog,
    consolidationThreshold: Math.floor(config.ai.maxHistoryLimit / 2),
    maxHistoryLimit: config.ai.maxHistoryLimit,
  });

  const notificationFormatter = new TaskNotificationFormatter(llmProvider, personaBuilder);

  const commandRouter = new CommandRouter(config.bot.commandPrefix, logger);
  commandRouter.register(createHelpCommand(commandRouter));

  return {
    agent,
    gatekeeper,
    commandRouter,
    taskScheduler,
    notificationFormatter,
    browserManager,
  };
}
