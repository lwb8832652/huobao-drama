import assert from 'node:assert/strict'
import { test } from 'node:test'

const api = await import('../src/services/previs-grid-capabilities.js').catch(() => null)
const config = (provider: string, model: string, settings?: Record<string, unknown>) => ({ provider, model, settings, baseUrl: 'https://provider.example', apiKey: 'test-key' })

test('grid capabilities only enable identified reference and editing models', () => {
  assert.ok(api, 'grid capability API must exist')
  for (const [provider, model, limit] of [
    ['openai', 'gpt-image-2', 16], ['gemini', 'gemini-3-pro-image', 14],
    ['volcengine', 'doubao-seedream-4-5-251128', 14], ['volcengine', 'doubao-seedream-5-0-pro-260628', 10],
  ] as const) {
    const caps = api.gridImageCapabilities(config(provider, model), model)
    assert.equal(caps.enabled, true)
    assert.equal(caps.supportsReferences, true)
    assert.equal(caps.supportsEdit, true)
    assert.equal(caps.maxReferences, limit)
  }
  for (const [provider, model] of [['openai', 'dall-e-3'], ['gemini', 'gemini-3-pro'], ['volcengine', 'ep-unknown'], ['nuwax', '20']]) {
    assert.equal(api.gridImageCapabilities(config(provider, model), model).enabled, false)
  }
})

test('size selection preserves native dimensions and rejects unsupported ratio or tier', () => {
  assert.ok(api)
  const gemini = api.gridImageCapabilities(config('gemini', 'gemini-3-pro-image'), 'gemini-3-pro-image')
  assert.deepEqual(api.chooseGridSize(gemini, '16:9', '2K'), { size: '2752x1536', width: 2752, height: 1536, aspectRatio: '16:9', resolution: '2K' })
  assert.equal(api.chooseGridSize(gemini, '9:16', '4K').size, '3072x5504')
  const openai = api.gridImageCapabilities(config('openai', 'gpt-image-2'), 'gpt-image-2')
  assert.equal(api.chooseGridSize(openai, '16:9', '4K').size, '3840x2160')
  assert.throws(() => api.chooseGridSize(openai, '1:1', '4K'), /支持|support/)
  const legacy = api.gridImageCapabilities(config('openai', 'gpt-image-1'), 'gpt-image-1')
  assert.throws(() => api.chooseGridSize(legacy, '16:9', '1K'), /支持|support/)
  const seedream = api.gridImageCapabilities(config('volcengine', 'doubao-seedream-4-5-251128'), 'doubao-seedream-4-5-251128')
  assert.throws(() => api.chooseGridSize(seedream, '16:9', '1K'), /支持|support/)
  assert.ok(api.chooseGridSize(seedream, '16:9', '2K').width * api.chooseGridSize(seedream, '16:9', '2K').height >= 3686400)
})

test('custom workflows require actual reference and size mappings plus declared limits', () => {
  assert.ok(api)
  const declaration = { maxReferences: 3, supportsEdit: true, sizes: [{ aspectRatio: '16:9', resolution: '2K', width: 2048, height: 1152 }] }
  const settings = { workflow: { referenceKey: 'images', extraParams: { output_size: '{{size}}' }, gridImage: declaration } }
  const caps = api.gridImageCapabilities(config('nuwax', '20', settings), '20')
  assert.equal(caps.enabled, true)
  assert.equal(caps.maxReferences, 3)
  assert.equal(api.chooseGridSize(caps, '16:9', '2K').size, '2048x1152')
  const withoutSize = { workflow: { referenceKey: 'images', gridImage: declaration } }
  assert.equal(api.gridImageCapabilities(config('nuwax', '20', withoutSize), '20').enabled, false)
  const shadowedInput = { workflow: { promptKey: 'images', referenceKey: 'images', extraParams: { output_size: '{{size}}' }, gridImage: declaration } }
  assert.equal(api.gridImageCapabilities(config('nuwax', '20', shadowedInput), '20').enabled, false)
})
test('an alternate mapping cannot enable a workflow whose reference key overwrites the edit prompt',()=>{
 assert.ok(api)
 const settings={workflow:{promptKey:'images',referenceKey:'images',extraParams:{ref_images:'{{referenceImages}}',output_size:'{{size}}'},gridImage:{maxReferences:3,supportsEdit:true,sizes:[{aspectRatio:'16:9',resolution:'2K',width:2048,height:1152}]}}}
 assert.equal(api.gridImageCapabilities(config('nuwax','20',settings),'20').enabled,false)
})
