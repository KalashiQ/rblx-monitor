export type Game = {
  id?: number;
  source_id: string;
  title: string;
  url: string;
  created_at?: number;
  updated_at?: number;
  ccu?: number; // Current CCU from rotrends
};

export type Snapshot = {
  id?: number;
  game_id: number;
  timestamp: number;
  ccu: number;
};

export type AnomalyDirection = 'up' | 'down';

export type Anomaly = {
  id?: number;
  game_id: number;
  timestamp: number;
  delta: number;
  mean: number;
  stddev: number;
  threshold: number;
  direction: AnomalyDirection;
  notified?: 0 | 1;
};


