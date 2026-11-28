import { WhatsAppClient, MessageHandler, registerWhatsAppCommands } from './adapters/whatsapp';
import logger from './utils/logger';
import config from './config';
import { db } from './database';
import { createEiraCore } from './core';
import { StickerCatalog } from './utils/sticker-catalog';
import { createStickerMaker } from './utils/sticker-maker';

async function main() {
  logger.info('Starting Eira Yuki Application...');

  const stickerCatalog = new StickerCatalog();
  const core = createEiraCore(config, logger, db, stickerCatalog);
  registerWhatsAppCommands(core.commandRouter, createStickerMaker(logger), logger);
  const messageHandler = new MessageHandler(
    logger,
    config,
    core.agent,
    core.gatekeeper,
    core.commandRouter
  );
  const whatsappClient = new WhatsAppClient(logger, config, messageHandler);
  await whatsappClient.start();

  core.taskScheduler.startScheduler(async (event) => {
    logger.info(`[TaskDaemon] Dispatching ${event.actionType} #${event.id} to ${event.chatId}`);
    const message = await core.notificationFormatter.format(
      event,
      config.bot.ownerName || 'User'
    );
    await whatsappClient.sendMessage(event.chatId, message);
  });

  // Handle clean application shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}. Shutting down application gracefully...`);
    core.taskScheduler.stopScheduler();
    await core.browserManager.close();
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('exit', () => {
    core.browserManager.closeSync();
  });
}

main().catch((error) => {
  logger.fatal(error, 'Application failed to start');
  process.exit(1);
});
