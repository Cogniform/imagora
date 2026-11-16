# 生成中占位卡退场：一个时钟，不演出

状态：生效

## 问题

画布提示词卡在 running 时，除运行按钮上的秒数外，卡里还挂着一张「渐近假进度 + 文案轮播」的占位卡
（`GenerationPending`，移植自 basketikun/infinite-canvas，MIT）。2026-11-16 维护者报：

> 回来确实恢复了状态，但是有两个计时器，下面的没问题，上面的这个计时器归零了从头开始，上面那个是不是假的？

实测确认：按钮读节点 `startedAtMs`（真实锚点，恢复后接着数）；占位卡只能从**自己挂载那一刻**算 0s
（`elapsed` 受控只是让它显示父组件给的值，父组件本身也没锚点可用），标签页切走再回来、或卡片因
`status` 变化重挂载，必然从 0 重新数。两个数字并排、对不上，且都表示同一个量。

同一处还有两笔代价：进度条每 2 秒换文案、每秒推进，是纯粹的不承载信息的动效；卡片在 running 时
插入、结束再抽走，卡片高度跟着变一次。维护者的结论是「动效也没有价值，整个卡片干净」。

## 决策

**两个项目一起删掉整张占位卡**，不做「把秒数对齐到真实锚点」的修补：

- imagora：删 `frontend/src/components/GenerationPending.tsx`、`frontend/src/generationPending.ts`
  及其单测；`CanvasNodes.tsx` 的 `PendingSeconds` 与两处挂载点一并删除；`index.css` 的
  `.generation-pending*` 规则删除。**保留 `.visually-hidden`**——它被 `modal-shell` 的对话框标题
  复用（误删会让对话框失去可访问名，UI 冒烟当场红）。
- dsh-imagora-desk：删 `src/client/canvas/generation-pending.tsx`、`src/client/lib/generationPending.ts`；
  `nodes.tsx` 去掉导入与挂载；`styles.ts` 删 `.im-pending*`。
- 「运行中」的表达收敛为两处、都在原地：状态点（琥珀/呼吸）+ 运行按钮文字（`ElapsedText`/`Elapsed`
  以 `startedAtMs` 自计时）。LOD 抽象模式下同样只有那行状态大字。

## 替代方案

- **给卡片喂真实锚点**（`GenerationPending` 接 `elapsed`，父组件按 `startedAtMs` 算）：否决。这样只是
  让两个数字看起来一致——同一张卡上同一个量写两遍本就无新信息，还多一条「两处必须同步更新」的
  维护契约；而删掉之后代码量与状态面同时变少。
- **保留卡片但去掉秒数**（只留进度条 + 文案）：否决。维护者判定动效本身没有价值；且卡片进出仍会
  改一次卡片高度。假进度唯一的用途是「看着像在动」，而按钮上的秒数已经每秒在涨，功能重复。
- **保留但只在 LOD 抽象模式显示**：否决。抽象模式的目的是「缩远了也能扫一眼全局」，那里已经有
  状态大字；再挂一条细进度条反而更碎。
- **换成真进度**：不可行。生图接口不回报百分比（排队/推理/回传三段只有头尾可观测），见
  `generationPending.ts` 原注释与 `docs/reference-survey.md`。

## 影响

- 前端用例 1072 → 1054（删掉占位卡相关的 2 个文件、18 条用例；`CanvasNodes.test.tsx` 里那组
  「占位卡」用例改写成「运行态只有一处秒数、且 `.generation-pending` 不存在」的护栏）。
- 插件侧：`smoke-client` 25 条不变；UI 冒烟 34 条不变（占位卡本来没有断言）。
- `docs/ARCHITECTURE.md` 5.4 的「生成中占位卡」条目整条删除；`frontend/README.md` 的
  `generationPending.ts` 小节、`GenerationPending.tsx` 条目与 CSS 汇总表那一行一并删除。
- `docs/reference-survey.md` 是**调研记录**（当时建议移植），保留原文不动：那是历史判断，不是当前设计。
- 恢复到上次状态的路径不受影响：重挂载后按钮立刻显示真实耗时，正是这条改动要保的东西。
