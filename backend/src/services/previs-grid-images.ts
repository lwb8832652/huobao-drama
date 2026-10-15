import sharp from 'sharp'
import { gridBounds, validateGridTargets, type GenerationGrid } from './previs-grid-domain.js'
const limitInputPixels = 80_000_000
/** 允许的尺寸比例容差：超过即认为上游没有按冻结布局出图 */
const RATIO_TOLERANCE = 0.025
/**
 * 上游（尤其经中转的 OpenAI 兼容端点）偶发忽略请求的 size，回落到自己的原生比例：
 * 实测 gpt-image-2 中转把 1536×864(16:9) 返成 1536×1024(3:2)，偏差 15.6%。
 * 这种「画布比例错、格数布局对」的输出，每格构图仍是对的，只是整幅被改成了别的画布比例；
 * 直接拒绝会让用户反复重试烧钱，因此偏差在 AUTO_CROP_LIMIT 以内时先中心裁切到冻结比例再切格
 * （只裁不缩放，避免拉伸变形），并把上游原始尺寸记下来供界面标注「已裁切适配」。
 * 超出该上限（如 4:3 对 16:9 的 25%）仍按原样报错，避免裁掉过多内容。
 */
const AUTO_CROP_LIMIT = 0.2
export interface GridSplit {
  tiles: Buffer[]
  width: number
  height: number
  /** 仅在实际发生裁切时给出：上游原图尺寸（裁切后尺寸见 width/height） */
  sourceWidth?: number
  sourceHeight?: number
}
/** 中心裁切到目标比例；只裁不缩放，避免拉伸。 */
async function centerCrop(buffer: Buffer, width: number, height: number, aspectRatio: number) {
  const tooWide = width / height > aspectRatio
  const targetWidth = Math.round(tooWide ? height * aspectRatio : width)
  const targetHeight = Math.round(tooWide ? height : width / aspectRatio)
  const cropped = await sharp(buffer, { limitInputPixels })
    .extract({
      left: Math.floor((width - targetWidth) / 2),
      top: Math.floor((height - targetHeight) / 2),
      width: targetWidth,
      height: targetHeight,
    })
    .png()
    .toBuffer()
  return { buffer: cropped, width: targetWidth, height: targetHeight }
}
export async function splitGrid(buffer: Buffer, grid: GenerationGrid, aspectRatio: number): Promise<GridSplit> {
  // Apply EXIF orientation before measuring and cropping.
  const oriented = await sharp(buffer, { limitInputPixels }).rotate().png().toBuffer()
  const metadata = await sharp(oriented).metadata()
  const sourceWidth = metadata.width || 0,
    sourceHeight = metadata.height || 0
  if (!sourceWidth || !sourceHeight || sourceWidth < grid.columns * 16 || sourceHeight < grid.rows * 16)
    throw new Error('宫格图无法解码或尺寸过小')
  const deviation = Math.abs(sourceWidth / sourceHeight / aspectRatio - 1)
  if (deviation > AUTO_CROP_LIMIT)
    throw new Error('返回图片比例与冻结布局不符，请上传正确比例的宫格图或重新生成')
  const canvas =
    deviation > RATIO_TOLERANCE
      ? await centerCrop(oriented, sourceWidth, sourceHeight, aspectRatio)
      : { buffer: oriented, width: sourceWidth, height: sourceHeight }
  const tiles = await Promise.all(
    grid.cells.map((cell) =>
      sharp(canvas.buffer)
        .extract(gridBounds(cell.index, grid, canvas.width, canvas.height))
        .png()
        .toBuffer(),
    ),
  )
  return canvas.width === sourceWidth && canvas.height === sourceHeight
    ? { tiles, width: canvas.width, height: canvas.height }
    : { tiles, width: canvas.width, height: canvas.height, sourceWidth, sourceHeight }
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
