import type { Panel } from './usePrevis'

export interface ReferenceAsset {
  key: string
  id: number
  kind: 'character' | 'scene' | 'prop'
  name: string
  typeLabel?: string
  meta?: string
  imageUrl: string
  ready: boolean
  bound: boolean
  sceneDescription?: string
  referenceLabel?: string
}

export function toggleReferenceSelection(keys: string[], asset: ReferenceAsset, assets: ReferenceAsset[]): string[] {
  if (keys.includes(asset.key)) return keys.filter(key => key !== asset.key)
  const others = asset.kind === 'scene' ? keys.filter(key => assets.find(item => item.key === key)?.kind !== 'scene') : keys
  return [...others, asset.key]
}

const referenceUrlKey = (url: string) => url.replace(/^static\//, '/static/')

/** Replace asset bindings while retaining uploaded common references and all frame settings. */
export function buildReferencePatch(panel: Panel, assets: ReferenceAsset[], keys: string[]) {
  const selected = [...new Set(keys)].map(key => {
    const asset = assets.find(item => item.key === key)
    if (!asset) throw new Error('可选素材已发生变化，请重新打开选择窗口')
    return asset
  })
  const scenes = selected.filter(asset => asset.kind === 'scene')
  if (scenes.length > 1) throw new Error('每个分镜只能选择一个场景')
  const oldUrls = new Set(assets.filter(asset => asset.imageUrl && (asset.kind === 'scene' ? panel.sceneId === asset.id
    : asset.kind === 'character' ? panel.characterIds.includes(asset.id) : panel.propIds.includes(asset.id)))
    .map(asset => referenceUrlKey(asset.imageUrl)))
  const custom = panel.referenceImages.map((url, index) => ({ url, label: panel.referenceLabels?.[index] || `参考图 ${index + 1}` }))
    .filter(item => !oldUrls.has(referenceUrlKey(item.url)))
  const rank = { scene: 0, character: 1, prop: 2 }
  const references = [...selected].sort((a, b) => rank[a.kind] - rank[b.kind])
    .filter(asset => asset.imageUrl).map(asset => ({ url: asset.imageUrl, label: asset.referenceLabel || asset.name }))
  // Frame overrides are independent of the shared picker. Keep their URLs in the
  // panel's allowed reference set, including those of a newly deselected asset.
  const frameReferences = panel.frames.flatMap((frame, index) => (frame.referenceImages || []).map((url, refIndex) => {
    const previousIndex = panel.referenceImages.indexOf(url)
    return { url, label: panel.referenceLabels?.[previousIndex] || `画面 ${index + 1} 参考图 ${refIndex + 1}` }
  }))
  const unique = [...references, ...custom, ...frameReferences].filter((item, index, all) => all.findIndex(other => referenceUrlKey(other.url) === referenceUrlKey(item.url)) === index)
  // Validation requires exact frame URLs, even when a frame uses a local alias.
  for (const reference of frameReferences) if (!unique.some(item => item.url === reference.url)) unique.push(reference)
  return {
    sceneId: scenes[0]?.id ?? null,
    scene: scenes[0]?.sceneDescription || scenes[0]?.name || '',
    characterIds: selected.filter(asset => asset.kind === 'character').map(asset => asset.id),
    propIds: selected.filter(asset => asset.kind === 'prop').map(asset => asset.id),
    referenceImages: unique.map(item => item.url), referenceLabels: unique.map(item => item.label),
  }
}
