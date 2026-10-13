import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contactSheetLayout, contactSheetDescriptor } from '../src/services/previs-contact-sheet-domain.js'
import { makeFrame, type Panel } from '../src/services/previs-domain.js'

test('all supported counts use the shared landscape grid layout', () => {
  const layouts = [[1, 1], [1, 2], [1, 3], [2, 2], [2, 3], [2, 3], [3, 3], [3, 3], [3, 3]]
  layouts.forEach(([columns, rows], i) => assert.deepEqual(contactSheetLayout(i + 1, '16:9'), { columns, rows }))
  for (const count of [0, 10, -1, 1.5]) assert.throws(() => contactSheetLayout(count), RangeError)
})

test('portrait canvases transpose the grid so every cell matches the frame', () => {
  assert.deepEqual(contactSheetLayout(3, '16:9'), { columns: 1, rows: 3 })
  assert.deepEqual(contactSheetLayout(3, '9:16'), { columns: 3, rows: 1 })
  assert.deepEqual(contactSheetLayout(6, '9:16'), { columns: 3, rows: 2 })
  assert.deepEqual(contactSheetLayout(4, '9:16'), { columns: 2, rows: 2 })
})

test('cells retain equal-time order and repeated images as separate moments', () => {
  const panel = { id: 7, frames: [
    { ...makeFrame('b', 2000), url: '/static/same.jpg' },
    { ...makeFrame('a', 0), url: '/static/same.jpg' },
    makeFrame('c', 2000),
  ] } as Panel
  const sheet = contactSheetDescriptor(panel, '16:9')
  assert.deepEqual(sheet.cells.map(c => [c.frameId, c.index]), [['a', 1], ['b', 2], ['c', 3]])
  assert.equal(sheet.width, 3072)
  assert.equal(sheet.height, 1728)
  assert.equal(sheet.cells.length, 3)
  // 3 帧 16:9 → 1×3 宫格（1 列 3 行），第 3 格落在第 3 行
  assert.equal(sheet.cells[2].left, 0)
  assert.equal(sheet.cells[2].top, 1152)
  assert.equal(contactSheetDescriptor(panel, '9:16').height, 3072)
  assert.throws(() => contactSheetDescriptor(panel, 'bad'), /比例/)
})
