import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { MiddlewareHandler } from 'hono'
import { getMimeType } from 'hono/utils/mime'

export interface ByteRange {
  start: number
  end: number
}

export function parseByteRange(value: string, size: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!match || size <= 0 || (!match[1] && !match[2])) return null

  if (!match[1]) {
    const suffixLength = Number(match[2])
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null
    return { start: Math.max(0, size - suffixLength), end: size - 1 }
  }

  const start = Number(match[1])
  const requestedEnd = match[2] ? Number(match[2]) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)
    || start < 0 || start >= size || requestedEnd < start) return null
  return { start, end: Math.min(requestedEnd, size - 1) }
}

export function serveStaticRanges(root: string): MiddlewareHandler {
  const resolvedRoot = path.resolve(root)
  return async (c, next) => {
    const rangeHeader = c.req.header('range')
    if (c.req.method !== 'GET' || !rangeHeader?.startsWith('bytes=')) return next()

    let relativePath: string
    try {
      relativePath = decodeURIComponent(c.req.path).replace(/^\/+/, '')
    } catch {
      return next()
    }
    const filePath = path.resolve(resolvedRoot, relativePath)
    if (filePath !== resolvedRoot && !filePath.startsWith(`${resolvedRoot}${path.sep}`)) return next()

    let size: number
    let modifiedAt: Date
    try {
      const file = await stat(filePath)
      if (!file.isFile()) return next()
      size = file.size
      modifiedAt = file.mtime
    } catch {
      return next()
    }

    const range = parseByteRange(rangeHeader, size)
    if (!range) {
      return new Response(null, {
        status: 416,
        headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${size}` },
      })
    }

    const stream = Readable.toWeb(createReadStream(filePath, range)) as unknown as BodyInit
    const headers = new Headers({
      'Accept-Ranges': 'bytes',
      'Content-Length': String(range.end - range.start + 1),
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      'Last-Modified': modifiedAt.toUTCString(),
    })
    const mimeType = getMimeType(filePath)
    if (mimeType) headers.set('Content-Type', mimeType)
    return new Response(stream, { status: 206, headers })
  }
}
