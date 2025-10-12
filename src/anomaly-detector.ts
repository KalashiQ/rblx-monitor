import pino from 'pino';
import { config } from './config';
import { db, getSnapshots, insertAnomaly, markAnomalyNotified, getAnomalySettings } from './db';
import type { Anomaly } from './types';

const logger = pino({ level: config.LOG_LEVEL });

/**
 * Вычисляет среднее значение массива чисел
 */
function calculateMean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, val) => sum + val, 0) / values.length;
}

/**
 * Вычисляет стандартное отклонение (выборочное)
 */
function calculateStdDev(values: number[], mean: number): number {
  if (values.length <= 1) return 0;
  const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Проверяет, является ли изменение аномальным
 * Формула ТЗ: Текущее изменение > (Среднее значение + N * Отклонение)
 * Это означает: delta > (mean + N * stddev)
 * Но поскольку мы передаем только delta, stddev и nSigma, 
 * мы проверяем: |delta| > N * stddev (что эквивалентно для больших отклонений)
 */
function isAnomaly(delta: number, stddev: number, nSigma: number, minDeltaThreshold: number): boolean {
  // Проверяем и статистический порог, и минимальное изменение
  return Math.abs(delta) > nSigma * stddev && Math.abs(delta) >= minDeltaThreshold;
}

/**
 * Получает направление аномалии
 */
function getAnomalyDirection(delta: number): 'up' | 'down' {
  return delta > 0 ? 'up' : 'down';
}

/**
 * Анализирует игру на предмет аномалий
 */
export function analyzeGameForAnomalies(gameId: number, currentCcu: number): Anomaly | null {
  try {
    // Получаем настройки аномалий из базы данных
    const settings = getAnomalySettings();
    const { n_sigma, min_delta_threshold } = settings;
    
    // Получаем окно истории за последние 24 часа
    const windowStart = Date.now() - (24 * 60 * 60 * 1000); // 24 часа назад
    const snapshots = getSnapshots(gameId, windowStart);
    
    if (snapshots.length < config.MIN_POINTS_IN_WINDOW) {
      logger.debug({ gameId, snapshotCount: snapshots.length }, 'Недостаточно точек для анализа');
      return null;
    }
    
    // Извлекаем значения CCU из снапшотов
    const ccuValues = snapshots.map(s => s.ccu);
    
    // Вычисляем статистики
    const mean = calculateMean(ccuValues);
    const stddev = calculateStdDev(ccuValues, mean);
    
    // Если стандартное отклонение равно 0, аномалий нет
    if (stddev === 0) {
      logger.debug({ gameId, mean, stddev }, 'Стандартное отклонение равно 0, аномалий нет');
      return null;
    }
    
    // Вычисляем дельту
    const delta = currentCcu - mean;
    
    // Проверяем на аномалию с настройками из БД
    if (!isAnomaly(delta, stddev, n_sigma, min_delta_threshold)) {
      logger.debug({ 
        gameId, 
        delta, 
        threshold: n_sigma * stddev, 
        minThreshold: min_delta_threshold,
        nSigma: n_sigma 
      }, 'Аномалия не обнаружена');
      return null;
    }
    
    // Создаем запись об аномалии
    const anomaly: Omit<Anomaly, 'id' | 'notified'> = {
      game_id: gameId,
      timestamp: Date.now(),
      delta,
      mean,
      stddev,
      threshold: n_sigma * stddev,
      direction: getAnomalyDirection(delta)
    };
    
    logger.info({ 
      gameId, 
      delta, 
      mean, 
      stddev, 
      threshold: anomaly.threshold,
      direction: anomaly.direction,
      nSigma: n_sigma,
      minDeltaThreshold: min_delta_threshold
    }, 'Обнаружена аномалия');
    
    return anomaly;
    
  } catch (error) {
    logger.error({ gameId, error: (error as Error).message }, 'Ошибка при анализе аномалий');
    return null;
  }
}

/**
 * Сохраняет аномалию в базу данных
 */
export function saveAnomaly(anomaly: Omit<Anomaly, 'id' | 'notified'>): number {
  try {
    const anomalyId = insertAnomaly(anomaly);
    logger.info({ anomalyId, gameId: anomaly.game_id }, 'Аномалия сохранена в БД');
    return anomalyId;
  } catch (error) {
    logger.error({ gameId: anomaly.game_id, error: (error as Error).message }, 'Ошибка при сохранении аномалии');
    throw error;
  }
}

/**
 * Получает все неотправленные аномалии
 */
export function getUnnotifiedAnomalies(): Array<Anomaly & { game_title: string; game_url: string }> {
  const stmt = db.prepare(`
    SELECT a.*, g.title as game_title, g.url as game_url 
    FROM anomalies a 
    JOIN games g ON a.game_id = g.id 
    WHERE a.notified = 0 
    ORDER BY a.timestamp ASC
  `);
  
  return stmt.all() as Array<Anomaly & { game_title: string; game_url: string }>;
}

/**
 * Отмечает аномалию как отправленную
 */
export function markAnomalyAsNotified(anomalyId: number): void {
  try {
    markAnomalyNotified(anomalyId);
    logger.debug({ anomalyId }, 'Аномалия отмечена как отправленная');
  } catch (error) {
    logger.error({ anomalyId, error: (error as Error).message }, 'Ошибка при отметке аномалии как отправленной');
    throw error;
  }
}

/**
 * Анализирует все игры на предмет аномалий
 */
export function analyzeAllGamesForAnomalies(): { anomaliesFound: number; errors: number } {
  let anomaliesFound = 0;
  let errors = 0;
  
  try {
    // Получаем все игры с их последними снапшотами
    const stmt = db.prepare(`
      SELECT g.id, g.title, s.ccu, s.timestamp
      FROM games g
      JOIN snapshots s ON g.id = s.game_id
      WHERE s.timestamp = (
        SELECT MAX(timestamp) 
        FROM snapshots s2 
        WHERE s2.game_id = g.id
      )
      AND s.timestamp >= ? -- Только свежие данные (последние 2 часа)
    `);
    
    const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
    const gamesWithSnapshots = stmt.all(twoHoursAgo) as Array<{
      id: number;
      title: string;
      ccu: number;
      timestamp: number;
    }>;
    
    logger.info({ gameCount: gamesWithSnapshots.length }, 'Начинаем анализ аномалий для всех игр');
    
    for (const game of gamesWithSnapshots) {
      try {
        const anomaly = analyzeGameForAnomalies(game.id, game.ccu);
        
        if (anomaly) {
          saveAnomaly(anomaly);
          anomaliesFound++;
        }
      } catch (error) {
        errors++;
        logger.error({ gameId: game.id, error: (error as Error).message }, 'Ошибка при анализе игры');
      }
    }
    
    logger.info({ anomaliesFound, errors }, 'Анализ аномалий завершен');
    
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Ошибка при анализе всех игр');
    errors++;
  }
  
  return { anomaliesFound, errors };
}
