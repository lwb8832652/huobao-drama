import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'
import { generationGrid, gridBounds } from '../src/services/previs-grid-domain.js'
import { splitGrid, composeGrid, mergeGridSelection } from '../src/services/previs-grid-images.js'
const tile = (color: string, width = 160, height = 90) =>
  sharp({ create: { width, height, channels: 3, background: color } })
    .png()
    .toBuffer()
const pixel = async (buffer: Buffer) => [
  ...(await sharp(buffer).removeAlpha().raw().toBuffer()).subarray(0, 3),
]
test('one through nine map to grid layouts and exact non-divisible bounds cover the complete image', () => {
  // 横屏基准：1×2 / 2×2 / 1×3 / 2×3 / 3×3；非标准数量向上取最近宫格，超出格数留白。
  const expected: Record<number, [number, number]> = {
    1: [1, 1],
    2: [1, 2],
    3: [1, 3],
    4: [2, 2],
    5: [2, 3], // 向上取 2×3，留白 1 格
    6: [2, 3],
    7: [3, 3], // 向上取 3×3，留白 2 格
    8: [3, 3], // 向上取 3×3，留白 1 格
    9: [3, 3],
  }
  for (let n = 1; n <= 9; n++) {
    const grid = generationGrid(Array.from({ length: n }, (_, i) => `f${i}`))
    assert.equal(grid.columns, expected[n][0])
    assert.equal(grid.rows, expected[n][1])
    assert.equal(grid.cells.length, n)
    assert.deepEqual(
      grid.cells.map((c) => c.frameId),
      Array.from({ length: n }, (_, i) => `f${i}`),
    )
    const last = gridBounds(grid.columns * grid.rows - 1, grid, 1001, 563)
    assert.equal(last.left + last.width, 1001)
    assert.equal(last.top + last.height, 563)
  }
  assert.throws(() => generationGrid([]), /1.*9/)
  assert.throws(() => generationGrid(Array(10).fill('a')), /1.*9/)
  assert.throws(() => generationGrid(['a', 'a']), /ID/)
})

test('portrait aspect ratios flip columns and rows so each cell stays upright', () => {
  // 竖屏 9:16 翻转列行：1×2→2×1、1×3→3×1、2×3→3×2，方形不变。
  const portrait: Record<number, [number, number]> = {
    2: [2, 1], 3: [3, 1], 4: [2, 2], 6: [3, 2], 9: [3, 3],
  }
  for (const [count, [columns, rows]] of Object.entries(portrait)) {
    const grid = generationGrid(Array.from({ length: Number(count) }, (_, i) => `f${i}`), '9:16')
    assert.equal(grid.columns, columns)
    assert.equal(grid.rows, rows)
  }
  // 横屏 16:9 保持基准（列 ≤ 行）
  assert.deepEqual(generationGrid(['a', 'b'], '16:9'), {
    columns: 1, rows: 2,
    cells: [{ frameId: 'a', index: 0 }, { frameId: 'b', index: 1 }],
  })
})
test('split keeps full cells, does not include placeholders, supports portrait, rejects wrong geometry', async () => {
  for (const [w, h] of [
    [360, 180],
    [180, 360],
  ]) {
    const grid = generationGrid(['a', 'b', 'c']) // 3 帧 → 1×3（1 列 3 行）
    const images = await Promise.all(['red', 'green', 'blue'].map((c) => tile(c, w, h / 3)))
    const composed = await composeGrid(images, grid, w, h)
    const split = await splitGrid(composed, grid, w / h)
    assert.equal(split.tiles.length, 3)
    assert.deepEqual(await pixel(split.tiles[0]), [255, 0, 0])
    assert.deepEqual(await pixel(split.tiles[2]), [0, 0, 255])
    assert.equal((await sharp(split.tiles[0]).metadata()).height, h / 3)
    await assert.rejects(splitGrid(composed, grid, h / w), /比例/)
  }
})
test('even if model redraws every tile, only selected second and fourth cells change', async () => {
  const grid = generationGrid(['a', 'b', 'c', 'd'])
  const original = await composeGrid(
    await Promise.all(['red', 'green', 'blue', 'white'].map((c) => tile(c))),
    grid,
    320,
    180,
  )
  const model = await composeGrid(
    await Promise.all(
      Array(4)
        .fill('black')
        .map((c) => tile(c)),
    ),
    grid,
    320,
    180,
  )
  const merged = await mergeGridSelection(original, model, grid, ['b', 'd'], 320 / 180)
  const split = await splitGrid(merged, grid, 320 / 180)
  assert.deepEqual(await pixel(split.tiles[0]), [255, 0, 0])
  assert.deepEqual(await pixel(split.tiles[1]), [0, 0, 0])
  assert.deepEqual(await pixel(split.tiles[2]), [0, 0, 255])
  assert.deepEqual(await pixel(split.tiles[3]), [0, 0, 0])
  await assert.rejects(mergeGridSelection(original, model, grid, ['placeholder'], 320 / 180), /目标/)
})
test('画布比例与冻结布局不符时中心裁切适配，偏差过大仍拒绝', async () => {
  const grid = generationGrid(['a', 'b', 'c', 'd']) // 4 帧 → 2×2
  // 上游把 16:9 的请求返成 3:2（1536×1024，偏差 15.6%）：格数与布局都对，只是画布比例错，
  // 裁切后每格应恢复成 16:9，且记录上游原尺寸供界面标注。
  const offRatio = await composeGrid(
    await Promise.all(['red', 'green', 'blue', 'white'].map((c) => tile(c, 768, 512))),
    grid,
    1536,
    1024,
  )
  const split = await splitGrid(offRatio, grid, 16 / 9)
  assert.equal(split.sourceWidth, 1536)
  assert.equal(split.sourceHeight, 1024)
  assert.equal(split.width, 1536)
  assert.equal(split.height, 864)
  assert.equal((await sharp(split.tiles[0]).metadata()).height, 432)
  assert.deepEqual(await pixel(split.tiles[0]), [255, 0, 0])
  assert.deepEqual(await pixel(split.tiles[3]), [255, 255, 255])
  // 4:3 对 16:9 偏 25%，超出裁切上限：仍按原样拒绝，避免裁掉过多内容
  const fourThree = await sharp({ create: { width: 800, height: 600, channels: 3, background: 'gray' } })
    .png()
    .toBuffer()
  await assert.rejects(splitGrid(fourThree, grid, 16 / 9), /比例/)
  // 完全合规时不裁切、也不上报原尺寸
  const exact = await sharp({ create: { width: 1280, height: 720, channels: 3, background: 'gray' } })
    .png()
    .toBuffer()
  const clean = await splitGrid(exact, grid, 16 / 9)
  assert.equal(clean.width, 1280)
  assert.equal(clean.height, 720)
  assert.equal(clean.sourceWidth, undefined)
  assert.equal(clean.sourceHeight, undefined)
})
