---
name: frame-splitter
description: 单一镜头对白时间计划下的静态画面覆盖与审阅规范
---

productionPlan 是切镜、完整对白和时间的唯一共同依据。每格 shotId 对应 shots.id，offsetMs 位于该 shot 的 startMs <= offsetMs < endMs，每个子镜头至少一格。description/videoPrompt 只核对原文，不能另造时间层。无统一计划时按 visualShots 或 description 的子镜头顺序覆盖。自动数量取决于内容，不取决于段落时长。

imagePrompt、referenceManifest、人物外貌服装、场景空间光源、道具和 style 锚定视觉身份与环境。优先使用服务端 context，只为缺少补充资料调用 read_previs_context。

每格 prompt 只有主体、当前可见姿态/状态和光线氛围，不含对白、标点占位、镜头编号或动作全过程。具体写出位置、手部持物和视线。shotType/angle 单独承载景别机位，默认填 null，composition 可空。continuityConstraints 写具体共同约束，continuity 写「上一状态 → 有依据变化 → 当前状态」，首格写起始状态。

保留 existingFrames/orderedFrames 的 ID、顺序与媒体。明确的新 offsetMs 优先于旧时间，并始终服从 productionPlan。新格 id 为 null。规则回退是「规则草稿 · 待审阅」；逐格核对覆盖、可视内容和衔接并明确确认后才能应用。

只返回指定数量的 JSON frames 与 continuityConstraints；每格包含 id、shotId、title、offsetMs、prompt、shotType、angle、composition、continuity。不输出 Markdown 或解释。
