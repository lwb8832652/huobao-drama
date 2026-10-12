import { frameKey, orderedFrames, type Panel } from './previs-domain.js'

export type ContactSheetStatus = 'none' | 'composing' | 'ready' | 'stale' | 'failed'
export interface ContactSheetCell {
  frameId: string
  index: number
  offsetMs: number
  url: string
  left: number
  top: number
  width: number
  height: number
}
export interface ContactSheetDescriptor {
  version: 1
  panelId: number
  aspectRatio: string
  columns: number
  rows: number
  width: number
  height: number
  cells: ContactSheetCell[]
}
export interface ContactSheetView {
  panelId: number
  sourceHash: string
  artifactId: number | null
  artifactHash: string | null
  status: ContactSheetStatus
  annotatedUrl: string | null
  cleanUrl: string | null
  thumbnailUrl: string | null
  descriptor: ContactSheetDescriptor | null
  readyFrames: number
  totalFrames: number
  error: string | null
}
export function contactSheetLayout(count: number) {
  if (!Number.isInteger(count) || count < 1 || count > 9) throw new RangeError('宫格支持 1～9 张画面')
  return count === 1 ? { columns: 1, rows: 1 }
    : count === 2 ? { columns: 2, rows: 1 }
    : count <= 4 ? { columns: 2, rows: 2 }
    : count <= 6 ? { columns: 3, rows: 2 } : { columns: 3, rows: 3 }
}
export function contactSheetDescriptor(panel: Panel, aspectRatio: string): ContactSheetDescriptor {
  const { columns, rows } = contactSheetLayout(panel.frames.length)
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspectRatio)
  if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) throw new Error('项目画布比例无效')
  const ratio = Number(match[1]) / Number(match[2])
  if (ratio < .1 || ratio > 10) throw new Error('项目画布比例无效')
  const width = ratio >= 1 ? 3072 : Math.round(3072 * ratio / 2) * 2
  const height = ratio >= 1 ? Math.round(3072 / ratio / 2) * 2 : 3072
  return { version: 1, panelId: panel.id, aspectRatio, columns, rows, width, height,
    cells: orderedFrames(panel).map((frame, i) => {
      const col = i % columns, row = Math.floor(i / columns)
      const left = Math.floor(col * width / columns), top = Math.floor(row * height / rows)
      return { frameId: frameKey(frame), index: i + 1, offsetMs: frame.offsetMs || 0, url: frame.url,
        left, top, width: Math.floor((col + 1) * width / columns) - left,
        height: Math.floor((row + 1) * height / rows) - top }
    }) }
}
