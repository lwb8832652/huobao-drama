---
name: frame-splitter
description: 分镜画面规划规范 — 一个分镜段落内的静态状态与相邻连续性
---

# 分镜画面规划

优先使用用户消息中服务端已提供的完整 context：description、videoPrompt、imagePrompt、orderedFrames/existingFrames、资产图片 imageUrl/ready 与 referenceManifest、角色身份/外貌/服装、场景空间与光照、道具描述和项目风格。只有未提供上下文或缺少补充资料时才调用 read_previs_context。description 定义事件和切镜；videoPrompt 定义动作顺序与时间；imagePrompt 锚定视觉状态；资产元数据和 referenceManifest 锚定身份、服装、场景、道具。只依据这些资料，不新增情节、人物、道具或场景。返回恰好指定数量的画面，不输出 Markdown、代码围栏或解释。

用户指定 1-9 张。一张画面只描述一个可见静态关键状态；伸手、握住、举起、喝下分别属于不同状态，不能在一格里串成连续动作。先识别开始→转折点→结束，再选恰好 N 个按时间排列的静态瞬间；N>1 包含起止锚点，N=1 取代表状态。每格明确当前姿态、位置、手部持物归属和视线，不重复整段提示词。原描述中的场景与镜头变化允许发生，不要求背景盲目相同。根据视频动作阶段取点；保留剧本允许的切镜，同一镜头连续动作可以保持相同景别和机位。

`continuityConstraints` 写全组的具体不变量：身份与服装、空间关系、光源、道具外观、允许的镜头变化。每格 `continuity` 写「上一格静态状态 → 有依据的变化 → 当前静态状态」，首格写起始状态。人物换位、换手和视线改变都需要动作依据。

`prompt` 只写「主体 + 当前可见姿态/状态 + 光线氛围」。景别、机位分别用 `shotType`、`angle`，不要在 prompt 重复；默认值填 null。`composition` 描述构图重点，无额外意图填 null。

`offsetMs` 按动作节奏递增，范围为 0 <= offsetMs < durationMs。existingFrames 的数量和时间点有效时保留 ID、顺序与非均匀时间，不改成机械等距；新增 id 填 null。缺少节奏依据才采用等距默认值。单张取代表状态，不强行分开场和结尾。

只输出 JSON，不附解释：

```json
{"continuityConstraints":"共同约束","frames":[{"id":null,"title":"关键瞬间","offsetMs":0,"prompt":"一个静态状态","shotType":null,"angle":null,"composition":null,"continuity":"起始状态或上一状态 → 变化 → 当前状态"}]}
```

规则回退方案必须标为「规则草稿」，等待用户审阅；重复分句不等于已通过连续性审查。
