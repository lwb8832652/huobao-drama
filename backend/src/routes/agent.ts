/**
 * Agent 聊天路由 — 非流式版本
 */
import { Hono } from 'hono'
import { validAgentTypes } from '../agents/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { mastra } from '../mastra/index.js'
import { success, badRequest } from '../utils/response.js'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()

// Mastra v1.17 的 ToolCallChunk / ToolResultChunk 结构：
// { type: 'tool-call', payload: { toolCallId, toolName, args } }
// { type: 'tool-result', payload: { toolCallId, toolName, result, isError } }
function normalizeToolName(entry: any) {
  return entry?.payload?.toolName
    || entry?.toolName
    || entry?.tool?.toolName
    || entry?.tool?.id
    || entry?.name
    || entry?.type
    || null
}

function normalizeToolResult(entry: any) {
  const result = entry?.payload?.result ?? entry?.result ?? entry?.payload?.output ?? entry?.output ?? entry?.data ?? null
  return typeof result === 'string' ? result : JSON.stringify(result)
}

// POST /agent/:type/chat — 非流式 Agent 对话
app.post('/:type/chat', async (c) => {
  const agentType = c.req.param('type')
  if (!validAgentTypes.includes(agentType)) {
    return badRequest(c, `无效的 Agent 类型：${agentType}`)
  }

  const body = await c.req.json()
  const { message, drama_id, episode_id } = body

  logTaskStart('Agent', agentType, {
    dramaId: drama_id,
    episodeId: episode_id,
    message,
  })
  logTaskPayload('Agent', `${agentType} input`, body)

  if (!episode_id || !drama_id) {
    logTaskError('Agent', agentType, { reason: 'missing drama_id or episode_id' })
    return badRequest(c, '需要 drama_id 与 episode_id')
  }

  const agent = mastra.getAgent(agentType)
  if (!agent) {
    logTaskError('Agent', agentType, { reason: 'agent not found' })
    return badRequest(c, 'Agent 不存在')
  }

  const requestContext = buildAgentRequestContext({
    episodeId: episode_id,
    dramaId: drama_id,
    modelOverride: body.model || undefined,
    textConfigId: body.config_id || undefined,
  })

  const startTime = performance.now()

  // 连续工具失败熔断：同一轮循环里工具调用连续失败 N 次（校验失败/执行报错且无任何成功），
  // 提前终止任务。此前模型会带着错误反复重试直到烧满 maxSteps=20（实测浪费 3 分钟以上）。
  const CIRCUIT_BREAKER_LIMIT = 3
  const abortController = new AbortController()
  let consecutiveToolFailures = 0
  let circuitBreakerTriggered = false
  const isFailedToolResult = (tr: any) => {
    if (!!(tr?.payload?.isError ?? tr?.isError ?? tr?.payload?.error ?? tr?.error)) return true
    // 校验失败的结果是 {error:true, message:...} 形态，isError 字段并不存在
    const r = tr?.payload?.result ?? tr?.result
    if (r && typeof r === 'object' && r.error === true) return true
    if (typeof r === 'string' && r.includes('"error":true')) return true
    return false
  }

  try {
    const result = await agent.generate(
      [{ role: 'user', content: message }],
      {
        maxSteps: 20,
        requestContext,
        abortSignal: abortController.signal,
        // 步骤级观测：定位「LLM 返回 200 但工具从未执行」类问题。
        // 工具参数未通过 schema 校验时 execute() 不会进入（[XxxTool] 日志不出现），
        // 校验错误由框架作为 tool-result 回传给模型重试，只有这一层能看到。
        onStepFinish: (step: any) => {
          const toolResults = step?.toolResults || []
          const failedCount = toolResults.filter(isFailedToolResult).length
          if (toolResults.length > 0) {
            if (failedCount === toolResults.length) consecutiveToolFailures++
            else consecutiveToolFailures = 0
          }
          logTaskProgress('Agent', 'llm-step', {
            agentType,
            stepType: step?.stepType,
            finishReason: step?.finishReason,
            textLength: typeof step?.text === 'string' ? step.text.length : 0,
            consecutiveToolFailures,
            toolCalls: (step?.toolCalls || []).map((tc: any) => {
              const args = tc?.payload?.args ?? tc?.args ?? tc?.input ?? {}
              let argsStr = ''
              try { argsStr = JSON.stringify(args) } catch { argsStr = '[unserializable]' }
              return { name: normalizeToolName(tc), argsBytes: argsStr.length, argsPreview: argsStr.slice(0, 300) }
            }),
            toolResults: (step?.toolResults || []).map((tr: any) => {
              const isError = isFailedToolResult(tr)
              return {
                name: normalizeToolName(tr),
                isError,
                ...(isError ? { error: normalizeToolResult(tr).slice(0, 500) } : {}),
              }
            }),
          })
          if (consecutiveToolFailures >= CIRCUIT_BREAKER_LIMIT && !abortController.signal.aborted) {
            circuitBreakerTriggered = true
            logTaskError('Agent', 'circuit-breaker', {
              agentType,
              consecutiveToolFailures,
              lastErrors: (step?.toolResults || [])
                .filter(isFailedToolResult)
                .map((tr: any) => ({ name: normalizeToolName(tr), error: normalizeToolResult(tr).slice(0, 300) })),
            })
            abortController.abort()
          }
        },
      },
    )

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
    logTaskSuccess('Agent', agentType, { elapsedSeconds: elapsed })

    // 收集所有 tool calls 和 results
    const toolCalls = result.toolCalls || []
    const toolResults = result.toolResults || []
    const normalizedToolCalls = toolCalls.map((tc: any) => ({
      toolName: normalizeToolName(tc),
      args: tc?.payload?.args ?? tc?.args ?? tc?.input ?? null,
    }))
    const normalizedToolResults = toolResults.map((tr: any) => ({
      toolName: normalizeToolName(tr),
      result: normalizeToolResult(tr),
    }))

    logTaskProgress('Agent', 'tool-summary', {
      agentType,
      toolCalls: normalizedToolCalls.map((tc: any) => tc.toolName),
      toolResults: normalizedToolResults.map((tr: any) => tr.toolName),
    })
    logTaskPayload('Agent', `${agentType} tool-results`, normalizedToolResults)

    return success(c, {
      type: 'done',
      text: result.text || '',
      toolCalls: normalizedToolCalls,
      toolResults: normalizedToolResults,
    })
  } catch (err: any) {
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
    if (circuitBreakerTriggered) {
      logTaskError('Agent', agentType, { elapsedSeconds: elapsed, error: 'circuit-breaker: 连续工具调用失败，已提前终止' })
      return badRequest(c, `连续 ${CIRCUIT_BREAKER_LIMIT} 次工具调用失败，任务已提前终止（已保存的部分仍有效）。建议重试或更换文本模型后重新生成`)
    }
    logTaskError('Agent', agentType, { elapsedSeconds: elapsed, error: err.message })
    console.error(err.stack || err)
    return badRequest(c, err.message || 'Agent 执行失败')
  }
})

// GET /agent/:type/debug
app.get('/:type/debug', async (c) => {
  const agentType = c.req.param('type')
  if (!validAgentTypes.includes(agentType)) return badRequest(c, '无效的 Agent 类型')
  return success(c, { agent_type: agentType, valid: true })
})

export default app
