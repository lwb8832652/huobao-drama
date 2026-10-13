import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'
import { renderContactSheet } from '../src/services/previs-contact-sheet-renderer.js'
import { contactSheetDescriptor } from '../src/services/previs-contact-sheet-domain.js'
import { makeFrame, type Panel } from '../src/services/previs-domain.js'

const image = (background: string) => sharp({ create: { width: 320, height: 180, channels: 3, background } }).png().toBuffer()
test('clean sheet preserves color order and contains no badges', async () => {
  const panel = { id: 7, frames: ['red', 'blue'].map(id => ({ ...makeFrame(id), url: `/static/${id}.png` })) } as Panel
  const result = await renderContactSheet(contactSheetDescriptor(panel, '16:9'), [await image('#ff0000'), await image('#0000ff')])
  const { data, info } = await sharp(result.clean).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const pixel = (x: number, y: number) => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)]
  // 2 帧 16:9 → 1×2（1 列 2 行）：红在上、蓝在下，各自铺满整宽
  const top = pixel(1536, 432), bottom = pixel(1536, 1296)
  assert.ok(top[0] > 240 && top[2] < 15)
  assert.ok(bottom[2] > 240 && bottom[0] < 15)
  assert.deepEqual([info.width, info.height], [3072, 1728])
  assert.notDeepEqual(result.annotated, result.clean)
  assert.equal(result.sourceDigests.length, 2)
})

test('unused cells and missing frames use neutral background', async () => {
  const panel = { id: 8, frames: ['a', 'b', 'c', 'd', 'e'].map(id => makeFrame(id)) } as Panel
  // 5 帧 9:16 → 3×2（3 列 2 行），第 6 格留白；第 2 帧缺失
  const result = await renderContactSheet(contactSheetDescriptor(panel, '9:16'),
    [await image('#00ff00'), null, await image('#ff0000'), null, await image('#0000ff')])
  const { data, info } = await sharp(result.clean).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  assert.deepEqual([info.width, info.height], [1728, 3072])
  const pixel = (x: number, y: number) => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)]
  // 缺失帧（第 2 格）与留白格（第 6 格）都保持中性底
  assert.ok(pixel(864, 768).every(value => value >= 28 && value <= 36))
  assert.ok(pixel(1440, 2304).every(value => value >= 28 && value <= 36))
  assert.equal(result.sourceDigests[1], null)
  assert.equal((await sharp(result.thumbnail).metadata()).format, 'webp')
})
