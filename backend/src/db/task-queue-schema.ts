import type Database from 'better-sqlite3'

export function initTaskQueueSchema(sqlite: Database.Database) {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS task_queue_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_type TEXT NOT NULL, owner_id INTEGER NOT NULL, kind TEXT NOT NULL,
    project_id INTEGER NOT NULL DEFAULT 0, config_id INTEGER NOT NULL DEFAULT 0,
    input_hash TEXT NOT NULL, snapshot_json TEXT NOT NULL DEFAULT '{}', source TEXT NOT NULL DEFAULT 'manual',
    status TEXT NOT NULL DEFAULT 'pending', phase TEXT NOT NULL DEFAULT 'queued', ready INTEGER NOT NULL DEFAULT 1,
    submitted INTEGER NOT NULL DEFAULT 0, external_task_id TEXT, upstream_done INTEGER NOT NULL DEFAULT 0,
    attempt INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    started_at TEXT, finished_at TEXT, UNIQUE(owner_type, owner_id)
  );
  CREATE INDEX IF NOT EXISTS idx_task_queue_state ON task_queue_jobs(status, kind, project_id, id);
  CREATE TABLE IF NOT EXISTS task_queue_cursors (key TEXT PRIMARY KEY, value TEXT NOT NULL);`)
}
