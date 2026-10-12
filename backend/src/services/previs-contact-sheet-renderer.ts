import { createHash } from 'node:crypto'
import sharp from 'sharp'
import type { ContactSheetDescriptor } from './previs-contact-sheet-domain.js'

// Vector digits avoid depending on fonts installed on the application host.
const digits = [ '', 'M7 2L11 0V20', 'M2 4Q2 -1 9 0Q17 1 13 8L2 20H16',
  'M2 2Q16 -3 16 5Q16 10 8 10Q18 10 16 17Q13 23 2 18',
  'M12 20V0L1 14H17', 'M16 0H3V9Q18 5 16 16Q14 23 2 19',
  'M15 1Q1 -3 2 14Q3 23 12 20Q20 14 13 9Q7 5 2 13',
  'M1 0H17L6 20', 'M9 10Q-2 7 3 1Q10 -3 16 2Q21 8 9 10Q-4 15 3 20Q11 24 17 18Q22 13 9 10',
  'M16 9Q10 16 4 10Q-2 3 6 0Q17 -3 16 11Q16 24 3 20' ]
export async function renderContactSheet(descriptor: ContactSheetDescriptor, images: (Buffer | null)[]) {
  if (images.length !== descriptor.cells.length) throw new Error('宫格来源数量不一致')
  const tiles = await Promise.all(descriptor.cells.map(async (cell, i) => images[i] ? {
    input: await sharp(images[i]!, { limitInputPixels: 80_000_000 }).rotate()
      .resize(cell.width, cell.height, { fit: 'contain', background: '#202020' })
      .flatten({ background: '#202020' }).png().toBuffer().catch((error: Error) => { throw new Error(`画面 ${cell.index}（${cell.frameId}）解码失败：${error.message}`) }), left: cell.left, top: cell.top,
  } : null))
  const base = await sharp({ create: { width: descriptor.width, height: descriptor.height,
    channels: 3, background: '#202020' } }).composite(tiles.filter(t => t !== null)).png().toBuffer()
  const clean = await sharp(base).jpeg({ quality: 94, chromaSubsampling: '4:4:4' }).toBuffer()
  const badges = descriptor.cells.map(cell => {
    const size = Math.max(40, Math.round(Math.min(cell.width, cell.height) * .085))
    const svg = `<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${size / 5}" fill="#101010" fill-opacity=".8"/><path d="${digits[cell.index]}" transform="translate(${size * .28} ${size * .2}) scale(${size * .028})" fill="none" stroke="white" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    return { input: Buffer.from(svg), left: cell.left + 12, top: cell.top + 12 }
  })
  const annotated = await sharp(base).composite(badges).jpeg({ quality: 92 }).toBuffer()
  const thumbnail = await sharp(annotated).resize({ width: 640, height: 640, fit: 'inside' }).webp({ quality: 85 }).toBuffer()
  return { clean, annotated, thumbnail, sourceDigests: images.map(image => image ? createHash('sha256').update(image).digest('hex') : null) }
}
