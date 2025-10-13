import 'dotenv/config';
import pino from 'pino';
import { config } from './config';
import { db, initSchema, clearTables } from './db';
import { populate } from './populate';
import { closeBrowser } from './browser';

const logger = pino({ level: config.LOG_LEVEL });

export interface CleanupStats {
  games: number;
  snapshots: number;
  anomalies: number;
  total: number;
}

export interface CleanupOptions {
  clearGames?: boolean;
  clearSnapshots?: boolean;
  clearAnomalies?: boolean;
  repopulate?: boolean;
}

/**
 * Получает статистику по количеству записей в таблицах
 */
export function getDatabaseStats(): CleanupStats {
  const gameCount = db.prepare('SELECT COUNT(*) as count FROM games').get() as { count: number };
  const snapshotCount = db.prepare('SELECT COUNT(*) as count FROM snapshots').get() as { count: number };
  const anomalyCount = db.prepare('SELECT COUNT(*) as count FROM anomalies').get() as { count: number };
  
  return {
    games: gameCount.count,
    snapshots: snapshotCount.count,
    anomalies: anomalyCount.count,
    total: gameCount.count + snapshotCount.count + anomalyCount.count
  };
}

/**
 * Очищает только игры (games)
 */
export function clearGames(): { deletedCount: number } {
  logger.info('Очищаем таблицу games...');
  const countStmt = db.prepare('SELECT COUNT(*) as count FROM games');
  const countResult = countStmt.get() as { count: number };
  const deletedCount = countResult.count;
  
  db.prepare('DELETE FROM games').run();
  
  logger.info({ deletedCount }, 'Очистка таблицы games завершена');
  return { deletedCount };
}

/**
 * Очищает только снапшоты (snapshots)
 */
export function clearSnapshots(): { deletedCount: number } {
  logger.info('Очищаем таблицу snapshots...');
  const countStmt = db.prepare('SELECT COUNT(*) as count FROM snapshots');
  const countResult = countStmt.get() as { count: number };
  const deletedCount = countResult.count;
  
  db.prepare('DELETE FROM snapshots').run();
  
  logger.info({ deletedCount }, 'Очистка таблицы snapshots завершена');
  return { deletedCount };
}

/**
 * Очищает только аномалии (anomalies)
 */
export function clearAnomalies(): { deletedCount: number } {
  logger.info('Очищаем таблицу anomalies...');
  const countStmt = db.prepare('SELECT COUNT(*) as count FROM anomalies');
  const countResult = countStmt.get() as { count: number };
  const deletedCount = countResult.count;
  
  db.prepare('DELETE FROM anomalies').run();
  
  logger.info({ deletedCount }, 'Очистка таблицы anomalies завершена');
  return { deletedCount };
}

/**
 * Выполняет выборочную очистку базы данных
 */
export async function selectiveCleanup(options: CleanupOptions): Promise<CleanupStats> {
  logger.info('Начинаем выборочную очистку базы данных...');
  
  // Инициализируем схему базы данных
  initSchema();
  
  // Получаем статистику до очистки
  const beforeStats = getDatabaseStats();
  logger.info(beforeStats, 'Состояние базы данных до очистки');
  
  let totalDeleted = 0;
  
  // Очищаем выбранные таблицы
  if (options.clearGames) {
    const result = clearGames();
    totalDeleted += result.deletedCount;
  }
  
  if (options.clearSnapshots) {
    const result = clearSnapshots();
    totalDeleted += result.deletedCount;
  }
  
  if (options.clearAnomalies) {
    const result = clearAnomalies();
    totalDeleted += result.deletedCount;
  }
  
  // Получаем статистику после очистки
  const afterStats = getDatabaseStats();
  logger.info(afterStats, 'Состояние базы данных после очистки');
  
  // Перезаполняем базу данных, если требуется
  if (options.repopulate) {
    logger.info('Начинаем перезаполнение базы данных...');
    await populate();
    logger.info('Перезаполнение базы данных завершено');
    
    const finalStats = getDatabaseStats();
    logger.info(finalStats, 'Финальное состояние базы данных');
  }
  
  return afterStats;
}

/**
 * Выполняет полную очистку и перезаполнение базы данных
 */
export async function clearAndRestart(): Promise<void> {
  logger.info('Начинаем полную очистку базы данных...');
  
  // Инициализируем схему базы данных
  initSchema();
  
  // Получаем статистику до очистки
  const beforeStats = getDatabaseStats();
  logger.info(beforeStats, 'Состояние базы данных до очистки');
  
  // Очищаем все таблицы
  clearTables();
  logger.info('База данных очищена');
  
  // Проверяем что таблицы пустые
  const afterStats = getDatabaseStats();
  logger.info(afterStats, 'Состояние базы данных после очистки');
  
  // Заново заполняем базу данных
  logger.info('Начинаем заполнение базы данных...');
  await populate();
  logger.info('Заполнение базы данных завершено');
  
  // Проверяем финальное состояние
  const finalStats = getDatabaseStats();
  logger.info(finalStats, 'Финальное состояние базы данных');
}

/**
 * CLI интерфейс для очистки базы данных
 */
export async function runCleanupCLI(): Promise<void> {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log('Использование: npm run cleanup [опции]');
    console.log('');
    console.log('Опции:');
    console.log('  --games        Очистить только игры');
    console.log('  --snapshots    Очистить только снапшоты');
    console.log('  --anomalies    Очистить только аномалии');
    console.log('  --all          Очистить все таблицы');
    console.log('  --repopulate   Перезаполнить базу данных после очистки');
    console.log('');
    console.log('Примеры:');
    console.log('  npm run cleanup --games --repopulate');
    console.log('  npm run cleanup --snapshots --anomalies');
    console.log('  npm run cleanup --all --repopulate');
    return;
  }
  
  const options: CleanupOptions = {
    clearGames: args.includes('--games'),
    clearSnapshots: args.includes('--snapshots'),
    clearAnomalies: args.includes('--anomalies'),
    repopulate: args.includes('--repopulate')
  };
  
  // Если указан --all, очищаем все таблицы
  if (args.includes('--all')) {
    options.clearGames = true;
    options.clearSnapshots = true;
    options.clearAnomalies = true;
  }
  
  // Если не указано что очищать, показываем справку
  if (!options.clearGames && !options.clearSnapshots && !options.clearAnomalies) {
    console.log('Ошибка: Не указано что очищать. Используйте --games, --snapshots, --anomalies или --all');
    process.exit(1);
  }
  
  try {
    await selectiveCleanup(options);
    logger.info('Очистка базы данных завершена успешно');
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Ошибка при очистке базы данных');
    process.exit(1);
  } finally {
    await closeBrowser();
  }
}

// Если файл запущен напрямую, выполняем CLI
if (require.main === module) {
  runCleanupCLI()
    .then(() => {
      logger.info('Очистка и перезаполнение базы данных завершено');
      return closeBrowser();
    })
    .catch((err) => {
      logger.error({ error: err }, 'Ошибка при очистке и перезаполнении базы данных');
      process.exit(1);
    });
}
