import { load } from 'cheerio';
import { newPage } from './browser';
import pino from 'pino';
import { config } from './config';
import { db } from './db';

const logger = pino({ level: config.LOG_LEVEL });

/**
 * Преобразует timestamp в читаемый формат времени
 * @param timestamp - Unix timestamp в миллисекундах
 * @returns Строка с читаемым временем
 */
export function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString('ru-RU', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'Europe/Moscow'
  });
}

/**
 * Создает URL для официального сайта Roblox используя source_id из базы данных
 * @param sourceId - ID игры из базы данных (колонка source_id)
 * @returns URL для официального сайта Roblox
 */
export function createRobloxUrlFromSourceId(sourceId: string): string {
  return `https://www.roblox.com/games/${sourceId}/`;
}

/**
 * Парсит онлайн игры с официального сайта Roblox с retry логикой
 * @param robloxUrl - URL игры на roblox.com
 * @param maxRetries - Максимальное количество попыток
 * @returns Количество игроков онлайн или null если не удалось получить
 */
export async function parseOnlineFromRoblox(robloxUrl: string, maxRetries: number = 3): Promise<number | null> {
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const page = await newPage();
    
    try {
      logger.debug({ robloxUrl, attempt }, 'Parsing online from Roblox');
      
      await page.goto(robloxUrl, { 
        waitUntil: 'domcontentloaded',
        timeout: config.REQUEST_TIMEOUT_MS 
      });
      
      // Ждем загрузки страницы
      await page.waitForTimeout(2000);
    
    // Ищем элемент с количеством активных игроков
    // На Roblox это в элементе с классом "game-stat" и текстом "Active"
    const onlineText = await page.evaluate(() => {
      // Сначала ищем специфичный элемент Roblox с классом "game-stat"
      const gameStats = document.querySelectorAll('li.game-stat');
      
      for (const stat of gameStats) {
        const labelElement = stat.querySelector('.text-label');
        const valueElement = stat.querySelector('.text-lead');
        
        if (labelElement && valueElement) {
          const label = labelElement.textContent?.trim().toLowerCase();
          const value = valueElement.textContent?.trim();
          
          // Ищем элемент с текстом "Active"
          if (label === 'active' && value) {
            // Убираем неразрывные пробелы (&nbsp;), запятые и обычные пробелы
            const cleanValue = value.replace(/\u00A0/g, '').replace(/,/g, '').replace(/\s/g, '');
            const match = cleanValue.match(/^(\d+)$/);
            if (match) {
              const num = parseInt(match[1], 10);
              // Принимаем 0 как валидное значение (игра неактивна)
              if (num >= 0 && num < 1000000) {
                return match[1];
              }
            }
          }
        }
      }
      
      // Дополнительный поиск по другим селекторам
      const robloxSelectors = [
        '[data-testid="game-players-count"]',
        '[data-testid="active-players"]',
        '.game-players-count',
        '.players-count',
        '.active-players',
        '.concurrent-players'
      ];
      
      for (const selector of robloxSelectors) {
        const element = document.querySelector(selector);
        if (element) {
          const text = element.textContent || '';
          // Очищаем текст от пробелов и запятых
          const cleanText = text.replace(/\s/g, '').replace(/,/g, '');
          const match = cleanText.match(/^(\d+)$/);
          if (match) {
            const num = parseInt(match[1], 10);
            if (num >= 0 && num < 1000000) {
              return match[1];
            }
          }
        }
      }
      
      // Поиск по тексту на странице
      const bodyText = document.body.textContent || '';
      const patterns = [
        /(\d+)\s+active/i,
        /(\d+)\s+playing/i,
        /active[:\s]*(\d+)/i,
        /playing[:\s]*(\d+)/i
      ];
      
      for (const pattern of patterns) {
        const match = bodyText.match(pattern);
        if (match) {
          // Очищаем найденное число от пробелов и запятых
          const cleanNumber = match[1].replace(/\s/g, '').replace(/,/g, '');
          const num = parseInt(cleanNumber, 10);
          if (num >= 0 && num < 1000000) {
            return cleanNumber;
          }
        }
      }
      
      return null;
    });
    
    if (onlineText !== null) {
      const onlineCount = parseInt(onlineText, 10);
      logger.debug({ robloxUrl, onlineCount, onlineText }, 'Successfully parsed online count');
      return onlineCount;
    }
    
    // Дополнительная отладочная информация
    const pageTitle = await page.title();
    const pageUrl = page.url();
    
    // Проверяем, не 404 ли это
    if (pageUrl.includes('request-error') || pageUrl.includes('404') || pageTitle === 'Roblox') {
      logger.warn({ robloxUrl, pageTitle, pageUrl }, 'Game not found (404) or invalid URL');
      return null;
    }
    
    // Получаем информацию о найденных game-stat элементах
    const gameStatsInfo = await page.evaluate(() => {
      const gameStats = document.querySelectorAll('li.game-stat');
      const stats = [];
      
      for (const stat of gameStats) {
        const labelElement = stat.querySelector('.text-label');
        const valueElement = stat.querySelector('.text-lead');
        
        if (labelElement && valueElement) {
          stats.push({
            label: labelElement.textContent?.trim(),
            value: valueElement.textContent?.trim()
          });
        }
      }
      
      return stats;
    });
    
    logger.warn({ 
      robloxUrl, 
      pageTitle, 
      pageUrl,
      redirected: robloxUrl !== pageUrl,
      gameStatsInfo
    }, 'Could not find online count on Roblox page');
    
    // Попробуем получить HTML для отладки
    const bodyText = await page.evaluate(() => document.body.textContent);
    const bodyTextSample = bodyText?.substring(0, 500) || '';
    logger.debug({ bodyTextSample }, 'Page content sample');
    
      return null;
      
    } catch (error) {
      lastError = error as Error;
      logger.warn({ error, robloxUrl, attempt }, `Failed to parse online from Roblox (attempt ${attempt}/${maxRetries})`);
      
      // Если это не последняя попытка, ждем перед retry
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt)); // Экспоненциальная задержка
      }
    } finally {
      await page.context().close();
    }
  }
  
  // Если все попытки неудачны, логируем финальную ошибку
  logger.error({ error: lastError, robloxUrl, maxRetries }, 'All parsing attempts failed');
  return null;
}

/**
 * Получает все игры из базы данных
 * @returns Массив игр из базы данных
 */
export function getAllGamesFromDb(): Array<{ id: number; source_id: string; title: string; url: string }> {
  const stmt = db.prepare('SELECT id, source_id, title, url FROM games ORDER BY id');
  return stmt.all() as Array<{ id: number; source_id: string; title: string; url: string }>;
}

/**
 * Сохраняет снапшот онлайна в базу данных
 * @param gameId - ID игры
 * @param onlineCount - Количество игроков онлайн
 * @param robloxUrl - URL игры на Roblox
 * @param gameTitle - Название игры
 */
export function saveOnlineSnapshot(gameId: number, onlineCount: number, robloxUrl: string, gameTitle: string): void {
  const timestamp = Date.now();
  const readableTime = formatTimestamp(timestamp);
  
  const stmt = db.prepare('INSERT INTO snapshots (game_id, timestamp, ccu, roblox_url, game_title, readable_time) VALUES (?, ?, ?, ?, ?, ?)');
  stmt.run(gameId, timestamp, onlineCount, robloxUrl, gameTitle, readableTime);
  logger.debug({ 
    gameId, 
    onlineCount, 
    robloxUrl,
    gameTitle,
    timestamp, 
    readableTime 
  }, 'Saved online snapshot');
}

/**
 * Круговой парсинг онлайна всех игр
 * @param onProgress - Callback для отслеживания прогресса
 */
export async function circularOnlineParsing(
  onProgress?: (current: number, total: number, gameTitle: string, successfulParses: number, failedParses: number) => void,
  shouldStop?: () => boolean
): Promise<{
  totalGames: number;
  successfulParses: number;
  failedParses: number;
  errors: string[];
}> {
  const games = getAllGamesFromDb();
  const totalGames = games.length;
  let successfulParses = 0;
  let failedParses = 0;
  const errors: string[] = [];
  
  logger.info({ totalGames }, 'Starting circular online parsing');
  
  if (totalGames === 0) {
    logger.warn('No games found in database');
    return { totalGames: 0, successfulParses: 0, failedParses: 0, errors: ['No games in database'] };
  }
  
  // Начинаем круговой парсинг
  let currentIndex = 0;
  
  while (true) {
    // Проверяем, не нужно ли остановить парсинг
    if (shouldStop && shouldStop()) {
      logger.info('Circular parsing stopped by user request');
      break;
    }
    
    const game = games[currentIndex];
    
    try {
      logger.debug({ gameId: game.id, title: game.title, currentIndex, totalGames }, 'Processing game');
      
      if (onProgress) {
        onProgress(currentIndex + 1, totalGames, game.title, successfulParses, failedParses);
      }
      
      // Создаем URL для Roblox используя source_id из базы данных
      const robloxUrl = createRobloxUrlFromSourceId(game.source_id);
      
      // Парсим онлайн с официального сайта
      const onlineCount = await parseOnlineFromRoblox(robloxUrl);
      logger.debug({ gameId: game.id, title: game.title, onlineCount, robloxUrl }, 'Parsed online count');
      
      if (onlineCount !== null) {
        // Сохраняем снапшот (включая 0 игроков)
        saveOnlineSnapshot(game.id, onlineCount, robloxUrl, game.title);
        successfulParses++;
        const readableTime = formatTimestamp(Date.now());
        logger.debug({ gameId: game.id, title: game.title, onlineCount, time: readableTime }, 'Successfully parsed and saved online count');
      } else {
        failedParses++;
        const error = `Failed to parse online for game ${game.title} (ID: ${game.id})`;
        errors.push(error);
        logger.warn({ gameId: game.id, title: game.title }, 'Failed to parse online count');
      }
      
    } catch (error) {
      failedParses++;
      const errorMsg = `Error processing game ${game.title} (ID: ${game.id}): ${(error as Error).message}`;
      errors.push(errorMsg);
      logger.error({ error, gameId: game.id, title: game.title }, 'Error processing game');
    }
    
    // Переходим к следующей игре
    currentIndex = (currentIndex + 1) % totalGames;
    
    // Небольшая пауза между запросами
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  // Возвращаем статистику при остановке
  return { totalGames, successfulParses, failedParses, errors };
}

/**
 * Запускает круговой парсинг на определенное время
 * @param durationMs - Продолжительность парсинга в миллисекундах
 * @param onProgress - Callback для отслеживания прогресса
 */
export async function startCircularParsingForDuration(
  durationMs: number,
  onProgress?: (current: number, total: number, gameTitle: string, successfulParses: number, failedParses: number) => void,
  shouldStop?: () => boolean
): Promise<{
  totalGames: number;
  successfulParses: number;
  failedParses: number;
  errors: string[];
  totalCycles: number;
  averageTimePerGame: number;
}> {
  const games = getAllGamesFromDb();
  const totalGames = games.length;
  let successfulParses = 0;
  let failedParses = 0;
  const errors: string[] = [];
  let totalCycles = 0;
  let totalProcessingTime = 0;
  
  logger.info({ totalGames, durationMs }, 'Starting circular online parsing for duration');
  
  if (totalGames === 0) {
    logger.warn('No games found in database');
    return { 
      totalGames: 0, 
      successfulParses: 0, 
      failedParses: 0, 
      errors: ['No games in database'],
      totalCycles: 0,
      averageTimePerGame: 0
    };
  }
  
  const startTime = Date.now();
  let currentIndex = 0;
  let gameStartTime = 0;
  
  while (Date.now() - startTime < durationMs) {
    // Проверяем, не нужно ли остановить парсинг
    if (shouldStop && shouldStop()) {
      logger.info('Parsing stopped by user request');
      break;
    }
    
    const game = games[currentIndex];
    gameStartTime = Date.now();
    
    try {
      logger.debug({ gameId: game.id, title: game.title, currentIndex, totalGames }, 'Processing game');
      
      if (onProgress) {
        onProgress(currentIndex + 1, totalGames, game.title, successfulParses, failedParses);
      }
      
      // Создаем URL для Roblox используя source_id из базы данных
      const robloxUrl = createRobloxUrlFromSourceId(game.source_id);
      
      // Парсим онлайн с официального сайта
      const onlineCount = await parseOnlineFromRoblox(robloxUrl);
      logger.debug({ gameId: game.id, title: game.title, onlineCount, robloxUrl }, 'Parsed online count');
      
      if (onlineCount !== null) {
        // Сохраняем снапшот (включая 0 игроков)
        saveOnlineSnapshot(game.id, onlineCount, robloxUrl, game.title);
        successfulParses++;
        const readableTime = formatTimestamp(Date.now());
        logger.debug({ gameId: game.id, title: game.title, onlineCount, time: readableTime }, 'Successfully parsed and saved online count');
      } else {
        failedParses++;
        const error = `Failed to parse online for game ${game.title} (ID: ${game.id})`;
        errors.push(error);
        logger.warn({ gameId: game.id, title: game.title }, 'Failed to parse online count');
      }
      
    } catch (error) {
      failedParses++;
      const errorMsg = `Error processing game ${game.title} (ID: ${game.id}): ${(error as Error).message}`;
      errors.push(errorMsg);
      logger.error({ error, gameId: game.id, title: game.title }, 'Error processing game');
    }
    
    // Подсчитываем время обработки игры
    const gameProcessingTime = Date.now() - gameStartTime;
    totalProcessingTime += gameProcessingTime;
    
    // Переходим к следующей игре
    currentIndex = (currentIndex + 1) % totalGames;
    
    // Логируем информацию о прогрессе
    if (currentIndex === 0 && (successfulParses + failedParses) > 0) {
      logger.info({ 
        currentIndex,
        successfulParses, 
        failedParses, 
        errors: errors.length 
      }, 'Returned to first game');
    }
    
    // Небольшая пауза между запросами (увеличиваем до 2 секунд для стабильности)
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  const duration = Date.now() - startTime;
  const averageTimePerGame = totalProcessingTime / (successfulParses + failedParses) || 0;
  
  logger.info({ 
    totalGames, 
    successfulParses, 
    failedParses, 
    errors: errors.length, 
    duration,
    totalCycles,
    averageTimePerGame: Math.round(averageTimePerGame)
  }, 'Circular parsing completed');
  
  return { 
    totalGames, 
    successfulParses, 
    failedParses, 
    errors,
    totalCycles,
    averageTimePerGame: Math.round(averageTimePerGame)
  };
}
