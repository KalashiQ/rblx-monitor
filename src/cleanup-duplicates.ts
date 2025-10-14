import pino from 'pino';
import { config } from './config';
import { initSchema, removeDuplicateGames } from './db';

const logger = pino({ level: config.LOG_LEVEL });

async function cleanupDuplicates(): Promise<void> {
  logger.info('Starting duplicate games cleanup...');
  
  // Инициализируем схему базы данных
  initSchema();
  
  // Удаляем дубликаты
  const result = removeDuplicateGames();
  
  logger.info({
    duplicatesRemoved: result.duplicatesRemoved,
    gamesRemaining: result.gamesRemaining
  }, 'Duplicate cleanup completed');
  
  if (result.duplicatesRemoved > 0) {
    logger.info(`Removed ${result.duplicatesRemoved} duplicate games. ${result.gamesRemaining} games remaining.`);
  } else {
    logger.info('No duplicate games found.');
  }
}

if (require.main === module) {
  cleanupDuplicates()
    .then(() => {
      logger.info('Cleanup completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      logger.error({ error }, 'Cleanup failed');
      process.exit(1);
    });
}

export { cleanupDuplicates };
