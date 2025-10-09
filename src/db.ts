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

  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY,
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    timestamp INTEGER NOT NULL,
    ccu INTEGER NOT NULL
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
  const insert = db.prepare(
    `INSERT INTO games (source_id, title, url, created_at, updated_at)
     VALUES (@source_id, @title, @url, @created_at, @updated_at)
     ON CONFLICT(source_id) DO UPDATE SET title=excluded.title, url=excluded.url, updated_at=excluded.updated_at`
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
  const row = db.prepare('SELECT id FROM games WHERE source_id = ?').get(game.source_id) as {
    id: number;
  } | undefined;
  if (!row) throw new Error('Failed to upsert game');
  return row.id;
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


