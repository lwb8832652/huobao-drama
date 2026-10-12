/** Paid generation geometry is distinct from the adaptive display contact sheet. */
export type GridMode = 'generate' | 'grid_edit' | 'frame_edit'
export interface GenerationGrid {
  columns: number
  rows: number
  cells: { frameId: string; index: number }[]
}
export function generationGrid(frameIds: string[]): GenerationGrid {
  if (frameIds.length < 1 || frameIds.length > 9) throw new Error('联合生图需要 1～9 个画面')
  if (frameIds.some((id) => !id) || new Set(frameIds).size !== frameIds.length)
    throw new Error('画面 ID 不能为空或重复')
  const side = frameIds.length === 1 ? 1 : frameIds.length <= 4 ? 2 : 3
  return { columns: side, rows: side, cells: frameIds.map((frameId, index) => ({ frameId, index })) }
}
export function gridBounds(index: number, grid: GenerationGrid, width: number, height: number) {
  const column = index % grid.columns,
    row = Math.floor(index / grid.columns)
  const left = Math.floor((column * width) / grid.columns),
    top = Math.floor((row * height) / grid.rows)
  return {
    left,
    top,
    width: Math.floor(((column + 1) * width) / grid.columns) - left,
    height: Math.floor(((row + 1) * height) / grid.rows) - top,
  }
}
export function validateGridTargets(grid: GenerationGrid, targets: string[]) {
  if (
    !targets.length ||
    new Set(targets).size !== targets.length ||
    targets.some((id) => !grid.cells.some((c) => c.frameId === id))
  ) {
    throw new Error('请选择有效且不重复的目标画面')
  }
}
