import 'dotenv/config';
import pino from 'pino';
import { config } from './config';
import { initSchema } from './db';
import { populate } from './populate';
import { closeBrowser } from './browser';
import { TelegramBot } from './telegram';
import { analyzeAllGamesForAnomalies } from './anomaly-detector';
import { sendAnomalyNotifications } from './anomaly-notifier';

const logger = pino({ level: config.LOG_LEVEL });

async function main(): Promise<void> {
  initSchema();
  logger.info({ env: config.NODE_ENV }, 'Roblox monitor started');
  
  // Telegram бот запускается отдельно через telegram-bot.ts
  // Не запускаем его здесь, чтобы избежать конфликтов
  let telegramBot: TelegramBot | null = null;
  
  try {
    await populate();
    logger.info('Populate completed');
    
    // Анализируем аномалии после парсинга
    logger.info('Начинаем анализ аномалий...');
    const anomalyResult = analyzeAllGamesForAnomalies();
    logger.info({ 
      anomaliesFound: anomalyResult.anomaliesFound, 
      errors: anomalyResult.errors 
    }, 'Анализ аномалий завершен');
    
    // Отправляем уведомления об аномалиях
    if (anomalyResult.anomaliesFound > 0) {
      logger.info('Отправляем уведомления об аномалиях...');
      const notificationResult = await sendAnomalyNotifications();
      logger.info({ 
        sent: notificationResult.sent, 
        errors: notificationResult.errors 
      }, 'Отправка уведомлений завершена');
    }
    
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Populate failed');
  } finally {
    // telegramBot всегда null, так как мы его не запускаем
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


