import 'dotenv/config';
import pino from 'pino';
import { config } from './config';
import { initSchema } from './db';
import { TelegramBot } from './telegram';

const logger = pino({ level: config.LOG_LEVEL });

async function main(): Promise<void> {
  initSchema();
  logger.info({ env: config.NODE_ENV }, 'Telegram bot starting...');
  
  if (!config.TELEGRAM_BOT_TOKEN) {
    logger.error('TELEGRAM_BOT_TOKEN is required');
    process.exit(1);
  }
  
  const telegramBot = new TelegramBot();
  
  try {
    await telegramBot.start();
    logger.info('🤖 Telegram bot started successfully');
    
    // Обработка сигналов для корректного завершения
    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down gracefully');
      await telegramBot.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down gracefully');
      await telegramBot.stop();
      process.exit(0);
    });
    
    // Держим процесс живым
    await new Promise(() => {});
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Failed to start Telegram bot');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
