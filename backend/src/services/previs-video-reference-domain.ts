import { frameKey, orderedFrames, type Panel } from './previs-domain.js'
export type VideoReferenceInputStrategy = 'auto' | 'individual' | 'contact_sheet'
export interface VideoReferenceInput {
  version: 1
  generationScope?: 'storyboard' | 'group'
  requested: VideoReferenceInputStrategy
  effective: 'individual' | 'contact_sheet'
  aspectRatio: string
  imageUrls: string[]
  imageDigests: string[]
  panels: { panelId: number; durationMs: number; sheetId: number | null; sheetHash: string | null;
    frames: { frameId: string; imageIndex: number; gridIndex: number | null; offsetMs: number; sourceUrl: string }[] }[]
}
export function selectVideoReferenceStrategy(panels: Panel[], requested: VideoReferenceInputStrategy, maxImages: number, generationScope: 'storyboard' | 'group' = 'storyboard') {
  if (!panels.length || panels.some(p => !p.frames.length)) throw new Error('尚无分镜画面，请先添加并生成画面')
  if (panels.some(p => p.frames.length > 9)) throw new Error('单个分镜最多支持 9 张画面，请先整理历史画面')
  const missing = panels.flatMap(p => p.frames).filter(frame => !frame.url).length
  if (missing) throw new Error(`还有 ${missing} 张分镜画面未完成，请全部生成或上传后再生成视频`)
  const count = panels.reduce((sum, panel) => sum + panel.frames.length, 0)
  const effective = requested === 'auto' ? generationScope === 'group' || panels.length > 1 || count > maxImages ? 'contact_sheet' : 'individual' : requested
  const inputs = effective === 'contact_sheet' ? panels.length : count
  if (inputs > maxImages) throw new Error(`当前输入 ${inputs} 张，模型最多接收 ${maxImages} 张参考图，请改为按分镜生成或减少输入范围`)
  return effective
}
export function videoReferenceLegend(input: VideoReferenceInput, panels: Panel[]) {
  const lines = input.panels.map(p => {
    const title = panels.find(panel => panel.id === p.panelId)?.title || `分镜 ${p.panelId}`
    if (input.effective === 'individual') return p.frames.map(frame => `@图片${frame.imageIndex}：${title}，对应 ${(frame.offsetMs / 1000).toFixed(1)} 秒。`).join('\n')
    return `@图片${p.frames[0].imageIndex}：${title}的干净宫格，共 ${p.frames.length} 个有效画面，按从左到右、从上到下排列。${p.frames.map(frame => `第 ${frame.gridIndex} 格对应 ${frame.offsetMs / 1000} 秒`).join('，')}。空白格不属于画面序列。`
  })
  return [...lines, '按照参考画面的时间顺序生成连续的全屏视频。序号、角标、边框、分隔线和空白区域仅用于参考定位，不得出现在成片中；不得生成宫格、分屏、拼贴或带文字和序号的视频画面。'].join('\n')
}
export function videoReferenceFramesMatch(input: VideoReferenceInput, panels: Panel[]) {
  return input.panels.length === panels.length && input.panels.every((saved, i) => {
    const panel = panels[i], frames = panel && orderedFrames(panel)
    return panel?.id === saved.panelId && panel.durationMs === saved.durationMs && frames.length === saved.frames.length
      && frames.every((frame, j) => frameKey(frame) === saved.frames[j].frameId && frame.url === saved.frames[j].sourceUrl && (frame.offsetMs || 0) === saved.frames[j].offsetMs)
  })
}
