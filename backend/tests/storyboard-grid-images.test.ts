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
test('one through nine map to square grids and exact non-divisible bounds cover the complete image', () => {
  for (let n = 1; n <= 9; n++) {
    const grid = generationGrid(Array.from({ length: n }, (_, i) => `f${i}`))
    assert.equal(grid.columns, n === 1 ? 1 : n <= 4 ? 2 : 3)
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
test('split keeps full cells, does not include placeholders, supports portrait, rejects wrong geometry', async () => {
  for (const [w, h] of [
    [320, 180],
    [180, 320],
  ]) {
    const grid = generationGrid(['a', 'b', 'c'])
    const images = await Promise.all(['red', 'green', 'blue'].map((c) => tile(c, w / 2, h / 2)))
    const composed = await composeGrid(images, grid, w, h)
    const split = await splitGrid(composed, grid, w / h)
    assert.equal(split.tiles.length, 3)
    assert.deepEqual(await pixel(split.tiles[0]), [255, 0, 0])
    assert.deepEqual(await pixel(split.tiles[2]), [0, 0, 255])
    assert.equal((await sharp(split.tiles[0]).metadata()).width, w / 2)
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
