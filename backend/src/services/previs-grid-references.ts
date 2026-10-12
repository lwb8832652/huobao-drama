import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { normalizeTimeline, orderedFrames, type Panel } from './previs-domain.js'
import { episodeForPrevis, PrevisError, versionRow } from './previs.js'

export interface GridReferenceItem {
  url: string | null
  label: string
  kind: 'scene' | 'character' | 'prop' | 'custom'
  required: boolean
}
export interface GridReferenceManifest {
  items: GridReferenceItem[]
  ready: boolean
  error: string
}

/** Only the two supported local static spellings identify the same source. */
function referenceUrl(url: string) {
  return /^\/?static\//.test(url) ? `/${url.replace(/^\//, '')}` : url
}

/** Metadata only: no freezing, file access, network requests, or provider work. */
export function resolvePanelGridReferences(panel: Panel, dramaId: number): GridReferenceManifest {
  const items: GridReferenceItem[] = []
  const labels = new Map<string, string[]>()
  const errors: string[] = []
  function add(item: GridReferenceItem) {
    if (!item.url) { items.push(item); return }
    const url = referenceUrl(item.url)
    const existing = items.find(item => item.url === url)
    if (existing) {
      const names = labels.get(url)!
      if (!names.includes(item.label)) names.push(item.label)
      existing.label = names.join('；')
      existing.required ||= item.required
      return
    }
    labels.set(url, [item.label])
    items.push({ ...item, url })
  }
  type Asset = { dramaId: number; deletedAt: string | null; imageUrl: string | null }
  function bound(row: Asset | undefined, label: string, kind: GridReferenceItem['kind']) {
    const reason = !row ? '绑定资产不存在' : row.dramaId !== dramaId ? '绑定资产不属于当前作品'
      : row.deletedAt ? '绑定资产已删除' : !row.imageUrl?.trim() ? '尚未生成或上传参考图片' : ''
    if (reason) errors.push(`${label}缺少可用参考图片：${reason}`)
    add({ url: reason ? null : row!.imageUrl, label, kind, required: true })
  }
  if (panel.sceneId) {
    const row = db.select().from(schema.scenes).where(eq(schema.scenes.id, panel.sceneId)).get()
    bound(row, `场景「${row && row.dramaId === dramaId && !row.deletedAt ? row.location : panel.scene || panel.sceneId}」`, 'scene')
  }
  for (const id of new Set(panel.characterIds)) {
    const row = db.select().from(schema.characters).where(eq(schema.characters.id, id)).get()
    bound(row, `人物「${row && row.dramaId === dramaId && !row.deletedAt ? row.name : id}」`, 'character')
  }
  for (const id of new Set(panel.propIds)) {
    const row = db.select().from(schema.props).where(eq(schema.props.id, id)).get()
    bound(row, `道具「${row && row.dramaId === dramaId && !row.deletedAt ? row.name : id}」`, 'prop')
  }
  panel.referenceImages.forEach((url, index) => add({ url, label: panel.referenceLabels?.[index] || `共同参考素材${index + 1}`, kind: 'custom', required: false }))
  for (const [index, frame] of orderedFrames(panel).entries()) {
    frame.referenceImages?.forEach((url, refIndex) => add({ url, label: `画格${index + 1}参考素材${refIndex + 1}`, kind: 'custom', required: false }))
  }
  if (!items.some(item => item.url) && !errors.length) errors.push('请先绑定资产或上传参考图片，再生成联合宫格')
  return { items, ready: !errors.length, error: errors.join('；') }
}

export function readGridReferences(versionId: number, panelId: number): GridReferenceManifest {
  const version = versionRow(versionId)
  const episode = episodeForPrevis(version.episodeId)
  const panel = normalizeTimeline(JSON.parse(version.timelineJson)).panels.find(panel => panel.id === panelId)
  if (!panel) throw new PrevisError('分镜不属于当前版本', 404)
  return resolvePanelGridReferences(panel, episode.dramaId)
}
