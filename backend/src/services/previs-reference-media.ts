import { readFile, mkdir, writeFile, stat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { STORAGE_ROOT } from '../utils/paths.js'

const maxBytes = 20 * 1024 * 1024
export const mediaDigest = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex')
export async function readReferenceMedia(url: string): Promise<Buffer> {
  if (/^https?:\/\//i.test(url)) {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok || !response.body) throw new Error(`读取画面失败：HTTP ${response.status}`)
    if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('画面文件超过 20MB')
    const chunks: Uint8Array[] = [], reader = response.body.getReader()
    let length = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.length
        if (length > maxBytes) throw new Error('画面文件超过 20MB')
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => {}) }
    return Buffer.concat(chunks)
  }
  if (url.startsWith('data:')) {
    const match = /^data:image\/[-\w+.]+;base64,([A-Za-z0-9+/=\s]+)$/.exec(url)
    if (!match || match[1].length > maxBytes * 4 / 3 + 4) throw new Error('画面数据无效或超过 20MB')
    return Buffer.from(match[1], 'base64')
  }
  const relative = url.replace(/^\/?static\//, '')
  const file = path.resolve(STORAGE_ROOT, relative)
  if (!file.startsWith(path.resolve(STORAGE_ROOT) + path.sep)) throw new Error('画面文件路径无效')
  const [realRoot, realFile] = await Promise.all([realpath(STORAGE_ROOT), realpath(file)])
  if (!realFile.startsWith(realRoot + path.sep)) throw new Error('画面文件路径无效')
  if ((await stat(file)).size > maxBytes) throw new Error('画面文件超过 20MB')
  return readFile(file)
}
/** Content-addressed files keep queued tasks independent of later source replacements. */
export async function freezeReferenceMedia(url: string) {
  const buffer = await readReferenceMedia(url)
  const digest = mediaDigest(buffer)
  await sharp(buffer, { limitInputPixels: 80_000_000 }).metadata()
  const dir = path.join(STORAGE_ROOT, 'previs-inputs')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, `${digest}.img`), buffer, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
  return { url: `/static/previs-inputs/${digest}.img`, digest }
}
