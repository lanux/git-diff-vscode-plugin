# 1:1 复刻 IntelliJ 三路合并 — 剩余工作清单

> 参考：`E:/sources/github/intellij-community/byline.md`、`design.md`
> 本文只保留剩余差异、最近落地结果、下一步切片。已完成且已验证对齐的历史过程已删除。
> 最近一次比对：2026-05-09。

## 当前已对齐基线

- **ByLine 算法链路完整**：[src/diff/byline/](src/diff/byline/) 已落齐 `policy / line / enumerator / reindexer / myersLcs / patienceLcs / uniqueLcs / smartCorrector / lineChunkOptimizer / correctSecondStep / mergeUtil / iterable / trimUtil / bitSet`。二路 `compareLines` 与三路 `mergeLines3` 入口在 [src/diff/byline.ts](src/diff/byline.ts) 中按 `byline.md §1` 的 `compareSmart → optimizeLineChunks → correctChangesSecondStep / expandRanges` 流水线编排，三路对比 BASE 都放在第一参数（[src/diff/byline.ts:138-145](src/diff/byline.ts#L138-L145)）。
- **LCS 默认 Myers + Patience fallback**：与 `byline.md §3.2` 一致，patience 仅在 Myers 抛 FilesTooBigForDiff 时兜底。
- **ByLineRt 5 阶段**：`compareSmart`、`SmartLineChangeCorrector`、`LineChunkOptimizer`、`correctChangesSecondStep`、`expandRanges` 全部就位。
- **`MergeConflictType` 分类**：[src/diff/mergeConflictType.ts](src/diff/mergeConflictType.ts) 对照 `MergeRangeUtil.getLineMergeType` 翻译，包含 `unchangedLeft && unchangedRight` 时的 trueEquality 二次判定。
- **三路 merge adapter**：[src/diff/threeWayByLine.ts](src/diff/threeWayByLine.ts) 用 `mergeLines` 输出 `MergeRange[]`，按 IDEA 的"per-change auto hunk"原则保留每段 INSERTED/DELETED/MODIFIED 而不折叠成复合 hunk；并初始化 `resolvedLines = BASE`、保留 `autoResolvedLines / conflictType / autoResolvedLines / ignored / isImportChange / semanticResolutionAvailable`（[src/diff/threeWayByLine.ts:115-128](src/diff/threeWayByLine.ts#L115-L128)）。
- **`tryResolveConflict`**：[src/diff/conflictResolve.ts](src/diff/conflictResolve.ts) 实现 `MergeResolveUtil.tryResolve` 的 token-LCS + 不相交 base 编辑判定，与 `byline.md §4.3` 一致。
- **Apply / Ignore / Apply Both 状态机**：[src/webview/views/mergeView.ts](src/webview/views/mergeView.ts) 的 `handleConflictClick` 完全按 `design.md §7.4-§7.6` 的 5 步流程：第一次 apply 设 `isOnesideAppliedConflict=true`，第二次 apply 走 append，Ctrl+Click 走 resolveChange=true，对侧空 fragment 自动整段 resolved。
- **Magic Resolve gutter**：BASE 列只在 `resolutionStrategy==='TEXT' && !isChangeRangeModified` 时显示魔术棒（[src/webview/views/mergeView.ts:142-151](src/webview/views/mergeView.ts#L142-L151)），与 `design.md §8` / 行内 createResolveRenderer 对齐。
- **MergeModelBase result 侧第一版**：[src/webview/views/mergeLineTracker.ts](src/webview/views/mergeLineTracker.ts) 用 Monaco TrackedRangeStickiness 维护每段 hunk 的 `[startLine, endLine)`；apply / ignore / magic 改成 `replaceLines` 局部替换；手工编辑通过 `applyContentChanges` 实时反推 `resolvedLines / userEdited`。
- **Undo / Redo 状态机**：[src/webview/views/mergeUndoStack.ts](src/webview/views/mergeUndoStack.ts) 与 `executeMergeCommand` 已经把 `resolvedLines / status / resolved / isOnesideAppliedConflict / userEdited / isResolvedWithAI / lastAppliedSnapshot / autoResolvedLines / ignored / isImportChange / semanticResolutionAvailable` 一起纳入快照，Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z 可恢复。
- **右键菜单**：[src/webview/views/mergeView.ts:762-838](src/webview/views/mergeView.ts#L762-L838) 在 LEFT/RIGHT/RESULT 三侧分别注册 Apply Local Change / Ignore Local Change / Apply Remote Change / Ignore Remote Change / Magic Resolve Change / Reset Change to Base，对齐 `design.md §9`。
- **AcceptRevision 整文件**：webview 已支持底部 Accept Left/Right Revision 与 dirty 检查（[src/webview/views/mergeView.ts:1052-1059](src/webview/views/mergeView.ts#L1052-L1059)）。
- **IW ignored**：whitespace-equivalent `MergeRange` 标 `ignored` auto hunk，默认 `autoResolvedLines = baseSeg`，UI 用低强调样式。

## 剩余不一致项

### P0 ─ 模型/命令统一

1. **`MergeModelBase` 仅覆盖 BASE，LEFT/RIGHT 仍是整篇 `setValue` 重建**（`design.md §3.4 / §13.3`）。每次 `refreshMergeLayout` 都把 LEFT/RIGHT 编辑器整篇 setValue（[src/webview/views/mergeView.ts:646-647](src/webview/views/mergeView.ts#L646-L647)），导致：
   - LEFT/RIGHT 上的 cursor / selection / scroll 复位；
   - 无法支持 `ApplySelectedChangesAction` 这类基于 LEFT/RIGHT 选区的右键动作（`design.md §9`）；
   - `MergeLineTracker` 的 LEFT/RIGHT 等价物缺失，未来 inner diff / 高亮要按真实 fragment 范围更新会受限。
   - 需要为 LEFT/RIGHT 也建 tracker，并把 `buildAlignedThree` 拆成"初始构建"+"局部替换"两阶段。
2. **`appendChange` / `replaceChange` 没有抽成统一命令**（`design.md §13.3`）。当前 Apply / Apply Both / Magic / Reset / Ignore 都直接改 `hunk.resolvedLines / status / resolved / isOnesideAppliedConflict`，并通过 `refreshMergeLayout([hunk.id])` 触发 result 局部 replace（[src/webview/views/mergeView.ts:367-413](src/webview/views/mergeView.ts#L367-L413)）。
   - IDEA 是 `MergeConflictModel.replaceChange/appendChange/markChangeResolved/ignoreChange/resolveChangeAutomatically/replaceWithNewContent/resetResolvedChange`，所有写入路径都进 `executeMergeCommand` 后再下沉到 `MergeModelBase.replaceChange/appendChange`，保证 listener / Undo / `moveChangesAfterInsertion` 一起生效。
   - 我们目前 `executeMergeCommand` 只是 webview 层 wrapper，没有 model 层；建议先抽 `MergeModel` 类，把现有所有"修改 hunk"调用收敛到 `replaceChange / appendChange / replaceWithNewContent / resetResolvedChange / markChangeResolved` 五个 API。
3. **`moveChangesAfterInsertion` 没有显式实现**（`design.md §13.4`）。当前依赖 Monaco `TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges` + `updateRangeOnModification` 在用户/程序写入时自动平移；但没有 IDEA 那种"以一个 change 为锚点，强制把相邻 changes 推到 newOutputEnd 之后"的兜底，遇到两段相邻 hunk 在同一行追加时可能错位。需要补一个显式的 sibling-fix 逻辑。
4. **`lastAppliedSnapshot` 与 tracker 双轨并存**。如 `modify.md` 上一版指出，目前 hunks 既存 `lastAppliedSnapshot`，又靠 tracker 实时同步 `resolvedLines`。建议下一步把 `lastAppliedSnapshot` 仅用于"是否被 user 编辑过"的判定（取代 `isChangeRangeModified` 比 base 的写法），其他地方一律读 tracker。

### P1 ─ Compare Contents / Reset / 其他工具栏

5. **Compare Contents 子菜单缺失**（`design.md §5.2` 第一项）。对 `Compare Contents`、`compareContents`、`partial diff`、`with-base` 全文搜索 0 命中。
   - IDEA 提供 LEFT↔BASE / BASE↔RIGHT / LEFT↔RIGHT / 每侧 vs BASE 的局部 diff 入口；当前 webview 工具栏只有 Apply Non-Conflicting / Magic / Granularity / IgnoreWS。
   - 计划：新增 `Compare Contents` 下拉，复用现有 `compareLines`/`compareLines3`，把结果以 readonly 编辑器 / vscode webview tab 弹出。
6. **`autoResolveImports` 不在 init 阶段执行**（`design.md §4.1` step 5、§12）。当前 import 块逻辑只在用户点击 Magic 时才作为兜底（[src/webview/views/mergeView.ts:559-602](src/webview/views/mergeView.ts#L559-L602)），且 `isImportChange` 永远 false。
   - 计划：在 `buildThreeWayHunksByLine` 阶段做基于行内容的 import-only 判定，写入 `hunk.isImportChange`；`initMerge` 时若开启 `autoResolveImports`（新建配置项）→ 自动把这些 hunk 调 `markChangeResolved`。
7. **`patchConflictTypes` / SEMANTIC resolver 钩子缺失**（`design.md §4.1` step 5）。
   - `ResolutionStrategy='SEMANTIC'` 在 [src/types.ts:11](src/types.ts#L11) 定义但全代码无处生成；`mergeView.resolveChangeAutomatically` 仅对 SEMANTIC 直接 return false（[src/webview/views/mergeView.ts:497](src/webview/views/mergeView.ts#L497)）。
   - 计划：抽 `LangSpecificMergeConflictResolver` 接口（即使先 stub 出语法/import 两类），让 `classifyFragment` 在拿到 resolver 时把对应 conflict 升级为 `SEMANTIC`，统一走 `replaceWithNewContent` 入口。

### P1 ─ 显示细节

8. **Inner diff 仍同步算**（`design.md §10` `MyInnerDiffWorker`）。decorateMerge 内 `wordDiff/wordTokenDiff` 同步遍历每段 conflict 的 max(local, remote) 行（[src/webview/views/mergeView.ts:160-178](src/webview/views/mergeView.ts#L160-L178)）。文件大时会卡 UI；建议改成 alarm-style：用 `requestIdleCallback` 异步算后通过 `deltaDecorations` 二次贴上。
9. **三向 inner-fragment**：当前只算 LEFT vs RIGHT 两侧 word diff，没有 IDEA 的 `compareThreesideInner`（LEFT/BASE/RIGHT 三方对齐）。在 `kind==='auto'` 且单侧改的 hunk 上，缺 BASE↔changed-side 的 word 标注。
10. **BASE 列 stripe 行为**：IDEA `withHideStripeMarkers(side == BASE)` 会**隐藏** BASE 列的概览滚动条 stripe；当前我们在 result/BASE 列**绘制** stripe（[src/webview/views/mergeView.ts:99-109](src/webview/views/mergeView.ts#L99-L109)）。需要按 IDEA 风格保留两侧 stripe、隐藏中间。
11. **Resolved 态高亮**：缺 `withResolved(true)` 对应的"描边而非填充"样式；当前只有 `hunk-resolved` 单一 class。

### P2 ─ 算法兜底/质量

12. **`buildSimple` vs `buildMerge` 的 keepIgnoredChanges**（`byline.md §5.3`）：[src/diff/byline.ts:91-102](src/diff/byline.ts#L91-L102) 已在非 DEFAULT policy 下调 `buildMerge` + trueEquality 判定，需要补回归用例：IGNORE_WHITESPACES 模式下两侧只在空白上不同的连续行，应保持单独可见的小 change，而不是和真实差异挤在一起。
13. **`MergeRangeUtil.getLineMergeType` 与 `classifyFragment` 边界用例**：当 base/local/right 全空时返回 `MODIFIED leftChange=false rightChange=false strategy=DEFAULT`，IDEA 这种空段不会被产生。需要在 adapter 层提前过滤 `start1==end1 && start2==end2 && start3==end3`，避免 fragment 空壳泄漏到 UI。
14. **legacy `node-diff3` 路径**：[src/diff/threeWay.ts](src/diff/threeWay.ts) 仍存在并被 build/test 引用一次。`byline.md` / `design.md` 只覆盖 IDEA 路径；保留它会让"哪条路径权威"持续含糊。下一步：把所有 host 端 entry（`mergePanel`/`whitespace`）切到 `buildThreeWayHunksByLine`，把 `buildThreeWayHunks` 标 deprecated 并集中删除。

## 本轮已完成（2026-05-09）

- [src/types.ts](src/types.ts) 新增 `MergeConflictType / ResolutionStrategy / autoResolvedLines / ignored / userEdited / isResolvedWithAI / isImportChange / semanticResolutionAvailable / lastAppliedSnapshot / resolved[2] / isOnesideAppliedConflict`，与 `design.md §3.3` 字段集合对齐。
- [src/diff/threeWayByLine.ts](src/diff/threeWayByLine.ts) 把 ByLine adapter 改成 per-change auto hunk + pure-BASE 初始 result + ignored auto hunk。
- [src/diff/mergeConflictType.ts](src/diff/mergeConflictType.ts)、[src/diff/conflictResolve.ts](src/diff/conflictResolve.ts) 翻译完毕。
- [src/webview/views/mergeView.ts](src/webview/views/mergeView.ts) 引入 `MergeLineTracker` + `MergeUndoStack` + `executeMergeCommand` + 右键菜单，删除 `captureResultEdits` / 全量 `rebuildMerge`。
- [src/webview/views/mergeUndoStack.ts](src/webview/views/mergeUndoStack.ts)、[src/webview/views/mergeLineTracker.ts](src/webview/views/mergeLineTracker.ts)、[src/webview/views/mergeRangeUpdate.ts](src/webview/views/mergeRangeUpdate.ts) 第一版落地。
- 验证：`npm run build`、`npm test -- --grep "buildThreeWayHunksByLine \(P1-7|ByLine pipeline integration & stability|IDEA-aligned conflict gutter arrow state machine|IDEA-aligned conflict ignore glyph state machine|magicResolve"`。

## 下一开发切片

1. **P0-1 + P0-2 一起做**：抽 `src/webview/merge/mergeModel.ts`，把所有 `hunk.resolvedLines = ...` / `hunk.resolved = ...` / `hunk.isOnesideAppliedConflict = ...` 收敛到 `replaceChange / appendChange / markChangeResolved / ignoreChange / resolveChangeAutomatically / replaceWithNewContent / resetResolvedChange` 七个 API；同时把 LEFT/RIGHT 也建 tracker，refreshMergeLayout 改成局部 replace。
2. **P0-3**：在 `MergeLineTracker.replaceLines` / `appendLines` 之后跑一次 `moveChangesAfterInsertion(index)`，保证相邻 hunk 边界。
3. **P1-5 Compare Contents 子菜单**：先做 LEFT↔BASE / BASE↔RIGHT 两个最小入口。
4. **P1-6 / P1-7**：在 adapter 层识别 `isImportChange`，并预留 `LangSpecificMergeConflictResolver` 接口；init 时按配置项 `autoResolveImports` 自动 markChangeResolved。
5. **P1-8**：`MyInnerDiffWorker` 异步化（`requestIdleCallback` + alarm）。
6. **P2-14**：把宿主端入口切到 `buildThreeWayHunksByLine`，删除 `threeWay.ts` / `node-diff3` 依赖。

## 验证命令

- `npm run build`
- `npm test -- --grep "buildThreeWayHunksByLine \(P1-7|ByLine pipeline integration & stability|IDEA-aligned conflict gutter arrow state machine|IDEA-aligned conflict ignore glyph state machine|magicResolve|IW whitespace-only ranges stay visible as ignored auto hunks|ByLine 3-way mergeLines"`
- `npm test`
