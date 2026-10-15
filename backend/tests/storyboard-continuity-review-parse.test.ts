import assert from 'node:assert/strict'
import { test } from 'node:test'

const review = await import('../src/services/continuity-review.js').catch(() => null)
const schema = review?.continuityReviewResultSchema
assert.ok(schema, 'continuityReviewResultSchema must be exported for review parsing')

/** 嵌套结构：模型按 instructions 的 JSON 模板输出（2026-10-15 修复后的主路径） */
function nested(over: Record<string, unknown> = {}) {
  return {
    dimensions: {
      subject: { score: 22, comment: '人物服装一致' },
      scene: { score: 23, comment: '同一场景同时段' },
      action: { score: 24, comment: '动作衔接自然' },
      camera: { score: 21, comment: '景别过渡合理' },
    },
    overallScore: 90,
    confidence: 'high',
    summary: '整体连贯',
    issues: [],
    suggestions: [],
    ...over,
  }
}

test('nested dimensions pass schema as-is', () => {
  const parsed = schema!.safeParse(nested())
  assert.equal(parsed.success, true)
  if (!parsed.success) return
  assert.equal(parsed.data.dimensions.subject.score, 22)
  assert.equal(parsed.data.overallScore, 90)
  assert.equal(parsed.data.confidence, 'high')
})

test('flattened four dimensions are folded back into dimensions', () => {
  // 回归 2026-10-15「发起评测失败」：instructions 早先只说四项含义、未给 dimensions
  // 包裹层，qwen3.8-flash 把 subject/scene/action/camera 平铺在顶层。分数已算对，
  // 不能因为包装失败——对象级预处理把四个键收进 dimensions。
  const parsed = schema!.safeParse({
    subject: { score: 25, comment: '帆布鞋锚点一致' },
    scene: { score: 25, comment: '夜晚梧桐道路灯' },
    action: { score: 24, comment: '撞后站稳对峙' },
    camera: { score: 23, comment: '俯拍切中景' },
    overallScore: 97,
    confidence: 'high',
    summary: '连续性极佳',
    issues: [],
    suggestions: ['保持袖口细节'],
  })
  assert.equal(parsed.success, true)
  if (!parsed.success) return
  assert.equal(parsed.data.dimensions.camera.score, 23)
  assert.equal(parsed.data.overallScore, 97)
})

test('loose coercions keep minor model omissions from failing the review', () => {
  // score 数字字符串、缺 comment、缺 summary、非法 confidence 都不应让整条评测失败
  const parsed = schema!.safeParse({
    dimensions: {
      subject: { score: '20' },
      scene: { score: 21, comment: '' },
      action: { score: 22, comment: 'ok' },
      camera: { score: 23, comment: 'ok' },
    },
    overallScore: 86,
    confidence: 'very-high',
    issues: 'not-an-array',
    suggestions: [null, '  ', '有效建议'],
  })
  assert.equal(parsed.success, true)
  if (!parsed.success) return
  assert.equal(parsed.data.dimensions.subject.score, 20)
  assert.equal(parsed.data.dimensions.subject.comment, '未说明')
  assert.equal(parsed.data.summary, '未提供摘要')
  assert.equal(parsed.data.confidence, 'low')
  assert.deepEqual(parsed.data.issues, [])
  assert.deepEqual(parsed.data.suggestions, ['有效建议'])
})

test('a payload with neither dimensions nor flat keys is a format error', () => {
  const parsed = schema!.safeParse({ overallScore: 50, confidence: 'low', summary: 'x', issues: [], suggestions: [] })
  assert.equal(parsed.success, false)
})

test('out-of-range scores are rejected', () => {
  const over = nested()
  over.dimensions.subject.score = 26
  assert.equal(schema!.safeParse(over).success, false)
  over.dimensions.subject.score = 22
  over.overallScore = 101
  assert.equal(schema!.safeParse(over).success, false)
})
