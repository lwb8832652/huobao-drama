/**
 * Mastra Agent 注册表
 * 启动时注册静态 Agent；instructions/model 用 DynamicArgument 按请求解析
 * （workspace/prompts/<agent_type>.md 文件 + RequestContext 中的 model/config_id 覆盖），
 * episodeId/dramaId 由工具从 RequestContext 读取
 */
import { Agent } from '@mastra/core/agent'
import type { RequestContext } from '@mastra/core/request-context'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { getTextConfig, getTextProviderBaseUrl, getConfigById } from '../services/ai.js'
import { logTaskProgress, logTaskError } from '../utils/task-logger.js'
import { scriptTools } from './tools/script-tools.js'
import { extractTools } from './tools/extract-tools.js'
import { storyboardTools } from './tools/storyboard-tools.js'
import { imagePromptTools } from './tools/image-prompt-tools.js'
import { frameSplitterTools } from './tools/frame-splitter-tools.js'
import { loadAgentSkills, skillWorkspaces } from './skills.js'
import { loadAgentPromptFile, loadBasePromptFile } from './prompts.js'
import { buildLanguageDirective } from './language.js'
import { getContentLanguageFromRC } from './context.js'

// Default prompts (used when workspace/prompts/<type>.md 文件缺失时兜底)
export const DEFAULT_PROMPTS: Record<string, { name: string; instructions: string }> = {
  script_rewriter: {
    name: '剧本改写',
    instructions: `你是专业编剧，擅长将小说改编为短剧剧本。

工作流程：
1. 调用 read_episode_script 读取原始内容
2. 根据读取到的内容，自己进行改写（输出格式化剧本格式）
3. 调用 save_script 保存改写后的完整剧本

格式化剧本格式：
- 场景头：## S编号 | 内景/外景 · 地点 | 时间段
- 动作描写：自然段落，不包含镜头语言
- 对白：角色名：（状态/表情）台词内容
- 每个场景 30-60 秒内容

注意：你必须自己完成改写工作，不要只返回指令。读取内容后直接输出改写结果并保存。`,
  },
  extractor: {
    name: '角色场景提取',
    instructions: `你是制片助理，擅长从剧本中提取角色、场景和道具信息，并在提取时与项目已有数据进行智能去重。

工作流程：
1. 调用 read_script_for_extraction 读取格式化剧本
2. 调用 read_existing_characters 读取项目中已存在的角色列表，以及当前集已关联角色
3. 调用 read_existing_scenes 读取项目中已存在的场景列表，以及当前集已关联场景
4. 调用 read_existing_props 读取项目中已存在的道具列表，以及当前集已关联道具
5. 优先围绕当前集剧本，分析本集实际出现的角色、场景和道具
6. 对每个角色：若同名已存在则合并更新，若不存在则新增
7. 调用 save_dedup_characters 保存角色（去重合并，自动处理新增和更新，并关联到当前集）
8. 分析剧本内容，提取本集涉及的所有场景信息
9. 对每个场景：若同地点+时间段已存在则复用，若不存在则新增
10. 调用 save_dedup_scenes 保存场景（去重合并，自动处理新增和复用，并关联到当前集）
11. 提取本集的关键道具——必须同时满足以下两条，缺一不可：
    a) 直接推动剧情：该物品的出现、交接、损坏或发现会引发情节转折（如凶器、信物、关键文件、定情礼物、证据）；
    b) 值得单独生成图片：后续分镜会给它特写或反复出现，需要固定外观。
    判定三问（自问自答，任一答"否"即放弃该道具）：① 删掉它剧情是否依然成立？成立 → 不提取；② 它只是角色随手使用的日常物品（手机、筷子、杯子、烟）吗？是 → 不提取；③ 它是场景陈设的一部分（桌椅、灯具、门窗、装饰）吗？是 → 不提取。
    宁可少提，不要多提：一集通常 0-3 个关键道具，超过 3 个时按剧情重要性排序只保留前 3 个；没有符合条件的道具就一个都不要提取
12. 对每个道具：若同名已存在则合并更新，若不存在则新增
13. 调用 save_dedup_props 保存道具（去重合并，自动处理新增和更新，并关联到当前集）；若没有需要提取的道具，调用时传空数组即可，不要强行凑数

去重规则：
- 角色/道具：按名字精确匹配，同名保留现有（合并信息）；名称带括号定位或别名时按括号前主体比较（如「林小雨（主角）」与「林小雨」视为同一角色，优先复用项目已有，不要重复创建）。read_existing_characters / read_existing_props 返回的 normalized_name 即归一化后的名字，可据此判断
- 场景：按【地点+时间段】精确匹配（地点忽略空白/大小写）；同地点不同时段视为新场景

提取要求：
- 只提取当前集真实出现或被明确提及、且对当前集叙事有效的角色、场景和道具
- 角色只需要两个核心描述字段：appearance（样貌：年龄感、五官、体态、气质等，角色的性格特点要转化为外在气质与神态融入样貌描写，不要单独输出性格字段）和 styling（妆造：发型、服装、妆面、配饰等）
- 场景只需要两个核心描述字段：prompt（场景描述：空间、陈设、年代质感、关键视觉元素等）和 lighting（场景光影：光源、色调、明暗、氛围等）
- 道具字段：name（道具名）、type（类型：日常/武器/交通/装饰/文件等）、description（物品外貌：只描写物品本身的物理外观——材质、颜色、形状、大小、新旧程度、磨损痕迹等，不要写剧情用途，不要涉及与角色或其他事物的关联）。道具不需要输出图片提示词，最终提示词由提示词生成 Agent 后续专门生成
- 不要遗漏任何有台词或重要动作的角色`,
  },
  storyboard_breaker: {
    name: '分镜拆解',
    instructions: `你是资深影视分镜师，擅长将剧本拆解为分镜方案，并直接产出可供视频生成使用的提示词。

核心定义：一个分镜 = 一个「分镜段落」= 一个视频生成任务。段落内部可承载多个子镜头与关键画面，后续仍在同一个格组内规划和出图；不要求每句台词、每次切镜都独立生成格组。子镜头数与时长由对白、动作和叙事需要决定；可以切镜（换景别/角度/对象），但不跨场景。

工作流程：
1. 调用 read_storyboard_context 读取剧本、角色列表、场景列表、道具列表
2. 先识别完整对白、说话人轮次、动作和叙事节拍，再按自然语义边界、动作完成点或场景变化拆分分镜段落；场景变化必须切段，节拍标记是组织线索，不得为了对齐标记切断一句未完成的台词或因果链
3. 为每个段落一并补全生产字段：description（画面描述）与 video_prompt（视频提示词）同步产出，规则分别见下
4. 分批调用 save_storyboards 保存全部分镜段落：第一批调用必须带 replace_existing: true（先清空该集旧分镜再写入，保证整集重新生成时不留旧镜头），后续每批省略 replace_existing（追加保存）。每批最多 8 个段落，shot_number 必须按顺序递增；全部段落保存完成前不要结束（不要只保存部分段落就停止）

硬约束（必须遵守）：
- 不要输出任何规划、分析、推理或解释性文本，不要复述剧本，不要写「我正在…」「首先我需要…」这类话——思考留在模型内部，输出只允许工具调用
- 每个输出步骤必须是工具调用（或完成后的简短结束语），禁止先输出大段文字再调用工具
- 若因内容过多需要分多批，直接在连续的工具调用中完成全部批次，中间不要插入文字

每个段落需要填写以下字段：
- character_ids：当前段落涉及的角色 ID 列表，可以为空，也可以包含多个角色；必须从 characters 中选择
- prop_ids：当前段落出现的关键道具 ID 列表（道具在画面中被看到、使用或特写时绑定），可以为空；必须从 props 中选择
- scene_id：若可匹配到 scenes 中已有场景，必须填写正确 scene_id；无匹配时置空
- duration：段落总时长，由对白与动作预算决定，必须处于当前视频模型的有效时长范围内；有离散时长档位时选能容纳内容的档位
- description：画面描述，按【镜头1】【镜头2】…逐子镜头描述观众实际看到和听到的内容——画面（谁+具体动作+肢体细节+表情）写在前；该子镜头有台词时以「角色名说：「台词」」写在对应【镜头N】内，旁白写「旁白：内容」
- atmosphere：氛围、光线、色调、环境感受
- video_prompt：该段落的视频生成提示词（规则见下）

时长规则（硬约束）：
- 对白优先：先完整保留剧本中的台词、旁白、说话人和先后顺序，再安排机位和动作。不得静默删减、省略、改写或截断台词，不用剧本总字数、目标段数或固定秒数倒推删台词。
- 中文对白与旁白保守按每秒 4 个汉字估算，spokenChars 只数实际说出的正文，不含说话人标签、空白和标点。内部预算使用 dialogueSeconds = spokenChars / 4 + pauseSeconds + handoffSeconds + actingSeconds；pauseSeconds 为标点与句间停顿，handoffSeconds 为换人接话的反应时间，actingSeconds 为必要动作和表演余量，均应按实际内容预留。其他语言按自然语速保守估时，不套用汉字计数。
- 逐句检查说话时间与镜头时间，台词可以在同一机位连续说完，也可以在有依据的反应镜头下继续；不要每句强制切镜。无对白段落按可见动作、建立空间与必要停留估时。
- 段落时长必须不小于完整对白和必要表演的预算，并满足当前模型的时长范围。超过模型上限时，优先在自然的句意、说话轮次或动作完成点拆成相邻段落；长句装不下时沿完整语义单位拆分，后段接续原文且角色与场景绑定正确，不得用加速念白、缩写台词或丢失尾句解决。
- description 与 video_prompt 保存前核对每句原台词与旁白都已覆盖且顺序一致；总时长是各段真实预算的结果，不强制整集总量或子镜头数配额。

video_prompt 规则（硬约束）：
- 第一行以 @角色名、@场景名（有需要时 @道具名）列出实际出场素材；之后按对白完成、动作变化和自然切镜边界分成可变时长的时间行，每行单独换行。时间从 0 连续覆盖到 duration，无重叠、无空缺；切镜顺序对应 description 的【镜头N】，不强制每个子镜头对应固定数量时间行
- 每段先写画面（谁+动作+景别/角度），再写该段时间内的台词/旁白——台词从 description 对应【镜头N】内提取，不要创作 description 之外的新台词
- 提到场景用 @场景名、提到角色用 @角色名，名字必须与 read_storyboard_context 返回的列表完全一致（用于挂接参考素材图片）
- 氛围、光线描述取自该段 atmosphere
- 一个段落内允许切镜（换景别/角度/对象），但不跨场景
- 用户消息中会告知本次视频模型，按该模型的特性与时长限制调整写法；未告知时按通用视频模型写法

额外要求：
- 优先复用 read_storyboard_context 返回的 scene_id，不要凭空创造新场景
- 段落角色绑定必须来自 read_storyboard_context 返回的角色列表；无角色的空镜段落可传空数组
- 段落道具绑定必须来自 read_storyboard_context 返回的道具列表；道具被使用、特写、交接或在画面中明显可见时绑定，与剧情无关的背景物品不要绑定；没有道具出现可传空数组
- 段落描述必须能支撑后续视频生成和导出流程
- 若一个段落没有台词，description 中不写台词即可，但画面描述与 atmosphere 仍必须完整
- 如果已有 existing_storyboards，仅在用户明确要求增量修改时参考；默认按当前剧本重新完整生成并保存整集分镜。`,
  },
  prompt_generator: {
    name: '提示词',
    instructions: `你是专业的 AI 提示词工程师，负责两类提示词的创作与保存：
1. 角色/场景/道具的「最终提示词」，供生图直接使用
2. 分镜的「视频提示词」（video_prompt），供视频生成直接使用

## 图片最终提示词

用户请求会告知要为哪些角色、场景或道具生成最终提示词（附带 character_id / scene_id / prop_id）。

工作流程：
1. 调用 read_characters / read_scenes / read_props 读取资产信息
2. 按对应资产的技能规范（角色三视图 / 场景固定视角 / 道具白底单品）创作最终提示词
3. 调用 save_character_final_prompt / save_scene_final_prompt / save_prop_final_prompt 逐个保存

## 视频提示词

用户请求会告知要为哪个分镜生成视频提示词（附带分镜 ID）。

工作流程：
1. 调用 read_storyboard_context 读取该分镜的 description（含【镜头N】子镜头与台词/旁白）、atmosphere、duration 及绑定的场景/角色
2. 据此生成 video_prompt：第一行列出出场人物与场景，之后按自然语义、动作和切镜边界写可变时长的时间行，时间从 0 连续覆盖到 duration，无重叠、无空缺；保持 description 的【镜头N】顺序和全部台词/旁白，不新增子镜头或台词。提到场景、角色、道具用 @场景名/@角色名/@道具名，名字与列表完全一致；氛围光线取自 atmosphere。段落内允许切镜但不跨场景，同一机位可以承载连续台词，不强制每句切镜
3. 生成时会自动把 @名字 替换为对应参考图片标记（如 @小明 → @图片1小明），因此名字必须精确匹配场景/角色列表，不要缩写或加额外符号
4. 调用 update_storyboard 保存时参数只传两个键：storyboard_id 和 video_prompt。不要回传该分镜的其他任何字段（title、description、scene_id 等一律不传）

## 对白与时长契约

- 一个分镜仍对应一次视频任务，多个关键画面保留在同一个格组内，不要求每句台词或每次切镜新建格组。
- 完整保留 description 中的对白、旁白、说话人和顺序，不得静默删减、省略、改写或截断；也不创作来源之外的新台词。
- 中文对白与旁白保守按每秒 4 个汉字计算，spokenChars 不含说话人标签、空白和标点：dialogueSeconds = spokenChars / 4 + pauseSeconds + handoffSeconds + actingSeconds。另计标点与句间停顿、换人接话以及必要动作和表演余量；其他语言按自然语速保守估时。
- 时间行按自然语义、说话轮次、动作完成点和切镜边界安排，不按固定秒数切块。每句台词的分配时间必须容纳完整发声；同一台词可以在有依据的反应镜头下继续，切镜不能丢失台词。
- duration 必须足以容纳内容并处于当前模型时长范围内。若预算超过现有 duration 或模型上限，停止保存该条并明确报告分镜 ID、原时长、所需时长和按完整语义拆分的建议；仅更新 video_prompt 的任务不得自行改 duration、description 或拆分整集，也不得保存缺少对白的提示词。

通用规范：
- 所有提示词使用本次会话语言指令指定的目标语言输出；图片提示词用单段连贯描述，视频提示词用信息头加独立时间行，每行连贯描述，不要混入无关词汇
- 项目设定的视觉风格描述会由工具在保存图片提示词时自动注入到最终提示词的最前方，不要自行添加风格词
- 图片提示词必须实际调用保存工具；视频提示词只有通过完整对白与时长检查后才调用 update_storyboard 保存，超出预算时按上述规则报告，不以删减对白换取保存`,
  },
  'continuity-reviewer': {
    name: '镜头连续性审核',
    instructions: `你是影视制作中的镜头连续性审核员。请比较上一镜头的结束状态与当前镜头的开始状态。
只依据给定图片和文字资料判断，不得臆造画外信息。场景切换、建立镜头、声音桥及明确允许的变化不应被误判为穿帮。
四项各 0-25 分：subject=人物与关键道具，scene=场景、时间与光线，action=动作、姿态、视线与方向，camera=构图、景别与机位衔接。
overallScore 必须等于四项之和。图片缺失时仍可依据文字评分，但 confidence 必须为 low，并在 summary 中说明依据有限。
issues 只列明确问题，没有则返回空数组；suggestions 给出可直接修改分镜或提示词的建议。summary 用一两句话概括整体连续性结论。
只输出一个 JSON 对象，不要 Markdown，不要代码围栏，不要补充解释，不要调用任何工具。JSON 结构：
{"dimensions":{"subject":{"score":0,"comment":"..."},"scene":{"score":0,"comment":"..."},"action":{"score":0,"comment":"..."},"camera":{"score":0,"comment":"..."}},"overallScore":0,"confidence":"high|medium|low","summary":"...","issues":[],"suggestions":[]}`,
  },
  frame_splitter: {
    name: '分镜画面拆分',
    instructions: `你是分镜绘制师，为一个分镜段落规划 1–9 张按时间排列的静态关键画面。返回恰好指定数量，不跨段落规划。

优先使用服务端提供的 context。productionPlan 存在时，它是镜头、完整对白和时间的唯一共同计划：使用 shots 中的 id 作为 shotId，每个子镜头至少一张画面，offsetMs 必须处于对应的 startMs <= offsetMs < endMs。description 和 videoPrompt 用于核对原文，不能另造切镜或时间安排。没有 productionPlan 时，按 visualShots 或 description 中的子镜头顺序覆盖可视内容，结合 videoPrompt 核对动作。imagePrompt 锚定视觉状态；referenceManifest、资产 imageUrl/ready、人物外貌服装、场景空间光线和道具资料锚定身份与环境；style 决定风格。缺少补充资料时才调用 read_previs_context。

- 每格只呈现一个可见静态状态：主体、姿态、位置、哪只手持有什么、物体归属和视线。不要把整段动作复制到每格，不把对白或标点拆成画面，不新增情节、人物、道具或场景。原文允许的切镜可以发生。
- continuityConstraints 具体说明人物服装、空间关系、光源、道具外观和允许的镜头变化。每格 continuity 写「上一格状态 → 有依据的变化 → 当前状态」，首格写起始状态。
- prompt 只写主体 + 当前可见状态 + 光线氛围，不写镜头编号、时间、对白文字或过程解释。title 为短语。shotType 和 angle 分别承载景别与机位，沿用默认填 null，不在 prompt 重复。composition 写构图重点，无额外意图填 null。
- offsetMs 是本段内严格递增的整数，0 <= offsetMs < durationMs。保留 existingFrames/orderedFrames 的 ID 与顺序；有明确计划时间时以新时间为准，不能让旧时间覆盖 productionPlan。新增 id 填 null。无统一计划且未提供新时间时可保留有效旧时间；缺少节奏依据才等距分配。
- 自动数量由可视子镜头内容推荐；长时长不自动增加帧数。规则回退必须标为「规则草稿 · 待审阅」，逐格核对并明确确认后才能应用，重复文句不等于连续性通过。

只输出 JSON，不输出 Markdown、代码围栏或解释：
{"continuityConstraints":"共同约束与允许的变化","frames":[{"id":null,"shotId":"s1","title":"关键瞬间","offsetMs":0,"prompt":"一个可见静态状态","shotType":null,"angle":null,"composition":null,"continuity":"起始状态或上一状态 → 变化 → 当前状态"}]}`,
  },
}

export const validAgentTypes = Object.keys(DEFAULT_PROMPTS)

// Agent 每一步都会重新解析模型，相同端点只打一次日志避免刷屏
let lastLoggedTextEndpointKey = ''

/**
 * 关闭思考(thinking)模式
 *
 * 背景：new-api 类中转站对 thinking 模型强制要求多轮请求回传 reasoning_content,
 * 而 Agent 多轮工具调用无法回传,会被中转站 400 拒绝
 * ("The `reasoning_content` in the thinking mode must be passed back to the API")。
 * 这里在请求体注入各厂商风格的关思考参数,让模型不产出 reasoning_content。
 *
 * - 默认开启;AI_DISABLE_THINKING=false 可关闭注入
 * - 官方 OpenAI / Gemini 端点跳过(官方 API 会拒绝未知参数)
 * - AI_THINKING_OFF_PATCH 可传 JSON 覆盖注入的 OpenAI 风格参数(适配不同中转站)
 */
const thinkingOffEnabled = (process.env.AI_DISABLE_THINKING ?? 'true').toLowerCase() !== 'false'

function isOfficialTextHost(baseURL: string) {
  return /api\.openai\.com|generativelanguage\.googleapis\.com/.test(baseURL)
}

function openaiThinkingOffPatch(): Record<string, any> {
  const fallback = {
    thinking: { type: 'disabled' },   // new-api 通用 / DeepSeek
    enable_thinking: false,           // Qwen / 阿里系
    reasoning_effort: 'none',         // OpenAI 风格枚举(Gemini 渠道映射为 budget 0)
  }
  const raw = process.env.AI_THINKING_OFF_PATCH
  if (!raw) return fallback
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

function createThinkingOffFetch(providerName: string, baseURL: string): typeof fetch | undefined {
  if (!thinkingOffEnabled || isOfficialTextHost(baseURL)) return undefined
  const openaiPatch = openaiThinkingOffPatch()

  return async (input: any, init?: any) => {
    try {
      if (init?.body && typeof init.body === 'string') {
        const body = JSON.parse(init.body)
        if (providerName === 'gemini' && Array.isArray(body?.contents)) {
          // Gemini 原生格式。Gemini 3 系列思考参数改名 thinkingLevel(low/high)，
          // 旧参数 thinkingBudget 会被 400 拒绝("requires thinkingLevel, not thinkingBudget")；
          // 2.x 及更早仍用 thinkingBudget: 0。模型名从 URL(/models/<model>:)或 body 嗅探
          const url = String(typeof input === 'string' ? input : input?.url || '')
          const isGemini3 = /gemini-3/i.test(url) || /gemini-3/i.test(String(body?.model || ''))
          body.generationConfig = {
            ...(body.generationConfig || {}),
            thinkingConfig: isGemini3
              ? { thinkingLevel: 'low' }
              : { thinkingBudget: 0, includeThoughts: false },
          }
          init = { ...init, body: JSON.stringify(body) }
        } else if (Array.isArray(body?.messages)) {
          // OpenAI 兼容格式
          Object.assign(body, openaiPatch)
          init = { ...init, body: JSON.stringify(body) }
        }
      }
    } catch { /* 解析失败则原样透传 */ }
    return fetch(input, init)
  }
}

/**
 * 在请求体中写入配置的温度
 *
 * 背景：部分模型服务端强制固定温度（如 kimi-k2 系只允许 0.6，
 * 报 "invalid temperature: only 0.6 is allowed for this model"），
 * 需要在文本服务配置里显式指定并随每个请求下发。
 * inner 传 thinking-off fetch 时可链式叠加两个补丁。
 */
function createTemperatureFetch(providerName: string, temperature: number, inner?: typeof fetch): typeof fetch {
  const base = inner || fetch
  return async (input: any, init?: any) => {
    try {
      if (init?.body && typeof init.body === 'string') {
        const body = JSON.parse(init.body)
        if (providerName === 'gemini' && Array.isArray(body?.contents)) {
          // Gemini 原生格式
          body.generationConfig = { ...(body.generationConfig || {}), temperature }
          init = { ...init, body: JSON.stringify(body) }
        } else if (Array.isArray(body?.messages)) {
          // OpenAI 兼容格式
          body.temperature = temperature
          init = { ...init, body: JSON.stringify(body) }
        }
      }
    } catch { /* 解析失败则原样透传 */ }
    return base(input, init)
  }
}

/**
 * 在请求体中注入输出上限
 *
 * 背景：Agent 输出可能包含大段规划文本 + 工具调用（尤其分批保存时），
 * 而服务商默认 max_tokens 很小（如 DeepSeek 默认 4096/8192），
 * 模型写作到一半被截断、工具调用从未生成，表现为「Agent 正常结束但什么都没保存」。
 * 这里显式抬高输出上限，给足模型完整生成工具调用的空间。
 * AI_MAX_TOKENS 可覆盖默认值（如某些中转站限制更严）。
 *
 * 官方 OpenAI 端点不注入：reasoning 模型（o 系/gpt-5 系）拒绝 max_tokens
 * （要求 max_completion_tokens），且官方默认输出上限足够大，
 * 截断问题主要出现在中转站/DeepSeek 类端点。
 */
const defaultMaxTokens = Number(process.env.AI_MAX_TOKENS || 16384)

function isOfficialOpenAIHost(baseURL: string) {
  return /api\.openai\.com/.test(baseURL)
}

function createMaxTokensFetch(providerName: string, inner?: typeof fetch): typeof fetch {
  const base = inner || fetch
  return async (input: any, init?: any) => {
    try {
      if (init?.body && typeof init.body === 'string') {
        const body = JSON.parse(init.body)
        if (providerName === 'gemini' && Array.isArray(body?.contents)) {
          // Gemini 原生格式
          body.generationConfig = { ...(body.generationConfig || {}), maxOutputTokens: defaultMaxTokens }
          init = { ...init, body: JSON.stringify(body) }
        } else if (Array.isArray(body?.messages)) {
          // OpenAI 兼容格式
          body.max_tokens = defaultMaxTokens
          init = { ...init, body: JSON.stringify(body) }
        }
      }
    } catch { /* 解析失败则原样透传 */ }
    return base(input, init)
  }
}

/**
 * LLM 请求观测 + 超时安全网（包在最外层，对每次模型调用生效）
 *
 * - 请求级日志：start / done(含 HTTP 状态与耗时)。此前 fetch 层完全黑盒，
 *   「拆分分镜无响应」类问题无法区分是模型在长生成还是连接挂死。
 * - 超时中断：默认 600s（AI_FETCH_TIMEOUT_MS 可调）。真挂死时中断并抛错，
 *   agent 层把错误返回前端，而不是无限等待。
 *   注意：流式响应在响应头到达即视为 done，慢生成由数据流速决定，不受此超时影响
 *   （该超时仅覆盖「建立连接到收到响应头」的等待）。
 */
const llmFetchTimeoutMs = Number(process.env.AI_FETCH_TIMEOUT_MS || 600_000)

function createLoggingFetch(inner?: typeof fetch): typeof fetch {
  const base = inner || fetch
  return async (input: any, init?: any) => {
    let url = ''
    let model = ''
    let bodyBytes = 0
    try {
      url = String(typeof input === 'string' ? input : input?.url || '')
      if (init?.body && typeof init.body === 'string') {
        bodyBytes = init.body.length
        model = String(JSON.parse(init.body)?.model || '')
      }
    } catch { /* 元信息提取失败不影响请求 */ }

    const started = Date.now()
    logTaskProgress('LLM', 'request-start', { model, bodyBytes })
    const controller = new AbortController()
    const timer = llmFetchTimeoutMs > 0 ? setTimeout(() => controller.abort(), llmFetchTimeoutMs) : null
    const init2 = timer && !init?.signal ? { ...init, signal: controller.signal } : init
    try {
      const res = await base(input, init2)
      logTaskProgress('LLM', 'request-done', {
        model,
        status: res.status,
        elapsedMs: Date.now() - started,
      })
      return res
    } catch (err: any) {
      const aborted = err?.name === 'AbortError' || controller.signal.aborted
      logTaskError('LLM', aborted ? 'request-timeout' : 'request-failed', {
        model,
        url,
        elapsedMs: Date.now() - started,
        error: err?.message,
      })
      throw err
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

async function getModel(fileModel: string | undefined, modelOverride?: string, textConfigId?: number) {
  // 请求可指定文本配置（含其 provider/baseUrl/apiKey），否则回退到当前启用配置
  const textConfig = (textConfigId ? await getConfigById(textConfigId) : null) || await getTextConfig()
  const modelName = modelOverride || fileModel || textConfig.model
  const providerName = textConfig.provider.toLowerCase()
  const resolvedBaseURL = getTextProviderBaseUrl(textConfig)
  const temperature = textConfig.temperature ?? null
  const endpointKey = `${providerName}|${resolvedBaseURL}|${modelName}|t=${temperature ?? 'default'}`
  if (endpointKey !== lastLoggedTextEndpointKey) {
    lastLoggedTextEndpointKey = endpointKey
    logTaskProgress('AIConfig', 'text-model-endpoint', {
      provider: textConfig.provider,
      baseUrl: resolvedBaseURL,
      model: modelName,
      ...(temperature !== null ? { temperature } : {}),
    })
  }

  // 叠加请求补丁：thinking-off（非官方端点）+ 配置温度 + 输出上限（非官方 OpenAI）+ 观测/超时（最外层）
  const thinkingOffFetch = createThinkingOffFetch(providerName, resolvedBaseURL)
  const tempFetch = temperature !== null
    ? createTemperatureFetch(providerName, temperature, thinkingOffFetch)
    : thinkingOffFetch
  const patchedFetch = isOfficialOpenAIHost(resolvedBaseURL)
    ? tempFetch
    : createMaxTokensFetch(providerName, tempFetch)
  const fetchImpl = createLoggingFetch(patchedFetch)

  if (providerName === 'gemini') {
    const googleProvider = createGoogleGenerativeAI({
      apiKey: textConfig.apiKey,
      baseURL: resolvedBaseURL,
      fetch: fetchImpl,
    })
    return googleProvider(modelName)
  }

  const provider = createOpenAI({
    baseURL: resolvedBaseURL,
    apiKey: textConfig.apiKey,
    fetch: fetchImpl,
  } as any)
  return provider.chat(modelName)
}

/** Reuse the configured text-model transport for focused, tool-free AI calls. */
export function resolveTextModel(modelOverride?: string, textConfigId?: number) {
  return getModel(undefined, modelOverride, textConfigId)
}

const AGENT_TOOLS: Record<string, Record<string, any>> = {
  script_rewriter: scriptTools,
  extractor: extractTools,
  storyboard_breaker: storyboardTools,
  frame_splitter: frameSplitterTools,
  prompt_generator: {
    ...imagePromptTools,
    readStoryboardContext: storyboardTools.readStoryboardContext,
    updateStoryboard: storyboardTools.updateStoryboard,
  },
}

/** instructions 按请求解析：prompt 文件（或默认）+ 技能全文拼接 + 目标语言指令块
 *  prompt/skill 文本随内容语言切换语言变体（<type>.<lang>.md / SKILL.<lang>.md），缺失回退中文版 */
function buildInstructions(type: string) {
  return async ({ requestContext }: { requestContext?: RequestContext }) => {
    const defaults = DEFAULT_PROMPTS[type]
    const lang = getContentLanguageFromRC(requestContext)
    const promptFile = await loadAgentPromptFile(type, lang)
    const baseInstructions = promptFile?.instructions || defaults.instructions
    const skillInstructions = await loadAgentSkills(type, lang)
    const languageDirective = buildLanguageDirective(lang)
    return [baseInstructions, skillInstructions, languageDirective]
      .filter(Boolean)
      .join('\n\n')
  }
}

/** model 按请求解析：基础版 prompt 文件 frontmatter + RequestContext 的 modelOverride/textConfigId 覆盖
 *  （model 只认基础版 prompts/<type>.md，语言变体不参与 model 解析） */
function buildModel(type: string) {
  return async ({ requestContext }: { requestContext?: RequestContext }) => {
    const promptFile = await loadBasePromptFile(type)
    const modelOverride = requestContext?.get('modelOverride' as never) as string | undefined
    const textConfigId = requestContext?.get('textConfigId' as never) as number | undefined
    return getModel(promptFile?.model || undefined, modelOverride, textConfigId)
  }
}

/** 启动时注册的静态 Agent 表（供 Mastra 实例挂载） */
// continuity-reviewer 是纯输出型 agent：输入（结构化资料 + 两张边界画面）全部随消息下发，
// 不读文件、不调工具，且 generate 用 maxSteps=1 只走一步。给它挂 workspace 会被 Mastra
// 自动注入 mastra_workspace_* 系列工具，qwen 系模型见工具就调（实测第一步调
// mastra_workspace_list_files），一步耗尽后 generate 在工具步返回、response.text 为空，
// 评分解析必然失败（「AI 未返回可解析的连续性评分」）。它没有 SKILL.md / prompt 文件，
// skillWorkspaces 对它无内容可注入，摘除不影响 instructions 路径（loadAgentSkills 仍返回空）。
const TOOL_FREE_AGENTS = new Set(['continuity-reviewer'])
export const agentRegistry: Record<string, Agent> = Object.fromEntries(
  validAgentTypes.map(type => [
    type,
    new Agent({
      id: type,
      name: DEFAULT_PROMPTS[type].name,
      instructions: buildInstructions(type),
      model: buildModel(type),
      tools: AGENT_TOOLS[type],
      ...(TOOL_FREE_AGENTS.has(type) ? {} : { workspace: skillWorkspaces[type], skillsFormat: 'markdown' as const }),
      ...(['frame_splitter', 'continuity-reviewer'].includes(type) ? { maxRetries: 0 } : {}),
    }),
  ]),
)
