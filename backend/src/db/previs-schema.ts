import type Database from 'better-sqlite3'
import { sqliteTable, integer, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// Groups, panels, transitions and audio belong to a version's snapshot, never to shared mutable rows.
export const animaticVersions = sqliteTable('animatic_versions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  versionNo: integer('version_no').notNull(),
  revision: integer('revision').notNull().default(1),
  status: text('status').notNull().default('draft'),
  timelineJson: text('timeline_json').notNull(),
  contentHash: text('content_hash'),
  lockedAt: text('locked_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})
export const batchRuns = sqliteTable('batch_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  versionId: integer('version_id').notNull(),
  type: text('type').notNull(),
  status: text('status').notNull().default('pending'),
  requestHash: text('request_hash').notNull(),
  configId: integer('config_id').notNull(),
  model: text('model').notNull(),
  createdAt: text('created_at').notNull(),
})
export const batchRunItems = sqliteTable('batch_run_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  batchId: integer('batch_id').notNull(),
  groupId: text('group_id').notNull(),
  panelId: integer('panel_id'),
  frameType: text('frame_type'),
  requestJson: text('request_json').notNull(),
  status: text('status').notNull().default('pending'),
  taskId: integer('task_id'),
  attempt: integer('attempt').notNull().default(0),
  error: text('error'),
})
export const continuityReviews = sqliteTable('continuity_reviews', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  versionId: integer('version_id').notNull(),
  fromGroupId: text('from_group_id').notNull(),
  toGroupId: text('to_group_id').notNull(),
  inputHash: text('input_hash').notNull(),
  configId: integer('config_id').notNull(),
  model: text('model').notNull(),
  status: text('status').notNull().default('completed'),
  resultJson: text('result_json').notNull().default(''),
  error: text('error'),
  createdAt: text('created_at').notNull(),
}, table => [
  uniqueIndex('idx_continuity_review_input').on(
    table.versionId, table.fromGroupId, table.toGroupId, table.inputHash,
  ),
])

export function initPrevisSchema(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS animatic_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, episode_id INTEGER NOT NULL, version_no INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'draft',
      timeline_json TEXT NOT NULL, content_hash TEXT, locked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(episode_id, version_no)
    );
    CREATE TRIGGER IF NOT EXISTS animatic_locked_immutable BEFORE UPDATE ON animatic_versions
    WHEN OLD.status = 'locked'
    BEGIN SELECT RAISE(ABORT, 'Locked animatic versions are immutable'); END;
    CREATE TABLE IF NOT EXISTS batch_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, version_id INTEGER NOT NULL, type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', request_hash TEXT NOT NULL,
      config_id INTEGER NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(version_id, request_hash)
    );
    CREATE TABLE IF NOT EXISTS batch_run_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER NOT NULL, group_id TEXT NOT NULL,
      panel_id INTEGER, frame_type TEXT, request_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', task_id INTEGER, attempt INTEGER NOT NULL DEFAULT 0, error TEXT
    );
    CREATE TABLE IF NOT EXISTS continuity_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT, version_id INTEGER NOT NULL,
      from_group_id TEXT NOT NULL, to_group_id TEXT NOT NULL, input_hash TEXT NOT NULL,
      config_id INTEGER NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'completed',
      result_json TEXT NOT NULL DEFAULT '', error TEXT, created_at TEXT NOT NULL,
      UNIQUE(version_id, from_group_id, to_group_id, input_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_previs_batch_version ON batch_runs(version_id);
    CREATE INDEX IF NOT EXISTS idx_previs_batch_version_type ON batch_runs(version_id, type);
    CREATE INDEX IF NOT EXISTS idx_previs_batch_status ON batch_runs(status);
    CREATE INDEX IF NOT EXISTS idx_previs_items_batch ON batch_run_items(batch_id);
    CREATE INDEX IF NOT EXISTS idx_previs_items_batch_status ON batch_run_items(batch_id, status);
    CREATE INDEX IF NOT EXISTS idx_previs_items_status ON batch_run_items(status);
    CREATE INDEX IF NOT EXISTS idx_continuity_review_version ON continuity_reviews(version_id);
  `)
  const reviewColumns = sqlite.prepare('PRAGMA table_info(continuity_reviews)').all() as { name: string }[]
  if (!reviewColumns.some(c => c.name === 'status')) {
    sqlite.exec("ALTER TABLE continuity_reviews ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'")
  }
  if (!reviewColumns.some(c => c.name === 'error')) {
    sqlite.exec('ALTER TABLE continuity_reviews ADD COLUMN error TEXT')
  }
  const columns = sqlite.prepare('PRAGMA table_info(sys_task)').all() as { name: string }[]
  for (const [name, type] of [['animatic_version_id', 'INTEGER'], ['previs_item_key', 'TEXT']]) {
    if (!columns.some(c => c.name === name)) sqlite.exec(`ALTER TABLE sys_task ADD COLUMN ${name} ${type}`)
  }
  sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_previs_item_key ON sys_task(previs_item_key) WHERE previs_item_key IS NOT NULL')
}
