import assert from 'node:assert/strict'
import { test } from 'node:test'
import { VolcEngineImageAdapter } from '../src/services/adapters/volcengine-image.js'
import { GeminiImageAdapter } from '../src/services/adapters/gemini-image.js'
import { OpenAIImageAdapter } from '../src/services/adapters/openai-image.js'
import { NuwaxImageAdapter } from '../src/services/adapters/nuwax-image.js'

const refs = ['data:image/png;base64,YQ==', 'data:image/jpeg;base64,Yg==']
const record = { id: 1, prompt: 'Image 1 is the scene. Image 2 is the character.', referenceImages: JSON.stringify(refs), size: '2752x1536' }
const config = (provider: string, model: string, settings?: Record<string, unknown>) => ({ provider, model, settings, baseUrl: provider === 'gemini' ? 'https://generativelanguage.googleapis.com' : 'https://provider.example', apiKey: 'test-key' })

test('Seedream sends every reference in the same order and requests one canvas using size', () => {
  const request = new VolcEngineImageAdapter().buildGenerateRequest(config('volcengine', 'doubao-seedream-4-5-251128'), record)
  assert.deepEqual(request.body.image, refs)
  assert.equal(request.body.size, record.size)
  assert.equal(request.body.width, undefined)
  assert.equal(request.body.sequential_image_generation, 'disabled')
})

test('official Gemini image models use generateContent and carry ordered inline image data', () => {
  const request = new GeminiImageAdapter().buildGenerateRequest(config('gemini', 'gemini-3-pro-image'), record)
  assert.match(request.url, /models\/gemini-3-pro-image:generateContent/)
  assert.deepEqual(request.body.contents[0].parts.slice(0, 2), [
    { inline_data: { mime_type: 'image/png', data: 'YQ==' } },
    { inline_data: { mime_type: 'image/jpeg', data: 'Yg==' } },
  ])
  assert.equal(request.body.generationConfig.imageConfig.aspectRatio, '16:9')
  assert.equal(request.body.generationConfig.imageConfig.imageSize, '2K')
})

test('all image transports reject an invalid middle reference instead of renumbering later images', () => {
  const invalid = { ...record, referenceImages: JSON.stringify([refs[0], 'invalid', refs[1]]) }
  for (const [adapter, cfg] of [
    [new VolcEngineImageAdapter(), config('volcengine', 'doubao-seedream-4-5-251128')],
    [new GeminiImageAdapter(), config('gemini', 'gemini-3-pro-image')],
    [new OpenAIImageAdapter(), config('openai', 'gpt-image-2')],
    [new NuwaxImageAdapter(), config('nuwax', '20', { workflow: { referenceKey: 'images' } })],
  ] as const) assert.throws(() => adapter.buildGenerateRequest(cfg, invalid), /参考|reference/i)
})

test('references for unsupported image models fail instead of creating a text-only request', () => {
  assert.throws(() => new VolcEngineImageAdapter().buildGenerateRequest(config('volcengine', 'doubao-seedream-3-0-t2i-250415'), record), /支持|support/i)
  assert.throws(() => new GeminiImageAdapter().buildGenerateRequest(config('gemini', 'gemini-3-pro'), record), /支持|support/i)
  assert.throws(() => new OpenAIImageAdapter().buildGenerateRequest(config('openai', 'dall-e-3'), record), /支持|support/i)
  assert.throws(() => new NuwaxImageAdapter().buildGenerateRequest(config('nuwax', '20'), record), /映射|mapping|支持/i)
})

test('supported OpenAI edits upload all image bytes in prompt order', async () => {
  const request = new OpenAIImageAdapter().buildGenerateRequest(config('openai', 'gpt-image-2'), { ...record, size: '2048x1152' })
  assert.match(request.url, /\/images\/edits$/)
  assert.equal(request.headers['Content-Type'], undefined)
  const files = (request.body as FormData).getAll('image[]') as File[]
  assert.deepEqual(await Promise.all(files.map(file => file.text())), ['a', 'b'])
})

test('declared reference limits are enforced without silently truncating input', () => {
  const excessive = { ...record, referenceImages: JSON.stringify(Array.from({ length: 17 }, () => refs[0])) }
  for (const [adapter, cfg] of [
    [new VolcEngineImageAdapter(), config('volcengine', 'doubao-seedream-4-5-251128')],
    [new GeminiImageAdapter(), config('gemini', 'gemini-3-pro-image')],
    [new OpenAIImageAdapter(), config('openai', 'gpt-image-2')],
  ] as const) assert.throws(() => adapter.buildGenerateRequest(cfg, excessive), /上限|最多|limit/i)
})

test('GPT Image 2 refuses sizes outside its pixel and edge limits rather than changing requested native resolution', () => {
  for (const size of ['4096x4096', '3840x3840', '256x256', '1025x1024', '3840x1024']) {
    assert.throws(() => new OpenAIImageAdapter().buildGenerateRequest(config('openai', 'gpt-image-2'), { ...record, size, strictSize: true }), /尺寸|size|像素/i)
  }
})

test('legacy GPT Image 2 landscape and portrait sizes normalize while frozen grid sizes remain exact', () => {
  const adapter = new OpenAIImageAdapter(), cfg = config('openai', 'gpt-image-2')
  for (const [size, expected] of [['1920x1080', '1920x1088'], ['1080x1920', '1088x1920']]) {
    const request = adapter.buildGenerateRequest(cfg, { id: 1, prompt: 'legacy frame', size })
    assert.equal(request.body.size, expected)
    assert.throws(() => adapter.buildGenerateRequest(cfg, { id: 1, prompt: 'frozen grid', size, strictSize: true }), /尺寸/)
  }
})

test('Gemini persists the final image rather than an intermediate thought image', () => {
  const result = { candidates: [{ content: { parts: [
    { thought: true, inlineData: { mimeType: 'image/png', data: 'draft' } },
    { inlineData: { mimeType: 'image/png', data: 'final' } },
  ] } }] }
  assert.deepEqual(new GeminiImageAdapter().extractImageBase64(result), { mimeType: 'image/png', data: 'final' })
})
test('an existing mapped workflow keeps its legacy multi-reference image path without a grid declaration',()=>{
 const request=new NuwaxImageAdapter().buildGenerateRequest(config('nuwax','20',{workflow:{referenceKey:'images'}}),record)
 assert.deepEqual(request.body.images,refs)
})
