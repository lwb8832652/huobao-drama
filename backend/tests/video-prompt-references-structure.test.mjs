import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('prompt_generator video prompt format uses @name references instead of XML tags', () => {
  const agents = read('src/agents/index.ts')
  const skill = read('workspace/skills/prompt-generator/video-prompt/SKILL.md')
  const prompt = read('workspace/prompts/prompt_generator.md')
  const settings = read('../frontend/app/pages/settings.vue')
  const promptRoutes = read('src/routes/prompts.ts')

  // 场景/角色用 @名字 引用（名字必须与场景/角色列表完全一致）
  for (const source of [agents, skill, prompt]) {
    assert.match(source, /@场景名/)
    assert.match(source, /@角色名/)
    assert.match(source, /@道具名/)
    // 示例可以更换名字，但图片标记必须保留同一名字。
    assert.match(source, /@([\p{L}\p{N}_]+)`?\s*→\s*`?@图片\d+\1/u)
    assert.doesNotMatch(source, /<location>/)
    assert.doesNotMatch(source, /<role>/)
  }

  // 设置页通过服务端恢复默认，再读取包含同一引用契约的有效提示词。
  const reset = settings.slice(settings.indexOf('async function resetAgentPrompt(type)'), settings.indexOf('async function saveAgentCfg(type)'))
  assert.match(reset, /await promptAPI\.reset\(type, editLang\.value\)/)
  assert.match(reset, /await promptAPI\.get\(type, editLang\.value\)/)
  assert.match(reset, /agentForm\.system_prompt = cfg\.system_prompt/)
  assert.match(promptRoutes, /system_prompt: DEFAULT_PROMPTS\[type\]\.instructions/)
  assert.doesNotMatch(settings, /storyboard_breaker:\s*`|prompt_generator:\s*`/)
  assert.doesNotMatch(settings, /<location>/)
  assert.doesNotMatch(settings, /<role>/)
})
