import type Database from 'better-sqlite3'
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core'
export const gridCandidates = sqliteTable('previs_grid_candidates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  versionId: integer('version_id').notNull(),
  panelId: integer('panel_id').notNull(),
  mode: text('mode').notNull(),
  status: text('status').notNull().default('pending'),
  inputHash: text('input_hash').notNull(),
  snapshotJson: text('snapshot_json').notNull(),
  taskId: integer('task_id'),
  rawUrl: text('raw_url'),
  previewUrl: text('preview_url'),
  width: integer('width'),
  height: integer('height'),
  sourceWidth: integer('source_width'),
  sourceHeight: integer('source_height'),
  error: text('error'),
  batchNo: integer('batch_no').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})
export function initGridSchema(sqlite: Database.Database) {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS previs_grid_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT, version_id INTEGER NOT NULL, panel_id INTEGER NOT NULL,
    mode TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', input_hash TEXT NOT NULL, snapshot_json TEXT NOT NULL,
    task_id INTEGER, raw_url TEXT, preview_url TEXT, width INTEGER, height INTEGER,
    source_width INTEGER, source_height INTEGER, error TEXT,
    batch_no INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS idx_grid_version_panel ON previs_grid_candidates(version_id,panel_id);
  CREATE INDEX IF NOT EXISTS idx_grid_status ON previs_grid_candidates(status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_grid_inflight ON previs_grid_candidates(version_id,panel_id)
    WHERE status IN ('pending','processing');`)
  // 旧库补列（沿用 previs-schema.ts 的迁移模式）：历史候选 batch_no=0，UI 归入「历史生成」
  const columns = sqlite.prepare('PRAGMA table_info(previs_grid_candidates)').all() as { name: string }[]
  if (!columns.some(c => c.name === 'batch_no'))
    sqlite.exec('ALTER TABLE previs_grid_candidates ADD COLUMN batch_no INTEGER NOT NULL DEFAULT 0')
  // 上游画布比例与冻结布局不符时，服务端会中心裁切适配并把上游原尺寸记在这里（NULL = 未裁切）
  if (!columns.some(c => c.name === 'source_width'))
    sqlite.exec('ALTER TABLE previs_grid_candidates ADD COLUMN source_width INTEGER')
  if (!columns.some(c => c.name === 'source_height'))
    sqlite.exec('ALTER TABLE previs_grid_candidates ADD COLUMN source_height INTEGER')
}
