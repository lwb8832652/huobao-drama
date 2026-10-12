import sharp from 'sharp'
import { mediaDigest, readReferenceMedia } from './previs-reference-media.js'
import type { VideoReferenceInput } from './previs-video-reference-domain.js'

export async function normalizeSnapshotImages(input: VideoReferenceInput) {
  if (input.imageUrls.length !== input.imageDigests.length) throw new Error('视频参考输入快照不完整')
  const urls = await Promise.all(input.imageUrls.map(async (url, i) => {
    try {
    const buffer = await readReferenceMedia(url)
    if (mediaDigest(buffer) !== input.imageDigests[i]) throw new Error('视频参考输入文件发生变化，请重新提交')
    for (const quality of input.effective === 'contact_sheet' ? [88, 80, 72] : [85, 75, 68]) {
      const encoded = await sharp(buffer).rotate().resize({ width: input.effective === 'contact_sheet' ? 3072 : 1536,
        height: input.effective === 'contact_sheet' ? 3072 : 1536, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#202020' }).jpeg({ quality }).toBuffer()
      if (encoded.length <= 3 * 1024 * 1024) return `data:image/jpeg;base64,${encoded.toString('base64')}`
    }
    throw new Error('参考图压缩后仍超过 3MB，请降低图片复杂度后重试')
    } catch (error) {
      const frames = input.panels.flatMap(p => p.frames).filter(frame => frame.imageIndex === i + 1)
      throw new Error(`参考图 ${i + 1}（${frames.map(frame => frame.frameId).join('、')}）处理失败：${(error as Error).message}`)
    }
  }))
  if (urls.reduce((sum, url) => sum + url.length, 0) > 48 * 1024 * 1024) throw new Error('视频参考请求超过传输上限')
  return urls
}
