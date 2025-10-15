import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from './config';
import type { Game, Snapshot, Anomaly } from './types';

// Ensure data directory exists if using relative default path
const dbPath = path.resolve(process.cwd(), config.DB_PATH);
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

export function initSchema(): void {
  const createSql = `
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY,
    source_id TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- Гарантия уникальности URL для предотвращения дублей на стадии записи
  CREATE UNIQUE INDEX IF NOT EXISTS idx_games_url_unique ON games(url);

  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY,
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    timestamp INTEGER NOT NULL,
    ccu INTEGER NOT NULL,
    roblox_url TEXT,
    game_title TEXT,
    readable_time TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_snapshots_game_time ON snapshots(game_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_snapshots_time ON snapshots(timestamp);

  CREATE TABLE IF NOT EXISTS anomalies (
    id INTEGER PRIMARY KEY,
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    timestamp INTEGER NOT NULL,
    delta REAL NOT NULL,
    mean REAL NOT NULL,
    stddev REAL NOT NULL,
    threshold REAL NOT NULL,
    direction TEXT NOT NULL,
    notified INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_anomalies_game_time ON anomalies(game_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_anomalies_notified ON anomalies(notified);

  CREATE TABLE IF NOT EXISTS anomaly_settings (
    id INTEGER PRIMARY KEY DEFAULT 1,
    n_sigma REAL NOT NULL DEFAULT 3.0,
    min_delta_threshold INTEGER NOT NULL DEFAULT 10,
    custom_message TEXT,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
  );

  -- Вставляем настройки по умолчанию, если их нет
  INSERT OR IGNORE INTO anomaly_settings (id, n_sigma, min_delta_threshold) 
  VALUES (1, 3.0, 10);

  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `;

  db.exec(createSql);
}

// DAO
export function upsertGame(game: Omit<Game, 'id' | 'created_at' | 'updated_at'>): number {
  const now = Date.now();
  
  // Если уже существует игра с таким же URL — считаем это дубликатом и ничего не записываем
  const existingByUrl = db.prepare('SELECT id FROM games WHERE url = ?').get(game.url) as { id: number } | undefined;
  if (existingByUrl) {
    return existingByUrl.id;
  }

  // Сначала проверяем, существует ли игра с таким же title (предотвращаем дубликаты по названию)
  const existingByTitle = db.prepare('SELECT id, source_id FROM games WHERE title = ?').get(game.title) as {
    id: number;
    source_id: string;
  } | undefined;
  
  if (existingByTitle) {
    // Если найдена игра с таким же названием, обновляем только url (не трогаем source_id)
    const update = db.prepare(
      `UPDATE games SET url=@url, updated_at=@updated_at WHERE id=@id`
    );
    update.run({
      id: existingByTitle.id,
      url: game.url,
      updated_at: now,
    });
    return existingByTitle.id;
  }
  
  // Если не найдена игра с таким же названием, проверяем по source_id
  const existingBySourceId = db.prepare('SELECT id FROM games WHERE source_id = ?').get(game.source_id) as {
    id: number;
  } | undefined;
  
  if (existingBySourceId) {
    // Обновляем существующую игру
    const update = db.prepare(
      `UPDATE games SET title=@title, url=@url, updated_at=@updated_at WHERE source_id=@source_id`
    );
    update.run({
      source_id: game.source_id,
      title: game.title,
      url: game.url,
      updated_at: now,
    });
    return existingBySourceId.id;
  } else {
    // Вставляем новую игру
    const insert = db.prepare(
      `INSERT INTO games (source_id, title, url, created_at, updated_at)
       VALUES (@source_id, @title, @url, @created_at, @updated_at)`
    );
    const info = insert.run({
      source_id: game.source_id,
      title: game.title,
      url: game.url,
      created_at: now,
      updated_at: now,
    });
    if (info.lastInsertRowid && typeof info.lastInsertRowid === 'number') {
      return info.lastInsertRowid;
    }
    throw new Error('Failed to insert game');
  }
}

export function upsertGameWithStatus(game: Omit<Game, 'id' | 'created_at' | 'updated_at'>): { gameId: number; isNew: boolean; skipped: boolean } {
  const now = Date.now();
  
  // Если уже существует игра с таким же URL — пропускаем её полностью
  const existingByUrl = db.prepare('SELECT id FROM games WHERE url = ?').get(game.url) as { id: number } | undefined;
  if (existingByUrl) {
    console.log(`[DEBUG] Пропускаем игру "${game.title}" (URL: ${game.url}) - дубликат найден в базе данных (ID: ${existingByUrl.id})`);
    return { gameId: existingByUrl.id, isNew: false, skipped: true };
  }

  // Сначала проверяем, существует ли игра с таким же title (предотвращаем дубликаты по названию)
  const existingByTitle = db.prepare('SELECT id, source_id FROM games WHERE title = ?').get(game.title) as {
    id: number;
    source_id: string;
  } | undefined;
  
  if (existingByTitle) {
    // Если найдена игра с таким же названием, обновляем только url (не трогаем source_id)
    const update = db.prepare(
      `UPDATE games SET url=@url, updated_at=@updated_at WHERE id=@id`
    );
    update.run({
      id: existingByTitle.id,
      url: game.url,
      updated_at: now,
    });
    return { gameId: existingByTitle.id, isNew: false, skipped: false };
  }
  
  // Если не найдена игра с таким же названием, проверяем по source_id
  const existingBySourceId = db.prepare('SELECT id FROM games WHERE source_id = ?').get(game.source_id) as {
    id: number;
  } | undefined;
  
  if (existingBySourceId) {
    // Обновляем существующую игру
    const update = db.prepare(
      `UPDATE games SET title=@title, url=@url, updated_at=@updated_at WHERE source_id=@source_id`
    );
    update.run({
      source_id: game.source_id,
      title: game.title,
      url: game.url,
      updated_at: now,
    });
    return { gameId: existingBySourceId.id, isNew: false, skipped: false };
  } else {
    // Вставляем новую игру
    const insert = db.prepare(
      `INSERT INTO games (source_id, title, url, created_at, updated_at)
       VALUES (@source_id, @title, @url, @created_at, @updated_at)`
    );
    const info = insert.run({
      source_id: game.source_id,
      title: game.title,
      url: game.url,
      created_at: now,
      updated_at: now,
    });
    if (info.lastInsertRowid && typeof info.lastInsertRowid === 'number') {
      return { gameId: info.lastInsertRowid, isNew: true, skipped: false };
    }
    throw new Error('Failed to insert game');
  }
}

export function upsertGameWithCcu(game: Omit<Game, 'id' | 'created_at' | 'updated_at'>): { gameId: number; ccu: number | null } {
  const gameId = upsertGame(game);
  const ccu = game.ccu ?? null;
  return { gameId, ccu };
}

export function insertSnapshot(snapshot: Omit<Snapshot, 'id'>): number {
  const stmt = db.prepare(
    `INSERT INTO snapshots (game_id, timestamp, ccu) VALUES (@game_id, @timestamp, @ccu)`
  );
  const info = stmt.run(snapshot as Snapshot);
  return Number(info.lastInsertRowid);
}

export function getSnapshots(gameId: number, sinceMs: number): Snapshot[] {
  const stmt = db.prepare(
    `SELECT id, game_id, timestamp, ccu FROM snapshots WHERE game_id = ? AND timestamp >= ? ORDER BY timestamp ASC`
  );
  return stmt.all(gameId, sinceMs) as Snapshot[];
}

export function insertAnomaly(anomaly: Omit<Anomaly, 'id' | 'notified'> & { notified?: 0 | 1 }): number {
  const stmt = db.prepare(
    `INSERT INTO anomalies (game_id, timestamp, delta, mean, stddev, threshold, direction, notified)
     VALUES (@game_id, @timestamp, @delta, @mean, @stddev, @threshold, @direction, @notified)`
  );
  const info = stmt.run({ ...anomaly, notified: anomaly.notified ?? 0 });
  return Number(info.lastInsertRowid);
}

export function markAnomalyNotified(id: number): void {
  db.prepare(`UPDATE anomalies SET notified = 1 WHERE id = ?`).run(id);
}

export function clearTables(): void {
  // Очищаем таблицы в правильном порядке (сначала зависимые, потом основные)
  db.prepare('DELETE FROM anomalies').run();
  db.prepare('DELETE FROM snapshots').run();
  db.prepare('DELETE FROM games').run();
}

// Функции для работы с настройками аномалий
export function getAnomalySettings(): { n_sigma: number; min_delta_threshold: number; custom_message: string | null } {
  const stmt = db.prepare('SELECT n_sigma, min_delta_threshold, custom_message FROM anomaly_settings WHERE id = 1');
  const result = stmt.get() as { n_sigma: number; min_delta_threshold: number; custom_message: string | null } | undefined;
  
  if (!result) {
    // Возвращаем настройки по умолчанию
    return { n_sigma: 3.0, min_delta_threshold: 10, custom_message: null };
  }
  
  return result;
}

export function updateAnomalySettings(nSigma: number, minDeltaThreshold: number): void {
  const stmt = db.prepare(`
    UPDATE anomaly_settings 
    SET n_sigma = ?, min_delta_threshold = ?, updated_at = ?
    WHERE id = 1
  `);
  stmt.run(nSigma, minDeltaThreshold, Date.now());
}

export function updateCustomMessage(customMessage: string | null): void {
  const stmt = db.prepare(`
    UPDATE anomaly_settings 
    SET custom_message = ?, updated_at = ?
    WHERE id = 1
  `);
  stmt.run(customMessage, Date.now());
}

/**
 * Очищает старые снапшоты (старше указанного количества дней)
 */
export function cleanupOldSnapshots(daysToKeep: number = 3): { deletedCount: number } {
  const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
  
  // Получаем количество записей для удаления
  const countStmt = db.prepare('SELECT COUNT(*) as count FROM snapshots WHERE timestamp < ?');
  const countResult = countStmt.get(cutoffTime) as { count: number };
  const deletedCount = countResult.count;
  
  // Удаляем старые снапшоты
  const deleteStmt = db.prepare('DELETE FROM snapshots WHERE timestamp < ?');
  deleteStmt.run(cutoffTime);
  
  return { deletedCount };
}

/**
 * Очищает старые аномалии (старше указанного количества дней)
 */
export function cleanupOldAnomalies(daysToKeep: number = 30): { deletedCount: number } {
  const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
  
  // Получаем количество записей для удаления
  const countStmt = db.prepare('SELECT COUNT(*) as count FROM anomalies WHERE timestamp < ?');
  const countResult = countStmt.get(cutoffTime) as { count: number };
  const deletedCount = countResult.count;
  
  // Удаляем старые аномалии
  const deleteStmt = db.prepare('DELETE FROM anomalies WHERE timestamp < ?');
  deleteStmt.run(cutoffTime);
  
  return { deletedCount };
}

/**
 * Удаляет дубликаты игр по URL, оставляя только самую старую запись
 */
export function removeDuplicateGames(): { duplicatesRemoved: number; gamesRemaining: number } {
  // Находим дубликаты по URL
  const duplicates = db.prepare(`
    SELECT url, COUNT(*) as count, MIN(id) as keep_id, GROUP_CONCAT(id) as all_ids
    FROM games 
    GROUP BY url 
    HAVING COUNT(*) > 1
  `).all() as Array<{ url: string; count: number; keep_id: number; all_ids: string }>;
  
  let duplicatesRemoved = 0;
  
  for (const duplicate of duplicates) {
    const idsToDelete = duplicate.all_ids.split(',').map(id => parseInt(id.trim(), 10)).filter(id => id !== duplicate.keep_id);
    
    // Удаляем дубликаты, оставляя только самую старую запись
    for (const idToDelete of idsToDelete) {
      db.prepare('DELETE FROM games WHERE id = ?').run(idToDelete);
      duplicatesRemoved++;
    }
  }
  
  // Получаем количество оставшихся игр
  const gamesRemaining = db.prepare('SELECT COUNT(*) as count FROM games').get() as { count: number };
  
  return {
    duplicatesRemoved,
    gamesRemaining: gamesRemaining.count
  };
}

/**
 * Выполняет полную очистку старых данных
 */
export function performDataCleanup(): { 
  snapshotsDeleted: number; 
  anomaliesDeleted: number; 
  totalDeleted: number;
} {
  const snapshotsResult = cleanupOldSnapshots(3); // 3 дня для снапшотов
  const anomaliesResult = cleanupOldAnomalies(30); // 30 дней для аномалий
  
  return {
    snapshotsDeleted: snapshotsResult.deletedCount,
    anomaliesDeleted: anomaliesResult.deletedCount,
    totalDeleted: snapshotsResult.deletedCount + anomaliesResult.deletedCount
  };
}
