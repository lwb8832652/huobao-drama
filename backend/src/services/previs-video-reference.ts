import { orderedFrames, frameKey, type Panel } from './previs-domain.js'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { readContactSheets, contactSheetSource, scheduleContactSheets } from './previs-contact-sheets.js'
import { freezeReferenceMedia, readReferenceMedia, mediaDigest } from './previs-reference-media.js'
import { selectVideoReferenceStrategy, videoReferenceFramesMatch, type VideoReferenceInputStrategy, type VideoReferenceInput } from './previs-video-reference-domain.js'

export async function buildVideoReferenceInput(versionId: number, panels: Panel[], requested: VideoReferenceInputStrategy, maxImages: number, generationScope: 'storyboard' | 'group' = 'storyboard'): Promise<VideoReferenceInput> {
  const effective = selectVideoReferenceStrategy(panels, requested, maxImages, generationScope)
  const aspectRatio = (await contactSheetSource(versionId)).aspectRatio
  const sheets = (await readContactSheets(versionId))
  if (effective === 'contact_sheet') {
    for (const panel of panels) {
      const sheet = sheets.find(sheet => sheet.panelId === panel.id)
      if (!sheet || sheet.status !== 'ready' || !sheet.artifactId) continue
      const artifact = (await db.select().from(schema.frameContactSheets).where(eq(schema.frameContactSheets.id, sheet.artifactId)).get())!
      const digests = JSON.parse(artifact.sourceDigestsJson || '[]') as (string | null)[]
      for (const [i, frame] of orderedFrames(panel).entries()) {
        let digest: string
        try { digest = mediaDigest(await readReferenceMedia(frame.url)) }
        catch (error) { throw new Error(`「${panel.title}」画面 ${i + 1}（${frameKey(frame)}）读取失败：${(error as Error).message}`) }
        if (digest !== digests[i]) {
          ;await scheduleContactSheets(versionId, [panel.id], true)
          throw new Error(`「${panel.title}」画面 ${i + 1}（${frameKey(frame)}）已替换，宫格已过期，正在重新合成，请稍后重试`)
        }
      }
    }
  }
  const urls = effective === 'individual' ? panels.flatMap(panel => orderedFrames(panel).map(frame => frame.url))
    : panels.map(panel => {
      const sheet = sheets.find(sheet => sheet.panelId === panel.id)
      if (!sheet || sheet.status !== 'ready' || !sheet.cleanUrl || sheet.readyFrames !== sheet.totalFrames) {
        throw new Error(`「${panel.title}」宫格${sheet?.status === 'failed' ? `合成失败：${sheet.error}` : '尚未完成或已过期'}，请完成合成后重试`)
      }
      return sheet.cleanUrl
    })
  const frozen = await Promise.all(urls.map(async (url, i) => {
    try { return await freezeReferenceMedia(url) }
    catch (error) {
      const frame = effective === 'individual' ? panels.flatMap(p => orderedFrames(p))[i] : null
      throw new Error(`视频参考图 ${i + 1}${frame ? `（${frameKey(frame)}）` : ''}读取失败：${(error as Error).message}`)
    }
  }))
  let index = 0
  return { version: 1, generationScope, requested, effective, aspectRatio,
    imageUrls: frozen.map(f => f.url), imageDigests: frozen.map(f => f.digest),
    panels: panels.map(panel => {
      const sheet = effective === 'contact_sheet' ? sheets.find(s => s.panelId === panel.id)! : null
      const frames = orderedFrames(panel).map((frame, i) => ({ frameId: frameKey(frame), sourceUrl: frame.url,
        imageIndex: effective === 'individual' ? ++index : index + 1, gridIndex: sheet ? i + 1 : null, offsetMs: frame.offsetMs || 0 }))
      if (sheet) index++
      return { panelId: panel.id, durationMs: panel.durationMs, sheetId: sheet?.artifactId || null, sheetHash: sheet?.artifactHash || null, frames }
    }) }
}

export async function videoReferenceMatchesSource(versionId: number, input: VideoReferenceInput, panels: Panel[]) {
  const source = (await contactSheetSource(versionId))
  if (!videoReferenceFramesMatch(input, panels) || source.aspectRatio !== input.aspectRatio) return false
  if (input.generationScope === 'group') {
    const order = source.timeline.groups.flatMap(group => group.panelIds).filter(id => input.panels.some(panel => panel.panelId === id))
    if (order.some((id, i) => id !== input.panels[i]?.panelId)) return false
  }
  if (input.effective !== 'contact_sheet') return true
  const sheets = (await readContactSheets(versionId))
  return input.panels.every(panel => {
    const current = sheets.find(sheet => sheet.panelId === panel.panelId)
    // Copied versions may not have composed their cache yet; the frame snapshot still defines the source.
    return current?.status === 'none' || (current?.status === 'ready' && current.artifactHash === panel.sheetHash)
  })
}
