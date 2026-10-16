import type Database from 'better-sqlite3'

export function initProductionQualitySchema(sqlite: Database.Database) {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS production_quality_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, version_id INTEGER NOT NULL,
    kind TEXT NOT NULL, parent_id INTEGER, round INTEGER NOT NULL DEFAULT 0,
    input_hash TEXT NOT NULL, request_key TEXT NOT NULL UNIQUE,
    config_id INTEGER NOT NULL DEFAULT 0, model TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending', input_json TEXT NOT NULL,
    result_json TEXT NOT NULL DEFAULT '', error TEXT, applied_version_id INTEGER,
    created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_quality_version ON production_quality_tasks(version_id,id);
  CREATE INDEX IF NOT EXISTS idx_quality_status ON production_quality_tasks(status);`)
}
