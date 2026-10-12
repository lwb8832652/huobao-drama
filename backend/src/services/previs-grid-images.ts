import sharp from 'sharp'
import { gridBounds, validateGridTargets, type GenerationGrid } from './previs-grid-domain.js'
const limitInputPixels = 80_000_000
export async function splitGrid(buffer: Buffer, grid: GenerationGrid, aspectRatio: number) {
  // Apply EXIF orientation before measuring and cropping.
  const oriented = await sharp(buffer, { limitInputPixels }).rotate().png().toBuffer()
  const { width, height } = await sharp(oriented).metadata()
  if (!width || !height || width < grid.columns * 16 || height < grid.rows * 16)
    throw new Error('宫格图无法解码或尺寸过小')
  if (Math.abs(width / height / aspectRatio - 1) > 0.025)
    throw new Error('返回图片比例与冻结布局不符，请上传正确比例的宫格图或重新生成')
  const tiles = await Promise.all(
    grid.cells.map((cell) =>
      sharp(oriented)
        .extract(gridBounds(cell.index, grid, width, height))
        .png()
        .toBuffer(),
    ),
  )
  return { tiles, width, height }
}
export async function composeGrid(tiles: Buffer[], grid: GenerationGrid, width: number, height: number) {
  if (tiles.length !== grid.cells.length) throw new Error('宫格画面数量不匹配')
  const overlays = await Promise.all(
    tiles.map(async (tile, i) => {
      const bounds = gridBounds(grid.cells[i].index, grid, width, height)
      const input = await sharp(tile, { limitInputPixels })
        .rotate()
        .resize(bounds.width, bounds.height, { fit: 'contain', background: '#24272e' })
        .png()
        .toBuffer()
      return { input, left: bounds.left, top: bounds.top }
    }),
  )
  return sharp({ create: { width, height, channels: 3, background: '#24272e' } })
    .composite(overlays)
    .png()
    .toBuffer()
}
export async function mergeGridSelection(
  original: Buffer,
  model: Buffer,
  grid: GenerationGrid,
  targets: string[],
  aspectRatio: number,
) {
  validateGridTargets(grid, targets)
  const [base, proposed] = await Promise.all([
    splitGrid(original, grid, aspectRatio),
    splitGrid(model, grid, aspectRatio),
  ])
  const replacements = await Promise.all(
    grid.cells
      .filter((c) => targets.includes(c.frameId))
      .map(async (cell) => {
        const bounds = gridBounds(cell.index, grid, base.width, base.height)
        const input = await sharp(proposed.tiles[cell.index])
          .resize(bounds.width, bounds.height, { fit: 'fill' })
          .png()
          .toBuffer()
        return { input, left: bounds.left, top: bounds.top }
      }),
  )
  // Composite onto the original canvas: no re-encoding/resizing of unselected tiles.
  return sharp(original, { limitInputPixels }).rotate().composite(replacements).png().toBuffer()
}
