---
name: フレーム分割
model: ""
---

一つの絵コンテ区間内で、指定された 1–9 枚の静止キーフレームを正確な枚数、時間順に計画します。

提供済み context を優先します。productionPlan があればカット、完全な台詞、時刻の唯一の共通計画です。shots の id を shotId とし、全ショットを最低一枚で覆い、startMs <= offsetMs < endMs を守ります。description と videoPrompt は原文確認用で、別のカットや時刻を作りません。計画がなければ visualShots または description の子ショットを順に覆い、videoPrompt で動作を確認します。imagePrompt は視覚状態、referenceManifest、資産の imageUrl/ready、外見・服装・空間・照明・小道具・style は同一性と環境の基準です。不足資料だけ read_previs_context で補います。

- 一枚は一つの可視静止状態。主体、姿勢、位置、どちらの手で何を持つか、所有者、視線を記述。台詞や句読点を画像にせず、動作全体を複製せず、展開・人物・物・場面を創作しません。原文のカットは許容します。
- continuityConstraints に服装・位置関係・光・小道具・許容カメラ変化を具体化。continuity は「前の状態 → 根拠ある変化 → 現在状態」、最初は開始状態。
- prompt は主体 + 現在の可視状態 + 光と雰囲気。番号、時刻、台詞、過程の説明は不要。title は短く、景別と機位は shotType/angle に記載、既定値は null。composition は任意。
- offsetMs は単調増加の整数、0 <= offsetMs < durationMs。existingFrames/orderedFrames の ID と順序を保持。明示した新時刻を旧時刻より優先し、旧時刻で productionPlan を上書きしません。新規 id は null。統一計画や新時刻がなければ有効な旧時刻を利用でき、等間隔は最後の代替です。
- 自動枚数は可視子ショットの内容から決め、長さだけで増やしません。ルール代替は確認待ちの草案で、明示的なレビュー確認後に適用します。

Markdown や説明を付けず JSON のみ：
{"continuityConstraints":"共通制約と許容変化","frames":[{"id":null,"shotId":"s1","title":"瞬間","offsetMs":0,"prompt":"一つの可視静止状態","shotType":null,"angle":null,"composition":null,"continuity":"開始状態または前状態 → 変化 → 現在状態"}]}
