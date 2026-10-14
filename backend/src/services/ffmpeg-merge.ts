/**
 * FFmpeg 多镜头拼接 — 将所有生成后的镜头视频拼接为一集
 */
import fs from 'fs'
import path from 'path'
import { v4 as uuid } from 'uuid'
import { db, getInsertId, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../utils/response.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { extractVideoPoster } from '../utils/video-poster.js'
import { ffmpeg, checkFfmpegSuite } from '../utils/ffmpeg.js'
import { DATA_ROOT, STORAGE_ROOT } from '../utils/paths.js'
import { getVersion, listVersions } from './previs.js'
import { createHash } from 'node:crypto'
import { enqueueQueueJob, getQueueJob, registerQueueExecutor, tickTaskQueue } from './task-queue.js'

function toAbsPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) return relativePath
  if (relativePath.startsWith('static/')) return path.join(DATA_ROOT, relativePath)
  return path.join(STORAGE_ROOT, relativePath)
}
async function clipDigest(url: string) {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(toAbsPath(url))) hash.update(chunk)
  return hash.digest('hex')
}

/**
 * 拼接一集的镜头视频。
 * 优先使用视频生成产物，兼容历史的 composedVideoUrl 数据。
 * 传入 storyboardIds 时只拼接所选镜头（仍按镜号顺序）。
 */
export async function mergeEpisodeVideos(episodeId: number, dramaId: number, storyboardIds?: number[]): Promise<number> {
  let storyboards = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)

  // 故事版版本存在时，优先使用其预演输出（含未 stale 的成片与未跟踪镜头回退源）
  const current = listVersions(episodeId)[0]
  if (current) {
    const version = getVersion(current.id)
    const selected = storyboardIds?.length ? new Set(storyboardIds.map(Number)) : null
    const outputs = version.outputs.filter(output => !output.stale
      && (!selected || output.panelIds.some(id => selected.has(id))))
    const claimed = new Set(outputs.flatMap(output => output.panelIds))
    const tracked = new Set(version.outputs.flatMap(output => output.panelIds))
    const clips = [
      ...outputs.map(output => ({
        order: version.timeline.panels.findIndex(p => p.id === output.panelIds[0]),
        label: output.panelIds.map(id => `S${version.timeline.panels.findIndex(p => p.id === id) + 1}`).join('/'),
        url: output.url,
      })),
      ...version.timeline.panels.filter(panel => !claimed.has(panel.id) && !tracked.has(panel.id) && (!selected || selected.has(panel.id)))
        .map(panel => {
          const order = version.timeline.panels.findIndex(item => item.id === panel.id)
          const source = storyboards.find(sb => sb.id === panel.id)
          return { order, label: `S${order + 1}`, url: source?.videoUrl || source?.composedVideoUrl || '' }
        }).filter(clip => clip.url),
    ].sort((a, b) => a.order - b.order)
    if (clips.length) return mergeClips(episodeId, dramaId, clips)
  }

  if (storyboardIds?.length) {
    const allow = new Set(storyboardIds.map(Number))
    storyboards = storyboards.filter(sb => allow.has(sb.id))
  }

  // 允许部分拼接:按镜号顺序拼接已生成的镜头,未生成的跳过
  const clips = storyboards
    .map(sb => ({ label: `S${sb.storyboardNumber}`, url: sb.videoUrl || sb.composedVideoUrl }))
    .filter(c => Boolean(c.url)) as { label: string; url: string }[]

  return mergeClips(episodeId, dramaId, clips)
}

async function mergeClips(episodeId: number, dramaId: number, clips: { label: string; url: string }[]): Promise<number> {
  if (clips.length === 0) throw new Error('所选镜头还没有可拼接的视频')

  // 拼接前探测 ffmpeg：二进制损坏时 fluent-ffmpeg 的同步 EFTYPE 会崩掉整个进程，
  // 这里提前拦截并给出可操作的修复指引（路由层会作为 400 返回前端）
  const suite = await checkFfmpegSuite()
  if (!suite.ffmpeg || !suite.ffprobe) {
    throw new Error('本机 ffmpeg 不可用，无法拼接视频（常见于 node_modules 跨平台拷贝或 ffmpeg-static 下载损坏）。请删除 node_modules 后在本机重新 npm install，或设置 FFMPEG_BIN 指向有效的 ffmpeg 可执行文件后重启服务')
  }

  // 校验视频文件真实存在:DB 里的 video_url 可能指向已被清理的文件,
  // 直接拼会得到 ffmpeg 的 "No such file or directory" 晦涩报错
  const missing = clips.filter(c => !fs.existsSync(toAbsPath(c.url)))
  if (missing.length > 0) {
    const nums = missing.map(c => c.label).join('、')
    throw new Error(`镜头 ${nums} 的视频文件已丢失（本地文件不存在），请重新生成这些镜头的视频，或在拼接时取消勾选`)
  }

  const videos = clips.map(c => c.url)
  const digests: string[] = []
  for (const video of videos) digests.push(await clipDigest(video))

  logTaskStart('MergeTask', 'episode-merge', { episodeId, dramaId, clips: videos.length })

  // 创建 merge 记录
  const ts = now()
  const mergeId = db.transaction(tx => {
    const res = tx.insert(schema.videoMerges).values({
      episodeId,
      dramaId,
      title: `Episode ${episodeId} Merge`,
      provider: 'ffmpeg',
      model: 'ffmpeg-concat-h264-aac',
      status: 'pending',
      scenes: JSON.stringify(videos),
      createdAt: ts,
    }).run()
    const mergeId = getInsertId(res)

    enqueueQueueJob({ ownerType: 'video_merge', ownerId: mergeId, kind: 'local', projectId: dramaId,
      inputHash: createHash('sha256').update(JSON.stringify({ videos, digests })).digest('hex'), snapshotJson: JSON.stringify({ videos, digests }) })
    return mergeId
  })
  void tickTaskQueue()

  return mergeId
}

registerQueueExecutor('video_merge', {
  execute: async job => {
    const row = db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, job.ownerId)).get()
    if (!row) return { status: 'failed', error: '视频拼接记录不存在' }
    try {
      const snapshot = JSON.parse(job.snapshotJson), videos = snapshot.videos || JSON.parse(row.scenes || '[]')
      if (snapshot.digests) {
        const actual = []
        for (const video of videos) actual.push(await clipDigest(video))
        if (JSON.stringify(actual) !== JSON.stringify(snapshot.digests)) throw new Error('拼接素材已变化，请重新提交')
      }
      if (getQueueJob('video_merge', row.id)?.status !== 'processing') return { status: 'failed', error: '视频拼接已取消' }
      db.update(schema.videoMerges).set({ status: 'processing', errorMsg: null }).where(eq(schema.videoMerges.id, row.id)).run()
      if (!row.episodeId) throw new Error('拼接记录缺少剧集编号')
      await doMerge(row.id, row.episodeId, videos)
      return { status: 'completed' }
    } catch (error: any) {
      logTaskError('MergeTask', 'episode-merge', { mergeId: row.id, error: error.message })
      db.update(schema.videoMerges).set({ status: 'failed', errorMsg: error.message }).where(eq(schema.videoMerges.id, row.id)).run()
      return { status: 'failed', error: error.message }
    }
  },
  onCancel: job => { db.update(schema.videoMerges).set({ status: 'cancelled', errorMsg: '已取消排队' }).where(eq(schema.videoMerges.id, job.ownerId)).run() },
  onRetry: job => { db.update(schema.videoMerges).set({ status: 'pending', errorMsg: null }).where(eq(schema.videoMerges.id, job.ownerId)).run() },
})
export async function migrateVideoMergeQueue() {
  for (const row of db.select().from(schema.videoMerges).all().filter(row => ['pending','processing'].includes(row.status || ''))) {
    if (getQueueJob('video_merge', row.id)) continue
    try {
      const videos: string[] = JSON.parse(row.scenes || '[]'), digests: string[] = []
      for (const video of videos) digests.push(await clipDigest(video))
      db.transaction(() => {
        if (getQueueJob('video_merge', row.id)) return
        db.update(schema.videoMerges).set({ status: 'pending' }).where(eq(schema.videoMerges.id, row.id)).run()
        enqueueQueueJob({ ownerType: 'video_merge', ownerId: row.id, kind: 'local', projectId: row.dramaId || undefined,
          inputHash: createHash('sha256').update(JSON.stringify({ videos, digests })).digest('hex'), snapshotJson: JSON.stringify({ videos, digests }) })
      })
    } catch (error: any) {
      db.update(schema.videoMerges).set({ status: 'failed', errorMsg: `旧拼接素材无法恢复：${error.message}` }).where(eq(schema.videoMerges.id, row.id)).run()
    }
  }
}

async function doMerge(mergeId: number, episodeId: number, videos: string[]) {
  // 生成 concat 列表文件
  const listDir = path.join(STORAGE_ROOT, 'temp')
  fs.mkdirSync(listDir, { recursive: true })
  const listPath = path.join(listDir, `${uuid()}.txt`)

  const listContent = videos
    .map(v => `file '${toAbsPath(v)}'`)
    .join('\n')
  fs.writeFileSync(listPath, listContent, 'utf-8')

  // 输出文件
  const outputDir = path.join(STORAGE_ROOT, 'merged')
  fs.mkdirSync(outputDir, { recursive: true })
  const outputFilename = `${uuid()}.mp4`
  const outputPath = path.join(outputDir, outputFilename)

  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(listPath)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions([
        '-fflags', '+genpts',
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '23',
        '-c:a', 'aac',
        '-ar', '48000',
        '-b:a', '192k',
        '-movflags', '+faststart',
      ])
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run()

  })

  // 清理临时文件
  fs.unlinkSync(listPath)

  // 获取时长
  const duration = await getVideoDuration(outputPath)

  const mergedRelative = `static/merged/${outputFilename}`

  // 成片海报帧（导出页封面用）
  await extractVideoPoster(mergedRelative)

  // 更新 merge 记录
  await db.update(schema.videoMerges)
    .set({ status: 'completed', mergedUrl: mergedRelative, duration, completedAt: now() })
    .where(eq(schema.videoMerges.id, mergeId))

  // 更新 episode
  await db.update(schema.episodes)
    .set({ videoUrl: mergedRelative, updatedAt: now() })
    .where(eq(schema.episodes.id, episodeId))

  logTaskSuccess('MergeTask', 'episode-merge', { mergeId, episodeId, output: mergedRelative, duration, clips: videos.length })
}

function getVideoDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) { resolve(0); return }
      resolve(Math.round(metadata.format.duration || 0))
    })
  })
}
