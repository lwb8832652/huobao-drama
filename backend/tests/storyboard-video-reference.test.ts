import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selectVideoReferenceStrategy, videoReferenceLegend } from '../src/services/previs-video-reference-domain.js'
import { makeFrame, type Panel } from '../src/services/previs-domain.js'
const panel = (id: number, count: number) => ({ id, title: `分镜${id}`, durationMs: 4000, frames: Array.from({ length: count }, (_, i) => ({ ...makeFrame(`${id}-${i}`, i * 100), url: '/static/same.png' })) }) as Panel
test('auto counts time moments, uses one sheet per grouped panel, and never truncates', () => {
  assert.equal(selectVideoReferenceStrategy([panel(1, 5)], 'auto', 4), 'contact_sheet')
  assert.equal(selectVideoReferenceStrategy([panel(1, 5)], 'auto', 9), 'individual')
  assert.equal(selectVideoReferenceStrategy([panel(1, 3), panel(2, 3)], 'auto', 9), 'contact_sheet')
  assert.throws(() => selectVideoReferenceStrategy([panel(1, 5)], 'individual', 4), /最多/)
  assert.throws(() => selectVideoReferenceStrategy([panel(1, 2), panel(2, 2)], 'auto', 1), /按分镜/)
  const missing = panel(1, 2); missing.frames[1].url = ''
  assert.throws(() => selectVideoReferenceStrategy([missing], 'contact_sheet', 9), /未完成/)
})
test('contact-sheet prompt binds cells to relative time without relying on visible badges', () => {
  const prompt = videoReferenceLegend({ version: 1, requested: 'contact_sheet', effective: 'contact_sheet', aspectRatio: '16:9', imageUrls: ['a'], imageDigests: ['b'], panels: [{ panelId: 1, durationMs: 4000, sheetId: 1, sheetHash: 'h', frames: [{ frameId: 'f', imageIndex: 1, gridIndex: 1, offsetMs: 1500, sourceUrl: 's' }] }] }, [panel(1, 1)])
  assert.match(prompt, /第 1 格对应 1.5 秒/)
  assert.match(prompt, /不得.*宫格/)
  assert.match(prompt, /不得.*序号/)
})
