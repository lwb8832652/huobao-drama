import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import type { VideoReferenceInput } from '../src/services/previs-video-reference-domain.js'
const root = mkdtempSync(path.join(tmpdir(), 'sheet-media-'))
process.env.HUOBAO_DATA_DIR = root
mkdirSync(path.join(root, 'static'))
const { readReferenceMedia, freezeReferenceMedia } = await import('../src/services/previs-reference-media.js')
const { normalizeSnapshotImages } = await import('../src/services/previs-video-reference-normalizer.js')
const image = await sharp({ create: { width: 3072, height: 1728, channels: 3, background: 'red' } }).png().toBuffer()
writeFileSync(path.join(root, 'static', 'source.png'), image)
test('frozen inputs keep repeated positions, original bytes and full contact-sheet resolution', async () => {
  const frozen = await freezeReferenceMedia('/static/source.png')
  writeFileSync(path.join(root, 'static', 'source.png'), await sharp(image).negate().png().toBuffer())
  const input = { version: 1, requested: 'contact_sheet', effective: 'contact_sheet', imageUrls: [frozen.url, frozen.url], imageDigests: [frozen.digest, frozen.digest], aspectRatio: '16:9', panels: [] } as VideoReferenceInput
  const urls = await normalizeSnapshotImages(input)
  assert.equal(urls.length, 2)
  assert.equal(urls[0], urls[1])
  const metadata = await sharp(Buffer.from(urls[0].split(',')[1], 'base64')).metadata()
  assert.equal(metadata.width, 3072)
  assert.equal(metadata.height, 1728)
  assert.deepEqual(await readReferenceMedia(frozen.url), image)
  input.imageDigests[0] = 'tampered'
  await assert.rejects(normalizeSnapshotImages(input), /发生变化/)
})
test('static traversal and symlinks outside storage are rejected', async () => {
  writeFileSync(path.join(root, 'outside.png'), image)
  symlinkSync(path.join(root, 'outside.png'), path.join(root, 'static', 'escape.png'))
  await assert.rejects(readReferenceMedia('/static/../outside.png'), /路径无效/)
  await assert.rejects(readReferenceMedia('/static/escape.png'), /路径无效/)
})
