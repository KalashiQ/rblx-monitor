import 'dotenv/config';
import pino from 'pino';
import { config } from './config';
import { initSchema } from './db';
import { populate } from './populate';
import { closeBrowser } from './browser';
import { TelegramBot } from './telegram';

const logger = pino({ level: config.LOG_LEVEL });

async function main(): Promise<void> {
  initSchema();
  logger.info({ env: config.NODE_ENV }, 'Roblox monitor started');
  
  // Запускаем Telegram бота если токен настроен
  let telegramBot: TelegramBot | null = null;
  if (config.TELEGRAM_BOT_TOKEN) {
    try {
      telegramBot = new TelegramBot();
      await telegramBot.start();
      logger.info('Telegram bot started');
    } catch (error) {
      logger.error({ error: (error as Error).message }, 'Failed to start Telegram bot');
    }
  } else {
    logger.warn('TELEGRAM_BOT_TOKEN not set, Telegram bot disabled');
  }
  
  try {
    await populate();
    logger.info('Populate completed');
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Populate failed');
  } finally {
    if (telegramBot) {
      await telegramBot.stop();
    }
    await closeBrowser();
  }
}

// Обработка сигналов для корректного завершения
process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down gracefully');
  await closeBrowser();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down gracefully');
  await closeBrowser();
  process.exit(0);
});

main().catch((error) => {
  // Log unhandled errors and exit non-zero for visibility
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});


