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
  const left = pixel(768, 864), right = pixel(2304, 864)
  assert.ok(left[0] > 240 && left[2] < 15)
  assert.ok(right[2] > 240 && right[0] < 15)
  assert.deepEqual([info.width, info.height], [3072, 1728])
  assert.notDeepEqual(result.annotated, result.clean)
  assert.equal(result.sourceDigests.length, 2)
})

test('unused cells and missing frames use neutral background', async () => {
  const panel = { id: 8, frames: [makeFrame('a'), makeFrame('b'), makeFrame('c')] } as Panel
  const result = await renderContactSheet(contactSheetDescriptor(panel, '9:16'), [await image('#00ff00'), null, await image('#ff0000')])
  const { data, info } = await sharp(result.clean).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const x = Math.floor(info.width * .75), y = Math.floor(info.height * .75), start = (y * info.width + x) * 3
  const p = [...data.subarray(start, start + 3)]
  assert.ok(p.every(value => value >= 28 && value <= 36))
  assert.equal(result.sourceDigests[1], null)
  assert.equal((await sharp(result.thumbnail).metadata()).format, 'webp')
})
