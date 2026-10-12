/** Shared frame limits for new plans and edits; empty panels remain valid. */
export const FRAME_COUNT_MIN = 1
export const FRAME_COUNT_MAX = 9
export const FRAME_COUNT_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const

/** Legacy panels above the limit may keep or remove existing frames, but cannot introduce new IDs. */
export function frameCountChangeAllowed(next: readonly { id?: string }[], before: readonly { id?: string }[] = []) {
  if (next.length <= FRAME_COUNT_MAX) return true
  if (before.length <= FRAME_COUNT_MAX || next.length > before.length) return false
  const existingIds = new Set(before.map(frame => frame.id).filter(Boolean))
  return next.every(frame => !!frame.id && existingIds.has(frame.id))
}
