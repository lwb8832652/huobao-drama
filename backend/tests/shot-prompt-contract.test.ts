import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8')
const budget = /dialogueSeconds\s*=\s*spokenChars\s*\/\s*4\s*\+\s*pauseSeconds\s*\+\s*handoffSeconds\s*\+\s*actingSeconds/
const obsolete = /4\.5|500\s*(?:字|characters|자)|8[-〜～]15|2[-〜～]4|按\s*3\s*秒|每个【镜头N】映射为\s*1-2|3-second segments|3秒を1区間|3초를 한 구간|duration\s*÷\s*3/
const locales = [
  { suffix: '', retain: /不(?:得|能|允许)(?:静默)?(?:删|漏|省略)|完整保留/, natural: /自然.*(?:边界|切点)/, range: /模型.*(?:范围|上下限)/, grid: /(?:同一|一个).*格组/, overflow: /(?:装不下|超出|超过).*?(?:拆|分)|(?:拆|分).*?(?:语义|句意)/, noSave: /停止保存|不保存/, saveOnly: /只有.*(?:通过|满足).*保存/ },
  { suffix: '.en', retain: /preserve.*(?:dialogue|line)|never.*(?:omit|drop|shorten)/i, natural: /natural.*boundar/i, range: /model.*(?:range|minimum|maximum)/i, grid: /same.*grid/i, overflow: /split.*semantic|semantic.*split/i, noSave: /do not save/i, saveOnly: /save only (?:after|when)/i },
  { suffix: '.ja', retain: /(?:省略|削除).*禁止|完全に保持/, natural: /自然な.*(?:境界|切れ目)/, range: /モデル.*(?:範囲|上限|下限)/, grid: /同じ.*グリッド/, overflow: /意味.*(?:分割|区切)|(?:分割|区切).*意味/, noSave: /保存せず/, saveOnly: /(?:満た|通過).*場合のみ.*保存/ },
  { suffix: '.ko', retain: /(?:삭제|생략).*금지|완전히 보존/, natural: /자연스러운.*경계/, range: /모델.*(?:범위|상한|하한)/, grid: /같은.*그리드/, overflow: /의미.*(?:분할|나누)|(?:분할|나누).*의미/, noSave: /저장하지 말고/, saveOnly: /(?:충족|통과).*경우에만.*저장/ },
]

function inlineInstructions(source: string, agent: string) {
  const start = source.indexOf(`  ${agent}: {`)
  assert.ok(start >= 0, `${agent}: default prompt must exist`)
  const instructions = source.indexOf('instructions: `', start) + 'instructions: `'.length
  const end = source.indexOf('`,\n  },', instructions)
  assert.ok(end > instructions, `${agent}: default instructions must be readable`)
  return source.slice(instructions, end)
}

function assertTimingContract(text: string, name: string, locale = locales[0]) {
  assert.match(text, budget, `${name}: speech, punctuation pauses, speaker handoffs and acting need one shared timing budget`)
  assert.match(text, locale.retain, `${name}: source dialogue must survive intact`)
  assert.match(text, locale.natural, `${name}: time spans must follow natural boundaries`)
  assert.match(text, locale.range, `${name}: duration must respect the selected model's range`)
  assert.match(text, locale.grid, `${name}: multiple frames must remain inside the storyboard's grid`)
  assert.match(text, locale.overflow, `${name}: overflow must be handled at semantic boundaries`)
  assert.doesNotMatch(text, obsolete, `${name}: old fixed blocks, quotas and speech rate must not override dialogue timing`)
}

test('all localized storyboard breakdown prompts plan complete dialogue before natural camera spans', async () => {
  for (const locale of locales) {
    const name = `storyboard_breaker${locale.suffix}.md`
    assertTimingContract(await read(`../workspace/prompts/${name}`), name, locale)
  }
  assertTimingContract(await read('../workspace/skills/storyboard-breaker/SKILL.md'), 'storyboard-breaker skill')
})

test('all localized video prompt layers preserve dialogue and report overflow instead of truncating it', async () => {
  for (const locale of locales) {
    const name = `prompt_generator${locale.suffix}.md`
    const text = await read(`../workspace/prompts/${name}`)
    assertTimingContract(text, name, locale)
    assert.match(text, /storyboard_id.*video_prompt/)
    assert.match(text, locale.noSave, `${name}: overflow must not save an incomplete prompt`)
    assert.match(text, locale.saveOnly, `${name}: the save instruction must honor the timing check`)
  }
  assertTimingContract(await read('../workspace/skills/prompt-generator/video-prompt/SKILL.md'), 'video-prompt skill')
})

test('missing workspace files fall back to the same dialogue timing contract', async () => {
  const source = await read('../src/agents/index.ts')
  for (const agent of ['storyboard_breaker', 'prompt_generator']) {
    assertTimingContract(inlineInstructions(source, agent), `${agent}: default`)
  }
})

test('settings restore defaults through the server and reload the effective language prompt', async () => {
  const settings = await read('../../frontend/app/pages/settings.vue')
  const start = settings.indexOf('async function resetAgentPrompt(type)')
  const end = settings.indexOf('\n}', start) + 2
  const reset = settings.slice(start, end)
  assert.match(reset, /await promptAPI\.reset\(type, editLang\.value\)/)
  assert.match(reset, /await promptAPI\.get\(type, editLang\.value\)/)
  assert.match(reset, /agentForm\.system_prompt = cfg\.system_prompt/)
  assert.doesNotMatch(settings, /storyboard_breaker:\s*`|prompt_generator:\s*`/, 'settings must not maintain a second prompt template')
  const routes = await read('../src/routes/prompts.ts')
  assert.match(routes, /app\.post\('\/:type\/reset'[\s\S]*?deleteFile\(path\)/)
  assert.match(routes, /system_prompt: DEFAULT_PROMPTS\[type\]\.instructions/)
})

test('batch, individual and breakdown requests reinforce dialogue timing without fixed three-second blocks', async () => {
  const batch = await read('../src/services/video-prompts.ts')
  const episode = await read('../../frontend/app/views/drama/episode.vue')
  const breakdownStart = episode.indexOf('function doBreakdown()')
  const individualStart = episode.indexOf('async function genVideoPrompt(sb)')
  const individualEnd = episode.indexOf('\n}', individualStart) + 2
  for (const [name, text] of [
    ['batch request', batch],
    ['breakdown request', episode.slice(breakdownStart, individualStart)],
    ['individual request', episode.slice(individualStart, individualEnd)],
  ]) {
    assert.match(text, /4\s*(?:个)?汉字.*秒|每秒\s*4\s*(?:个)?汉字/, `${name}: declare conservative dialogue speed`)
    assert.match(text, /标点.*停顿/, `${name}: allow punctuation pauses`)
    assert.match(text, /换人|说话人切换/, `${name}: allow speaker handoffs`)
    assert.match(text, /表演/, `${name}: allow acting`)
    assert.match(text, /完整保留|不得.*(?:省略|删|漏)/, `${name}: retain dialogue`)
    assert.match(text, /自然.*边界/, `${name}: follow natural boundaries`)
    assert.doesNotMatch(text, obsolete, `${name}: no fixed duration recipe`)
  }
})
