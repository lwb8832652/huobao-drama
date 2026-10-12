/** Shared frame limits for new plans and edits; empty panels remain valid. */
export const FRAME_COUNT_MIN = 1
export const FRAME_COUNT_MAX = 9
export const FRAME_COUNT_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const

/** 宫格布局：M×N 表示 M 列 × N 行，画面数 = M*N，正好铺满不留白。 */
export interface FrameGridLayout {
  label: string
  columns: number
  rows: number
  count: number
}
/**
 * 分镜画面拆分可选宫格布局（横屏基准，列 ≤ 行：1×2 / 2×2 / 1×3 / 2×3 / 3×3）。
 * 竖屏画面会翻转列行（1×2 → 2×1），让每个分格与画面保持同向。
 */
export const FRAME_GRID_LAYOUTS: readonly FrameGridLayout[] = [
  { label: '1×2', columns: 1, rows: 2, count: 2 },
  { label: '2×2', columns: 2, rows: 2, count: 4 },
  { label: '1×3', columns: 1, rows: 3, count: 3 },
  { label: '2×3', columns: 2, rows: 3, count: 6 },
  { label: '3×3', columns: 3, rows: 3, count: 9 },
]
export const FRAME_GRID_COUNTS = FRAME_GRID_LAYOUTS.map(layout => layout.count) as number[]

/** 解析画布比例「宽:高」；非法或缺省按横屏 16:9 处理。 */
function parseRatio(aspectRatio?: string): { width: number; height: number } {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspectRatio || '')
  if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) return { width: 16, height: 9 }
  return { width: Number(match[1]), height: Number(match[2]) }
}
/** 竖屏（宽 < 高）画面需要把宫格布局翻转列行，使每个分格与画面同向。 */
export function isPortraitRatio(aspectRatio?: string): boolean {
  const { width, height } = parseRatio(aspectRatio)
  return width < height
}
/** 适配画面比例的宫格布局列表：竖屏时翻转列行（1×2 → 2×1），横屏保持不变。 */
export function gridLayoutsForRatio(aspectRatio?: string): FrameGridLayout[] {
  if (!isPortraitRatio(aspectRatio)) return [...FRAME_GRID_LAYOUTS]
  return FRAME_GRID_LAYOUTS.map(layout => ({
    ...layout, columns: layout.rows, rows: layout.columns, label: `${layout.rows}×${layout.columns}`,
  }))
}

/** 由画面数反查宫格布局：标准数量精确命中；历史/手动增删的非标准数量向上取最近的宫格，超出格数留白。 */
export function gridLayoutForCount(count: number, aspectRatio?: string): FrameGridLayout {
  if (count <= 1) return { label: '1×1', columns: 1, rows: 1, count: 1 }
  const layouts = gridLayoutsForRatio(aspectRatio)
  const exact = layouts.find(layout => layout.count === count)
  if (exact) return exact
  // 向上取「count 最小且 ≥ 目标」的宫格，不依赖数组顺序（布局数组按列×行而非数量排序）。
  let best: FrameGridLayout | undefined
  for (const layout of layouts) {
    if (layout.count >= count && (!best || layout.count < best.count)) best = layout
  }
  return best || layouts[layouts.length - 1]
}

/** Legacy panels above the limit may keep or remove existing frames, but cannot introduce new IDs. */
export function frameCountChangeAllowed(next: readonly { id?: string }[], before: readonly { id?: string }[] = []) {
  if (next.length <= FRAME_COUNT_MAX) return true
  if (before.length <= FRAME_COUNT_MAX || next.length > before.length) return false
  const existingIds = new Set(before.map(frame => frame.id).filter(Boolean))
  return next.every(frame => !!frame.id && existingIds.has(frame.id))
}
