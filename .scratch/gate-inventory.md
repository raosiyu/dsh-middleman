# 闸门清点（gate inventory）

只读清点，供写 `scripts/check.mjs` 用。除了这份文件，没有改任何代码。

## 0. 口径与版本锚

**什么叫「闸门」**：某处**拒绝**了某种输入或状态——返回 `problems` 数组、抛 `MiddlemanError`、
返回 `{ok:false, code}`、或在路由层回 4xx/5xx。纯读取/容错（如 `guarded()` 把 `null` 参数
归一成 `{}`、`list()` 跳过坏文件）**不算**闸门，单独记在第 5 节。

盘点基线（`git rev-parse --short HEAD` = `82f2d65`，Node v22.23.2，`git diff HEAD -- lib/` 为空）：

| 文件 | 行数 | sha256（前 16） |
|---|---|---|
| lib/core.js | 618 | 46dc3932b96300f0 |
| lib/tools.js | 695 | 5331b2cd9b9b2945 |
| lib/routes.js | 409 | 072aa39eaf0a944f |
| lib/observer.js | 182 | 1c48d466c75da3f8 |
| lib/dispatch.js | 326 | 37646d0801ff8e07 |
| lib/ledger.js | 123 | 4b9a9b6e0fceb460 |
| lib/refusals.js | 41 | 0cb10e657541309c |
| lib/verifyscan.js | 54 | 81c49a40a73d752d |
| lib/card-model.js | 167 | ec4a1952c5f1ebca |
| lib/index.js | 331 | b078616accf04626 |
| lib/client.js | 630 | （内联副本，见第 5 节） |

**合计 105 道闸门，其中枚举型 15 道。** 另有 6 个 `problems` 家族需要按 `problems.push`
条数单独计数（见 2.3）。

> ⚠️ 清点期间 `lib/routes.js` 曾出现一次瞬时内容抖动（第 295 行一度变成 `// [实验] 临时删掉
> not-waiting 拒绝`），随后恢复到与 HEAD 逐字一致的 409 行版本。表中 `/answer` 相关行号以
> **恢复后的 HEAD 版本**为准。`scripts/check.mjs` 若对 routes.js 做行号断言，建议先
> `git show HEAD:lib/routes.js` 或断言锚点原文，别只认裸行号。

---

## 1. 总表

### 1.1 lib/core.js（36 道·纯函数，全部可用 `import` 直接复现）

| 闸门 id | file:line | 它拒绝什么 | 破坏了会出什么事 | 最小复现（lib 导出 + 入参形状） | 源码锚点 |
|---|---|---|---|---|---|
| g-risk-gap | core.js:179（`riskGaps` 173–182） | 风险某一栏不是字符串、trim 后 < `MIN_FIELD`(4)、或命中 `FILLER_WORDS` | 「无」「n/a」「tbd」被当成填好了，四栏闸门形同虚设 | `riskGaps({trigger:'none',impact:'n/a',mitigation:'',verification:'ab'})` → 四栏全进 gaps | `MIN_FIELD`、`FILLER_WORDS`、`isFiller` 归一化 `.trim().toLowerCase().replace(/[.\s]+$/,'')` |
| g-risk-empty | core.js:267 | 整本风险台账一条都没有 | 派发前没有任何风险登记 | `riskProblems([])` → `['一条风险都没登记；…']` | 字符串前缀 `一条风险都没登记` |
| g-verif-nofiles | core.js:231–235 | 验证方式写了「单测」，但 `testFiles` 是空集合 | 人以为测试不存在（其实是目录里没测试），去翻仓库找文件 | `verificationTestGap({id:'R-1',verification:'单测：core.test.mjs'}, [])` | 前缀 `一个测试文件都没扫到` |
| g-verif-missing-file | core.js:236–244 | 验证方式点名的测试文件一个都不存在 | 承诺了不存在的测试，缓解措施没人盯 | `verificationTestGap({id:'R-9',verification:'单测：nope.test.mjs'}, ['core.test.mjs'])` | 前缀 `的验证方式说要有`、`但批次所在目录里没有这条测试` |
| g-verif-unnamed | core.js:252 | 说了「单测」但没点名任何文件/主干 | 「单测：跑一遍」这种空承诺通过 | `verificationTestGap({id:'R-1',verification:'单测：不传 batchId 断言抛错'}, ['risk-r1.test.mjs'])` | 前缀 `的验证方式承诺了单测，却没说是哪条测试` |
| g-answer-blank | core.js:44–45（`isClosed`） | `answer` trim 后为空、`deferred` 为 null 的决定算「没闭合」 | 空答案被算成已定，收敛闸门放过没问完的设计 | `isClosed({answer:''})` → `false`；`isClosed({deferred:'(推迟)'})` → `true` | `decision.answer.trim() !== ''`、`deferred !== undefined && deferred !== null` |
| g-dep-self | core.js:117 | 决定依赖它自己 | 该决定永远不能定 | `dependencyProblems({decisions:[{id:'D1',dependsOn:['D1']}]})` | `依赖了它自己` |
| g-dep-missing | core.js:118 | 依赖了不存在的决定 id | 依赖永远不会满足，前沿空转 | `dependencyProblems({decisions:[{id:'D1',dependsOn:['D9']}]})` | `依赖了不存在的` |
| g-dep-cycle | core.js:125 | 决定依赖成环 | 环里互相阻塞 → 前沿永远为空 → 「前沿清空」把走不完的树当走完 | `dependencyProblems({decisions:[{id:'D1',dependsOn:['D2']},{id:'D2',dependsOn:['D1']}]})` | `决定依赖成环：`、`永远定不下来` |
| g-converge-open | core.js:294 | 整棵树还有未闭合决定（数的是 `openCount`，不是前沿） | 成环时前沿为空 → 假收敛 | `convergeProblems({decisions:[{id:'D1'}],risks:[GOOD]})` | `个决定没定：` |
| g-converge-nospec | core.js:298 | `batch.spec` 是 undefined/null | 无规格也能收敛 | `convergeProblems({decisions:[],risks:[GOOD]})` | `还没有规格（goal / nonGoals / acceptance）` |
| g-converge-goal | core.js:300 | `spec.goal` 非字符串或空 | 没有目标的规格 | `convergeProblems({decisions:[],risks:[GOOD],spec:{acceptance:['x']}})` | `规格缺目标` |
| g-converge-accept-empty | core.js:302 | `spec.acceptance` 不是数组或长度为 0 | 没有验收标准的规格被收敛 | `…spec:{goal:'g',acceptance:[]}` | `规格至少要有一条验收标准` |
| g-converge-accept-blank | core.js:307 | 有验收标准但里面是空串/空白 | 空条目也算「有验收标准」 | `…spec:{goal:'g',acceptance:['  ']}` | `条验收标准是空的：每条都要能跑出红绿` |
| g-approve-status | core.js:323 | 批次状态不是 `'converged'` | 未收敛的设计被批准 | `approveProblems({status:'grilling'}, false)` | `只有收敛后的批次才能批准，当前状态：` |
| g-approve-model | core.js:331 | `byModel !== false`（fail-closed：只认严格 false） | 模型自己批准自己的设计；传 `1`/`'true'`/`{}` 都该被拦 | `approveProblems({status:'converged'}, 1)` → 非空；`(…, false)` → `[]` | `批准不对模型开放：设计批准必须由人点按钮` |
| g-question-min | core.js:357（`MIN_ANSWERED_QUESTIONS=3` @398） | 已回答问题数 < 3 | 没盘问就派发 | `designGateProblems({questions:[],plan:undefined,risks:[]})` | `盘问没做够：至少要有 3 个已回答的问题` |
| g-plan-missing | core.js:365 | `batch.plan` 是 undefined/null | 没规划就派发 | 同上 | `还没有流程规划（plan）：` |
| g-plan-steps | core.js:368 | `plan.steps` 非字符串或空 | 规划只剩空壳 | `designGateProblems({questions:3条,plan:{steps:'',output:'o'},risks:[GOOD]})` | `流程规划缺 steps：这件事分几步` |
| g-plan-output | core.js:371 | `plan.output` 非字符串或空 | 不知道做完留下什么 | `…plan:{steps:'s',output:''}` | `流程规划缺 output：做完之后留下什么` |
| g-gate-risks-empty | core.js:380 | `batch.risks` 长度为 0 | 风险清单空着就派发 | `designGateProblems({…,risks:[]})` | `风险清单是空的：至少登记一条风险，四栏齐全` |
| g-gate-risk-gap | core.js:385 | 任一风险缺栏（复用 `riskGaps`） | 只查了 `risks.length`，四条全「无」也算合规 | `designGateProblems({…,risks:[{id:'R-1',trigger:'none'}]})` | `（四栏缺一栏就不算风险）` |
| g-dispatch-approved | core.js:437 | `batch.status !== 'approved'` | 没批准就派发 | `dispatchProblems({status:'grilling'})` | `批次还没批准，当前状态：` |
| g-dispatch-notickets | core.js:442 | `batch.tickets` 为空 | 没工单也派发 | `dispatchProblems({…,tickets:[]})` | `还没有工单` |
| g-dispatch-dupid | core.js:450,457 | 工单 id 重复 | `find` 只取第一张 → 第二张永远拿不到子会话，点哪张都跑第一张 | `dispatchProblems({…,tickets:[T,T]})`（同 id） | `工单 id 重复：`、`每张票的 id 必须唯一` |
| g-ticket-norisk | core.js:462,464 | 票既没 `riskIds` 也没 `riskFree` | 无风险工单被派发 | `dispatchProblems({…,tickets:[{…T,riskIds:[]}]})` | `没挂风险；确实无关就写 riskFree 并说明理由` |
| g-ticket-riskref | core.js:467 | `riskIds` 指向不存在的风险 | 票挂着空气风险 | 同上，`riskIds:['R-9']` | `引用了不存在的风险` |
| g-ticket-riskfree | core.js:471 | `riskFree:true` 但 `riskFreeReason` 空 | `riskFree` 成为免检后门 | `T` 改 `riskIds:[],riskFree:true,riskFreeReason:''` | `标了 riskFree 但没写理由` |
| g-ticket-blockedby | core.js:474 | `blockedBy` 指向不存在的工单 | 阻塞边悬空，永远不就绪 | `T.blockedBy=['T-9']` | `被不存在的工单阻塞：` |
| g-ticket-modelreason | core.js:477 | `modelReason` 非字符串或空 | 选型理由缺失 | `T.modelReason=''` | `没写 modelReason：模型为什么选这个` |
| g-ticket-model | core.js:481 | `ticket.model.model` 非字符串或空（`model:{}` 也算没定） | 派发时拿 `undefined` 去调 `session.selectModel` | `T.model={}` | `没定模型：得写清 model: {provider, model}` |
| g-dispatch-cycle | core.js:494 | 工单 `blockedBy` 成环 | 环里互相阻塞，谁都派不出去 | 两张票 `blockedBy` 互指 | `工单阻塞边成环：` |
| g-ready | core.js:568–574 | 非 `pending`（或 status 未定义）的票、或前置未落终态的票，不算就绪 | 跑着的票被重派 → 第二个子会话，第一个成孤儿还在计费 | `readyTickets({tickets:[{id:'T-1',status:'running',blockedBy:[]}]})` → `[]` | `TICKET_STATUS.pending` + `isTerminalStatus` |
| g-terminal | core.js:547–552 | 只有 done/partial/failed/cancelled 是终态 | waiting 被当终态 → 后继被误判「等到了」；或 partial 不算终态 → 后继永久被挡 | `isTerminalStatus('waiting')` → `false` | 4 个 `TICKET_STATUS.xxx` |
| g-waiting-human | core.js:534–536 | `ticket.status === 'waiting'` 才算在等人 | 面板与主会话看不出「现在有东西在等我」 | `waitingTickets({tickets:[{status:'waiting'},{status:'done'}]})` | `TICKET_STATUS.waiting` |
| g-probe | core.js:141–157 | 一条风险都没登记时，强制追加 `kind:'risk'` 的探测问（`id:'PROBE'`） | 盘问变成走过场，没人问「什么情况下会失败」 | `nextRound({decisions:[{id:'D1',kind:'goal',dependsOn:[]}],risks:[]},4).questions` 含 `PROBE` | `decision.kind === 'risk'`、`id: 'PROBE'`、`synthetic: true` |
| g-turnend | core.js:597–617 | 非 `completed` 的 turn/end 不许落 done | 截断（max-tokens）一律记 failed → 人开始忽略失败通知；未知 reason 落终态 | `classifyTurnEnd({kind:'max-tokens'})` → `partial` | `completed` / `max-tokens` / `interrupted` / `blocked` / `aborted` / `error` |

### 1.2 lib/tools.js（25 道·需要台账文件 + 假 faces）

通用复现骨架（照 `test/tools-gates.test.mjs` 前 30 行）：

```js
process.env.WT_HOME = mkdtempSync(join(tmpdir(), 'chk-'))   // 必须，否则写 ~/.dsh
const { buildTools } = await import('../lib/tools.js')
const { blankBatch, save } = await import('../lib/ledger.js')
const tools = buildTools({ dispatcher:{ async spawn(t){return {sessionId:'s-new',model:t.model}} },
                           testFiles: async () => ['core.test.mjs'], warn(){} })
const run = (name, args, exec) => tools.find(t => t.name === name).execute(args, exec)
```

| 闸门 id | file:line | 它拒绝什么 | 破坏了会出什么事 | 最小复现 | 源码锚点 |
|---|---|---|---|---|---|
| g-tool-batchid | tools.js:69–70（`need`） | 所有按 id 取批次的工具：`batchId` 非字符串或空 | 拿 `undefined` 去 `load` → 抛裸 TypeError | `run('design_question',{question:'q',answer:'a'})` → 抛 `invalid-request` | `'必须带 batchId'` |
| g-answer-xor | tools.js:192–196 | `risk` 与 `decisionId` 同时给 | `risk` 分支提前 return，决定被静默丢掉 | `run('design_answer',{batchId,decisionId:'D1',risk:{trigger:'a'}})` | `risk 与 decisionId 只能给一个` |
| g-risk-object | tools.js:200–202 | `risk` 不是对象（`null` 也算） | 取 `draft.trigger` 抛 TypeError | `run('design_answer',{batchId,risk:null})` | `risk 得是一个对象` |
| g-risk-incomplete | tools.js:209–211 | 风险四栏有缺（复用 `riskGaps`） | 登记时放过，派发时才发现 | `run('design_answer',{batchId,risk:{trigger:'none',impact:'n/a',mitigation:'',verification:'ab'}})` → `risk-incomplete` | `'风险缺：'`、`'。四栏是 '` |
| g-verif-register | tools.js:222–223 | 登记时承诺的单测不存在 | 先登记后补测试的路径被绕开 | `…risk:{…,verification:'单测：nope.test.mjs'}` → `verification-unbacked` | `'verification-unbacked'` |
| g-answer-mode | tools.js:229–231 | 既无 `decisionId` 也无 `risk` | 空调用静默 ok | `run('design_answer',{batchId})` | `要么带 decisionId 定一个决定，要么带 risk 登记一条风险` |
| g-decision-exists | tools.js:233–235 | `decisionId` 找不到 | 静默不落账，调用方以为定了 | `…{batchId,decisionId:'D9',answer:'x'}` | `没有这个决定：` |
| g-answer-empty | tools.js:239–241 | `answer` 非字符串或 trim 后空（且未 `deferred:true`） | 空答案落盘，`answeredQuestionCount` 才拦得住 | `…{batchId,decisionId:'D1',answer:'   '}` | `answer 不能为空；要推迟就传 deferred: true` |
| g-question-required | tools.js:281–287 | `question` 或 `answer` 非字符串/空（`requiredText`） | 原来 `String(undefined)==='undefined'` 非空 → **整道设计闸门一道就绕过** | `run('design_question',{batchId,question:'q'})` | `question 与 answer 都得给`、`盘问的账本记的是` |
| g-plan-required | tools.js:333–339 | `steps` 或 `output` 非字符串/空 | 同上，「undefined」骗过 `plan.steps` 检查 | `run('design_plan',{batchId,output:'o'})` | `steps 与 output 都得给` |
| g-goal-required | tools.js:369–372 | `goal` 非字符串/空 | 空目标规格 | `run('design_converge',{batchId,acceptance:['x']})` | `goal 得给一句话目标` |
| g-converge-blocked | tools.js:379–382 | `convergeProblems` 非空 → 不落 `converged` | 未收敛批次进入 approved | `run('design_converge',{batchId,goal:'g',acceptance:['x']})`（空树无风险） | `'converge-blocked'` |
| g-tickets-array | tools.js:413–415 | `args.tickets` 不是数组 | `args.tickets.map` 抛 TypeError | `run('design_split',{batchId,tickets:'x'})` | `tickets 必须是数组` |
| g-tickets-object | tools.js:416–418 | 数组里混 null/非对象 | 逐票取字段抛 TypeError | `…tickets:[null]` | `每张票都得是一个对象，不能有 null` |
| g-split-clobber | tools.js:428–438 | 已派出（有 `childSessionId`）的票被重新拆 | 抹掉 `childSessionId`/`dispatchedAt`/`result` → 孤儿会话还在计费 | 先落一张有 `childSessionId` 的票，再 `design_split` 同 id | `这些票已经派出去了，不能重新拆：`、`留下一个还在计费的孤儿` |
| g-split-blocked | tools.js:492–494 | `design_split` 落账后 `dispatchProblems` 非空 | 拆出不合规工单 | 空批次直接 `design_split` | `'split-blocked'` |
| g-dispatch-batch | tools.js:520–522 | `dispatch_task` 没带 `batchId`（**抛错，不是 ok:false**） | 本工具被当普通 subagent 用，绕过全部设计流程 | `run('dispatch_task',{ticketId:'T-1'})` → **reject** `batch-required` | `'batch-required'`、`没有设计批次的派发一律拒绝` |
| g-dispatch-blocked | tools.js:526–527 | 派发前 `dispatchProblems(batch, testFiles)` 非空 | 最后一道关口失守 | 未批准批次派发 | `'dispatch-blocked'` |
| g-ticket-404-tool | tools.js:529–530 | `ticketId` 不在批次里 | 派发 `undefined` → 抛 TypeError | `…{batchId,ticketId:'T-9'}` | `'ticket-missing'`、`没有这张工单：` |
| g-ticket-not-ready | tools.js:531–533 | 票不在 `readyTickets(batch)` 里 | 前置未完成的票被派发 | 票 `status:'done'` 后再派 | `'ticket-not-ready'`、`还没就绪：前置工单未完成，或它已经在跑` |
| g-confirm-channel | tools.js:584–586 | 宿主没有 `faces.confirmations.find` | `request_confirmation` 静默 ok，子会话以为人收到了 | `buildTools({warn(){},testFiles:async()=>[]})` 后调 `request_confirmation` | `'unavailable'`、`这个宿主没提供「请确认」通道` |
| g-confirm-question | tools.js:587–590 | `question` 非字符串/空 | 空问题占着 waiting，人不知道要定什么 | `…execute({question:'  '})` | `question 得写清楚要人定什么` |
| g-confirm-session | tools.js:602–605 | 拿不到 `exec.agent.session.id` | 无从反查是哪张票 | `…execute({question:'q'})`（无 exec） | `这个工具只能在子会话里调；拿不到当前会话 id` |
| g-confirm-noticket | tools.js:606–611 | `confirmations.find(sessionId)` 返回 undefined | 陌生会话改台账 | `…execute({question:'q'},{agent:{session:{id:'stranger'}}})` | `'not-a-dispatched-ticket'`、`当前会话不是中台派出来的子会话` |
| g-split-preserve | tools.js:487–489 | 重拆未派票时，只有 `done`/`failed`/`partial` 三种旧状态被保留，其余重置 `pending` | 已结算结果被抹成 pending，面板显示退回未跑 | 落一张 `status:'done'` 未派票，再 `design_split` 同 id，读回 `status` | `old?.status === 'done' \|\| old?.status === 'failed' \|\| old?.status === 'partial'` |

### 1.3 lib/observer.js（6 道·需要假 ctx 真发事件，见第 3 节）

| 闸门 id | file:line | 它拒绝什么 | 破坏了会出什么事 | 最小复现 | 源码锚点 |
|---|---|---|---|---|---|
| g-obs-turnend | observer.js:63 | 非 `turn/end` 事件直接 return | 每轮工具调用都触发结算 | 发 `{type:'turn/start'}`，票状态不变 | `event?.type !== 'turn/end'` |
| g-obs-known | observer.js:67–68 | `sessionId` 不在台账索引里 | 主会话收到无关会话的回报 | 发 `{id:'s-stranger'}` 的 turn/end | `index.get(sessionId)` → `hit === undefined` |
| g-obs-ran | observer.js:86 | `pending` / `suspended` 的票不结算 | 挂起票（人还没点执行）被标 done，主会话收到「任务完成」 | 票 `status:'suspended'` + 真发 turn/end | `ticket.status === 'pending' \|\| ticket.status === 'suspended'` |
| **g-obs-waiting** | **observer.js:96** | **`status === 'waiting'` 或 `waiting` 字段存在 → 不结算** | **「在等你」被覆盖成「已完成」，人不去答，子会话永远停住** | 票 `status:'waiting'` + `waiting:{…}`，真发一次 `{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}`，读回 `status` 仍是 `waiting`、`waiting` 字段仍在 | **`ticket.status === 'waiting' \|\| ticket.waiting !== undefined`** |
| g-obs-dedupe | observer.js:103–104 | 同一 `event.data.turn` 已回报过就不再回报 | 插件重载 → 同一件事被推 N 次 | 连发同一 turn 三次，`faces.dispatcher.run` 只被调 1 次 | `ticket.reportedTurn !== undefined && ticket.reportedTurn === turn` |
| g-obs-single | observer.js:31,35–43 | 同一 `ctx` 上再装观察器时先卸旧的（`installed` WeakMap） | 两个监听器并存 → 重复回报 | 同一 ctx 连装两次，监听器数量仍为 1 | `const installed = new WeakMap()`、`installed.get(ctx)` |

### 1.4 lib/dispatch.js（7 道·需要假 gateway）

复现骨架：`createDispatcher({ gateway: () => ({ invoke }) , peer: () => ({id:'p'}), warn(){}, stream })`。

| 闸门 id | file:line | 它拒绝什么 | 破坏了会出什么事 | 最小复现 | 源码锚点 |
|---|---|---|---|---|---|
| g-gw-missing | dispatch.js:25–28 | 部署没有可用宿主网关 | 建会话时抛裸 TypeError | `createDispatcher({peer:()=>({}),warn(){}}).spawn({title:'t'})` → reject `gateway-unavailable` | `'gateway-unavailable'` |
| g-create-failed | dispatch.js:99–104 | `session.create` 抛错 | 原始栈冒到工具层 | `invoke` 抛 `new Error('host said no')` | `'session-create-failed'`、`宿主拒绝了建会话：` |
| g-session-id | dispatch.js:105–108 | `created.sessionId` 非字符串/空 | 后续全用 `undefined` 当会话 id | `invoke` 返回 `{}` | `宿主没有返回会话 id` |
| g-model-pin | dispatch.js:128–147 | `session.selectModel` 抛错 → 先 `cancel` 再抛 | 建好的会话成孤儿，无账本记录、还在计费 | `invoke` 在 `selectModel` 时抛错；观察调用序列含 `cancel` | `'model-pin-failed'`、`已尝试取消` |
| g-selectmodel-input | dispatch.js:198–200 | `model` 为 null 或无 `model.model` | 拿 undefined 调宿主 | `.selectModel('s', null)` / `.selectModel('s', {})` | `'invalid-model'`、`必须带 model: {provider, model}` |
| g-tail-stream | dispatch.js:257–263 | 宿主没有 `faces.stream` | 回报里写「(没有文字答复)」，分不清是真没说还是没读到 | 不传 `stream` 调 `.tail('s')` | `'tail-unavailable'`、`宿主没有提供流式端点` |
| g-tail-snapshot | dispatch.js:267–271 | 首帧不是 `{type:'snapshot',records:[…]}` | 同上 | `stream` 首帧 yield `{type:'delta'}` | `宿主没有返回历史快照` |

### 1.5 lib/ledger.js（3 道·需要文件系统）

| 闸门 id | file:line | 它拒绝什么 | 破坏了会出什么事 | 最小复现 | 源码锚点 |
|---|---|---|---|---|---|
| g-batch-missing | ledger.js:70–72 | 批次文件不存在 → 抛 `batch-missing` | 路由层靠这个码映射 404；抛普通 Error 时那条分支永远走不到 | `await load('nope')` → reject `batch-missing` | `'batch-missing'`、`没有这个设计批次：` |
| g-batch-unreadable | ledger.js:76–77 | 文件存在但不是 JSON → `batch-unreadable` | 一个坏文件让面板整页 500 | 写 `designs/broken.json` = `{not json`，再 `load('broken')` | `'batch-unreadable'`、`这个设计批次读不出来：` |
| g-list-skip | ledger.js:90–97 | 坏文件与非常规文件从 `list()` 里剔除 | 一个坏文件拖垮整个批次列表 | 同上场景 `await list()` → 0 行 | `if (!name.endsWith('.json')) continue`、`catch { // 跳过 }` |

### 1.6 lib/verifyscan.js（2 道·需要文件系统）

| 闸门 id | file:line | 它拒绝什么 | 破坏了会出什么事 | 最小复现 | 源码锚点 |
|---|---|---|---|---|---|
| g-testfile | verifyscan.js:26–28 | 文件名不以 6 个后缀之一结尾就不算测试 | 认不到 `.test.ts` → 「承诺的单测」闸门整片失效 | `isTestFile('a.test.ts')` → `true`；`isTestFile('a.tsx')` → `false` | `TEST_SUFFIXES`（6 项） |
| g-testdir | verifyscan.js:39–53 | 只扫 4 个目录名、只扫一层、非文件跳过 | 测试放在别处 → 扫出空集 → 误报「一个测试文件都没扫到」 | 建 `test/a.test.mjs` 与 `tests/b.spec.ts` → 找到 2 个；`test/nested/deep.test.mjs` 不找到 | `TEST_DIRS`（4 项）、`entry.isFile()`、`if (typeof root !== 'string' \|\| root === '') return []` |

### 1.7 lib/refusals.js（1 道·枚举型）

| 闸门 id | file:line | 它拒绝什么 | 破坏了会出什么事 | 最小复现 | 源码锚点 |
|---|---|---|---|---|---|
| g-http-map | refusals.js:29–40 | 机器码 → HTTP 状态：404/400/503，其余 409 | 未映射的码一律落到 409，人分不清「找不到」和「状态不对」 | `['batch-missing','ticket-missing','invalid-request','batch-unreadable','x'].map(statusForCode)` → `[404,404,400,503,409]` | 4 个 `case` + `default` |

### 1.8 lib/routes.js（21 道·需要假 req/res）

复现骨架（照 `test/routes.test.mjs`）：`makeRoutes(faces)` 后对每个 `route.handler(fakeReq, fakeRes)`，
`fakeReq.socket.remoteAddress` 默认 `'127.0.0.1'`（**给别的值会被 403 挡在最外层**）。

| 闸门 id | file:line | 它拒绝什么（HTTP 码） | 破坏了会出什么事 | 最小复现（POST body / 条件） | 源码锚点 |
|---|---|---|---|---|---|
| g-loopback | routes.js:72–74（判据 57–59） | 非环回连接 → **403** `forbidden` | 任意网页都能改你的设计批次 | `remoteAddress:'10.0.0.5'` 请求 `/state` | `isLoopback` 的三个字面量 `'127.0.0.1'`/`'::1'`/`'::ffff:127.0.0.1'` |
| g-body-limit | routes.js:44–46 | 请求体 > `64*1024` → **400** `invalid-request` | 内存被大包撑爆 | body 里塞 70KB 字符串 | `BODY_LIMIT = 64 * 1024`、`请求体超过上限` |
| g-body-json | routes.js:49–53 | 请求体不是合法 JSON → **400** | 抛 SyntaxError 落 500 | 裸写 `{not json` | `请求体不是合法 JSON` |
| g-err-map | routes.js:78–87 | `MiddlemanError` → `statusForCode(code)`；其余 → **500** `internal` | 所有拒绝都变 500，前端拿不到机器码 | 各 route 的 reject 路径 | `isMiddlemanError(error)`、`'internal'` |
| g-approve-route | routes.js:126–129 | `status !== 'converged'` → **409** `not-converged`（`approved` 已在上方幂等回 200，见 117–125） | 未收敛被批准 | `/approve` body `{batchId}`，批次 `status:'grilling'` | `'not-converged'`、`alreadyApproved` |
| g-run-404 | routes.js:141–144 | 票不存在 → **404** `ticket-missing` | 点执行打到空气 | `/run` body `{batchId,ticketId:'T-9'}` | `'ticket-missing'` |
| g-run-notdispatched | routes.js:146–148 | 无 `childSessionId` → **409** `not-dispatched` | 没建会话就 `prompt` → 宿主报错 | 票无 `childSessionId` | `'not-dispatched'`、`还没派发，先调 dispatch_task` |
| g-run-running | routes.js:150–152 | `status === 'running'` → **409** `already-running` | 连点执行起两轮 | 票 `status:'running'` | `'already-running'`、`已经在跑了` |
| g-feedback-404 | routes.js:174–177 | 票不存在 → **404** | — | `/feedback` body 带坏 `ticketId` | `'ticket-missing'` |
| g-feedback-empty | routes.js:179–182 | `message` trim 后空 → **400** | 空意见落账 | `message:'   '` | `'意见不能为空'` |
| g-steer-failed | routes.js:197–200 | steer 抛错 → **502** `steer-failed` | 人以为说到了，其实没送到 | 票 `running` + `childSessionId`，`dispatcher.steer` 抛错 | `'steer-failed'` |
| g-retarget-404 | routes.js:231–234 | 票不存在 → **404** | — | `/retarget` 坏 `ticketId` | `'ticket-missing'` |
| g-retarget-model | routes.js:237–240 | `model` 为 null 或无 `model.model` → **400** | 空模型写回账本 | body 无 `model` | `'必须带 model: {provider, model}'` |
| g-retarget-pin | routes.js:246–251 | `selectModel` 抛错 → **502** `model-pin-failed` | 账本改了、实际没改 → 显示与实跑分叉 | 票有 `childSessionId`，`selectModel` 抛错 | `'model-pin-failed'` |
| g-answer-404 | routes.js:290–293 | 票不存在 → **404** | — | `/answer` 坏 `ticketId` | `'ticket-missing'` |
| g-answer-notwaiting | routes.js:295–299 | `status !== 'waiting'` → **409** `not-waiting` | 往没停下的会话硬塞消息 | 票 `status:'suspended'` | `'not-waiting'`、`这张票没在等人确认，当前状态：` |
| g-answer-empty | routes.js:300–304 | `answer` trim 后空 → **400** | 空答复送进子会话 | `answer:'  '` | `'回答不能为空'` |
| g-answer-nosession | routes.js:305–309 | 既无 `waiting.sessionId` 也无 `childSessionId` → **409** `no-session` | 往 undefined 发 `prompt` | 票 `waiting` 但两者皆无 | `'no-session'`、`这张票没有可送达的子会话` |
| g-answer-deliver | routes.js:316–325 | `dispatcher.run` 抛错 → **502** `deliver-failed`，**且不改状态** | 台账谎报「继续跑」而子会话没收到 | `run` 抛错；读回票仍 `waiting`、`waiting` 字段仍在 | `'deliver-failed'`、`答复没送到子会话：`；顺序锚 `run` 在 `ticket.status='running'` 之前 |
| g-cancel-404 | routes.js:346–349 | 票不存在 → **404** | — | `/cancel` 坏 `ticketId` | `'ticket-missing'` |
| g-models-soft | routes.js:373–383 | 目录拿不到 → **200** + `{ok:false,code:'catalog-unavailable'}`（**故意不是错误码**） | 面板整页报错，模型下拉不可用 | `dispatcher.modelCatalog` 抛错 | `'catalog-unavailable'`、注释「这一条永不失败」 |

### 1.9 lib/index.js（1 道·**目前是死代码**）

| 闸门 id | file:line | 它拒绝什么 | 破坏了会出什么事 | 最小复现 | 源码锚点 |
|---|---|---|---|---|---|
| g-service-missing | index.js:94 | `readService(ctx, name, true)` 时缺服务 → 抛 `service-missing` | — | **无法复现**：全仓库 12 处 `readService(` 调用**没有一处传第三个参数**（已 `grep` 确认），`required` 恒为 `false`，此分支永不执行 | `if (required) throw new MiddlemanError('service-missing'` |

### 1.10 面板层（3 道）

| 闸门 id | file:line | 它拒绝什么 | 破坏了会出什么事 | 最小复现 | 源码锚点 |
|---|---|---|---|---|---|
| g-view-missing | card-model.js:112–113 | `ticket` 为 null/undefined → `{kind:'missing'}`，卡片不渲染字段 | 卡片整张空白，看不出「没数据」还是「没渲染」 | `ticketView(null)` | `kind: 'missing'` |
| g-run-button | card-model.js:142–150 | 没有 `childSessionId` 时不给「执行」按钮，只给「等前序工单完成」 | 未派发的票显示执行按钮，点了必 409 | `ticketView({id:'T-1',title:'t'})` → `buttons[0].kind === 'wait'` | `dispatched && !running`、`kind: 'run'` / `kind: 'wait'` |
| g-client-ok | client.js:243,288,295,343,442,457,464 | `result.ok !== true` 时 `alert(error)` 并放弃更新 | 面板把失败显示成成功 | 打一次 API 拿到 `{ok:false,error:'x'}` | `if (result.ok !== true) alert(result.error ?? '操作失败')` |

---

## 2. 枚举型闸门（15 道）

**定义**：其正确性**完全由一份列表**决定——列表少一项/多一项，闸门就破，没有第二处兜底。

### 2.1 精确数量与源码扫描正则

下表每一行的正则**我都实际跑过**，数量是跑出来的，不是数的。

| # | 闸门 | 列表所在 | 精确数量 | 扫描正则（在对应文件上跑） |
|---|---|---|---|---|
| E1 | g-risk-gap / `RISK_FIELDS` | core.js:11–16 | **4** 栏：`trigger` / `impact` / `mitigation` / `verification` | `export const RISK_FIELDS = \[([\s\S]*?)\n\]` 取组 1，再 `re.findall(r"\[['\"](\w+)['\"]", group1)` |
| E2 | `FILLER_WORDS` | core.js:28–31 | **16** 条（归一化后 **15** 个不同值，`'xxx.'` 与 `'xxx'` 重复） | `const FILLER_WORDS = new Set\(\[([\s\S]*?)\]\)`，再 `re.findall(r"'([^']*)'", group1)` |
| E3 | `TICKET_STATUS` | core.js:510–527 | **8** 个键：`suspended`/`running`/`waiting`/`pending`/`done`/`partial`/`failed`/`cancelled` | `export const TICKET_STATUS = \{([\s\S]*?)\n\}`，再 `re.findall(r"^\s{2}(\w+):\s*'", group1, re.M)` |
| E4 | g-terminal / `isTerminalStatus` | core.js:547–552 | **4** 个终态：`done`/`partial`/`failed`/`cancelled`；**4** 个非终态：`waiting`/`suspended`/`pending`/`running` | `export function isTerminalStatus\(status\) \{([\s\S]*?)\n\}`，再 `re.findall(r'TICKET_STATUS\.(\w+)', group1)` → 4 |
| E5 | g-ready / `readyTickets` 判据 | core.js:568–574 | 起点 1 个字面量 `pending`（另允许 status 为 `undefined`）+ 终态集合（E4） | `export function readyTickets\(batch\) \{([\s\S]*?)\n\}`，取 `TICKET_STATUS.(\w+)` → `['pending']` |
| E6 | `answeredQuestionCount` 排除项 | core.js:415–424 | 3 条 `continue` 判据，其中 **1** 个枚举值 `fact` | `export function answeredQuestionCount\(questions\) \{([\s\S]*?)\n\}`，`re.findall(r"entry\?\.kind === '(\w+)'", g)` → `['fact']` |
| E7 | `kind` 枚举（`design_question` schema） | tools.js:264–268 | **6** 值：`goal`/`scope`/`design`/`risk`/`verify`/`fact` | `enum: \[([^\]]*)\]`（tools.js 内唯一一处） |
| E8 | g-probe / 风险探测认的 `kind` | core.js:140–144 | **1** 个字面量 `'risk'`（用于判断 picked 里有没有），探测问固定 `id:'PROBE'` | `decision\.kind === '(\w+)'` → `['risk']`；`id: 'PROBE'` |
| E9 | 单测同义词（`claimsUnitTest`） | core.js:215 | **5** 个分支：`单测`/`单元测试`/`自动化测试`/`unit\s*test`/`unittest` | `const claimsUnitTest = /([^/]+)/i\.test`，再 `.split('\|')` → 5 |
| E10 | 验证方式里认的文件后缀 | core.js:226 与 248（同一正则出现两次，必须同步） | **3** 个：`mjs`/`js`/`ts`；主干剥离正则额外认 `.test`/`.spec` | `/\[\w\./-\]\+\\\.\(\?:test\\\.\|spec\\\.\)\?\(\?:mjs\|js\|ts\)\\b/g` → 2 处命中，各含 3 个后缀 |
| E11 | `TEST_SUFFIXES` | verifyscan.js:19 | **6** 个：`.test.mjs`/`.test.js`/`.spec.mjs`/`.spec.js`/`.test.ts`/`.spec.ts` | `const TEST_SUFFIXES = \[([^\]]*)\]`，`re.findall(r"'([^']*)'", g)` |
| E12 | `TEST_DIRS` | verifyscan.js:16 | **4** 个：`test`/`tests`/`__tests__`/`spec` | `const TEST_DIRS = \[([^\]]*)\]`，同法 |
| E13 | g-http-map / `statusForCode` | refusals.js:29–40 | **4** 个具名 `case` + **1** 个 `default` | `export function statusForCode\(code\) \{([\s\S]*?)\n\}`，再 `re.findall(r"case '([\w-]+)'", g)` → 4 |
| E14 | g-turnend / `classifyTurnEnd` | core.js:597–617 | **6** 个显式 `kind` + **1** 个兜底 = **7** 条出口：`completed`→done；`max-tokens`/`interrupted`→partial；`blocked`/`aborted`/`error`→failed；其余→failed | `export function classifyTurnEnd\(reason\) \{([\s\S]*?)\n\}`，`re.findall(r"kind === '([\w-]+)'", g)` → 6 |
| E15 | g-split-preserve / `design_split` 保留状态 | tools.js:487–489 | **3** 个：`done`/`failed`/`partial` | `old\?\.status === '(\w+)'` → `['done','failed','partial']` |
| （16） | `TONE`（面板配色，非拒绝型，仅作枚举一致性参考） | card-model.js:14–26 | **11** 个键 | `export const TONE = \{([\s\S]*?)\n\}`，`re.findall(r"^\s{2}(\w+):", g, re.M)` → 11 |

> 说明：上表 15 行是**拒绝型**枚举闸门；第 16 行 `TONE` 不是闸门（它只决定颜色），列在这里
> 是因为 `client.js` 里有一份逐字内联副本，两份漂移由 `test/client-bundle.test.mjs` 守住——
> 若 `check.mjs` 要断言「枚举一致」，`TONE` 的 11 个键应当一并纳入。

### 2.2 枚举型闸门的两个已知陷阱

1. **E10 的正则出现两次**（core.js:226 与 core.js:248）。只改一处 → 「写全名」与「只写主干」
   两条分支认的后缀不同，`core.test.ts` 在一条分支被认、另一条不认。扫描时必须断言命中 **2 处**。
2. **E2 有 1 条死项**：`'xxx.'` 在 `isFiller` 里先被 `.replace(/[.\s]+$/, '')` 归一成 `'xxx'`，
   与已有的 `'xxx'` 完全重复。所以「16 条」里只有 15 条有效。断言应该写
   `原始条数 === 16` **且** `归一化后去重 === 15`，否则把死项删掉会被判成「闸门破了」。

### 2.3 `problems.push` 家族计数（6 个函数，共 33 条）

| 函数 | file:line（函数起止） | `problems.push` 条数 | 其中「转调」条数 | 独有问题条数 |
|---|---|---|---|---|
| `dependencyProblems` | core.js:111–128 | **3** | 0 | 3（117 自己 / 118 不存在 / 125 成环） |
| `riskProblems` | core.js:263–279 | **3** | 0 | 3（267 空台账 / 272 缺栏 / 275 单测承诺） |
| `convergeProblems` | core.js:282–314 | **7** | **2**（311 转 `riskProblems`、312 转 `dependencyProblems`） | **5**（294 / 298 / 300 / 302 / 307） |
| `approveProblems` | core.js:321–335 | **2** | 0 | 2（324 状态 / 332 模型） |
| `designGateProblems` | core.js:354–390 | **6** | 0 | 6（358 问题数 / 365 plan / 368 steps / 371 output / 380 风险空 / 385 缺栏） |
| `dispatchProblems` | core.js:434–496 | **12** | **2**（439 转 `designGateProblems`、490 转 `verificationTestGap`） | **10**（437 / 442 / 457 / 464 / 467 / 471 / 474 / 477 / 482 / 494） |

扫描写法（按花括号配对切函数体，再数 `problems.push(`）：

```js
function pushesPerFn(src, fnName) {
  const start = src.indexOf('export function ' + fnName)
  let i = src.indexOf('{', src.indexOf(')', start)), depth = 0, end = i
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break } }
  }
  return (src.slice(start, end).match(/problems\.push\(/g) ?? []).length
}
// dependency 3 / risk 3 / converge 7 / approve 2 / designGate 6 / dispatch 12
```

**为什么「独有条数」也要报**：`convergeProblems` 看起来 7 条，实际新增判据只有 5 条——311/312
只是把子函数接上来。若只数 `push`，删掉 311 会让「风险为空」这道闸门在 `design_converge`
路径上整个消失，而 `push` 计数只从 7 变 6，看着不明显。同理 `dispatchProblems` 的 439：
删掉它，`dispatch_task` 就不再复用设计闸门——**「至少 3 个已回答问题」这条硬规则在派发路径上
就没了**，但 12 只变 11。

---

## 3. 观察器（lib/observer.js）里的「在等人」闸

### 3.1 精确位置与判据原文

**`lib/observer.js:96`**

```js
      if (ticket.status === 'waiting' || ticket.waiting !== undefined) return
```

所在上下文（core.js 里对应的状态判定是 `isWaitingForHuman`，core.js:534–536）：

- 订阅入口：`observer.js:62` `ctx.on('session/event', …)`；只认 `observer.js:63` `event?.type === 'turn/end'`。
- 台账命中：`observer.js:67–68`（`index.get(sessionId)` 为 `undefined` 就返回）。
- 前置闸：`observer.js:86` `if (ticket.status === 'pending' || ticket.status === 'suspended') return`。
- **本闸**：`observer.js:96`。
- 去重闸：`observer.js:103–104`。
- 结算落点：`observer.js:118` `ticket.status = verdict.status`、`observer.js:120` `ticket.reportedTurn = turn`。

判据是**或**关系，两个条件任一成立就返回：

1. `ticket.status === 'waiting'` —— 正常路径（`request_confirmation` 在 tools.js:627 置 `status='waiting'`）。
2. `ticket.waiting !== undefined` —— **真机事故路径**：`waiting` 字段写进去了，但 `status` 被别处
   改成了别的值。源码注释原文（observer.js:94–95）：
   > 真机撞到过：waiting 字段写进去了，但 status 是 done。所以这里先看
   > waiting 字段——它才是「它在等我」的真凭据，比 status 更靠得住。

**所以只断言第一个条件是不够的。** 简化成 `if (ticket.status === 'waiting') return` 时，
按 status 面板显示正常，事故形状（status 漂了但 waiting 字段在）会重新出现。

### 3.2 必须跑真事件，不能只做源码文本断言

`test/confirmation.test.mjs:305–352` 已经写明这一点：只看源码里有没有某个字符串挡不住
「写了但顺序不对」。`check.mjs` 里这道闸应当**行为化**：

```js
process.env.WT_HOME = mkdtempSync(join(tmpdir(), 'chk-obs-'))
const { installObserver } = await import('../lib/observer.js')
const { blankBatch, save, load } = await import('../lib/ledger.js')

const b = blankBatch('probe'); b.parentSessionId = 's-parent'
b.tickets = [{ id:'T-1', status:'waiting', childSessionId:'s-child',
               waiting:{ question:'A 还是 B？', options:['A','B'], sessionId:'s-child' } }]
await save(b)

let handler
installObserver({ on: (_n, fn) => { handler = fn; return () => {} } },
                { dispatcher:{ async tail(){return []}, async run(){} }, warn(){} })

await handler({ id:'s-child' }, { type:'turn/end', data:{ turn:1, reason:{ kind:'completed' } } })
await new Promise(r => setTimeout(r, 200))     // 观察器里是 await，必须等一拍

const after = (await load(b.id)).tickets[0]
// 破 = status !== 'waiting' 或 waiting 字段被清了
```

**必须同时带一张对照票**（`status:'running'` + 独立的 `childSessionId`）：若观察器整体坏掉，
对照票不会结算，而「等着票没变」会被误读成「闸门拦住了」——探针就变成永远绿。
`scripts/gates/observer.mjs` 已经按这个思路写过（未跟踪文件，可参考）。

> ⚠️ **两个坑，我在实测里都踩到了**：
> 1. **`childSessionId` 必须全局唯一**。`observer.js:46–56` 的索引是跨**所有批次**重建的
>    （`childSessionId → {batchId, ticketId}`），同一个 sessionId 出现在两个探针批次里，
>    后读到的会覆盖前一个。我第一次写探针时复用了 `'s-child'`，导致对照组全绿而实际没结算。
> 2. **同一 `${WT_HOME}` 下要逐条换 sessionId，或每条探针换一个临时 home**。
>    否则第二轮探针拿到的 `batch` 可能不是你刚 seed 的那份。

---

## 4. 面板 / 路由层里靠 HTTP 状态码或字段拒绝的地方

### 4.1 完整状态码清单（共 20 个 `refuse()` 调用点 + 2 个软失败）

| 状态码 | 机器码 | 出现次数 | 出现位置 |
|---|---|---|---|
| **403** | `forbidden` | 1 | routes.js:73（环回围栏，最外层） |
| **400** | `invalid-request` | 5 | routes.js:45（体超限，抛错→经 80 映射）、52（非法 JSON）、181（空意见）、238（缺 model）、302（空回答） |
| **404** | `ticket-missing` | 5 | routes.js:143、176、233、292、348 |
| **404** | `batch-missing` | （经 80 映射） | 5 个端点里 `await load(...)` 抛出时由 `statusForCode` 映射 |
| **409** | `not-converged` | 1 | routes.js:127 |
| **409** | `not-dispatched` | 1 | routes.js:147 |
| **409** | `already-running` | 1 | routes.js:151 |
| **409** | `not-waiting` | 1 | routes.js:296 |
| **409** | `no-session` | 1 | routes.js:307 |
| **502** | `steer-failed` | 1 | routes.js:199 |
| **502** | `model-pin-failed` | 1 | routes.js:249 |
| **502** | `deliver-failed` | 1 | routes.js:322 |
| **500** | `internal` | 1 | routes.js:86（非 `MiddlemanError` 兜底） |
| **200**+`ok:false` | `catalog-unavailable` | 1 | routes.js:377（**故意不失败**，面板退化） |
| **200**+`deliveredTo:'nowhere'` | — | 1 | routes.js:216–221（意见哪儿也没送到，但仍是 200） |

**注意最后两行**：它们是「用 200 包着失败」。`check.mjs` 若按「非 2xx 才是拒绝」来扫会漏掉；
必须按 `{ok:false}` 或 `deliveredTo:'nowhere'` 这个字段来判。

### 4.2 靠字段而非状态码的拒绝

| 位置 | 判据 | 拒绝什么 |
|---|---|---|
| routes.js:117–125 | `batch.status === 'approved'` | **不拒绝**——幂等回 `alreadyApproved:true`。这是唯一一处「本该拒但不拒」的有意设计，别当成漏洞 |
| routes.js:191 | `ticket.status === 'running' && typeof childSessionId === 'string'` | 决定意见送子会话（steer）还是主会话 |
| routes.js:204 | `typeof batch.parentSessionId === 'string'` | 没有主会话 → 回 `deliveredTo:'nowhere'` |
| routes.js:243 | `typeof ticket.childSessionId === 'string'` | 有子会话才 `selectModel`，否则只改账本 |
| routes.js:96 | `id === null \|\| id === ''` | `/state` 无 batchId → 回列表 |
| client.js:243/295/464 | `result.ok !== true` | 面板放弃更新并 `alert` |

### 4.3 一条**路由层与规则层的口径分歧**（不是闸门，但是陷阱）

`routes.js:102` 在 `/state` 列表里这样算未闭合决定数：

```js
open: (row.decisions ?? []).filter((d) => d.answer === undefined && d.deferred === undefined).length,
```

而闸门用的是 `openCount()` → `isClosed()`（core.js:44–45），后者先 `trim()` 再判空。
两者对同一份数据可以给出**不同**的答案：

```js
const d = [{id:'D1',answer:''},{id:'D2',answer:'x'},{id:'D3',deferred:null},{id:'D4'}]
openCount({decisions:d})   // 3
// routes.js:102 口径             // 1
```

后果：面板列表显示「还剩 1 个」，`design_converge` 却说「还有 3 个决定没定」。
`check.mjs` 若要断言「面板数与闸门数一致」，这条会**先红**——它确实不一致。建议先记录，
再看是否要修（本次任务只读，未改）。

---

## 5. 容易漏的：没法用纯函数复现的闸门

### 5.1 分类

| 类别 | 涉及闸门 | 为什么不能纯函数复现 | 替代验证办法 |
|---|---|---|---|
| **要台账文件系统** | tools.js 全部 25 道、`ledger` 3 道 | `buildTools` 的每个 `execute` 都 `await load(id)` / `save(batch)`；`WT_HOME` 决定落盘位置 | 临时 `WT_HOME`（`mkdtempSync`）+ `blankBatch`/`save`/`load` 往返。**必须**在 `import` 之后立即设 `process.env.WT_HOME`，且每条探针用独立 id |
| **要宿主 `ctx`** | observer 6 道、`index.js` 全部 | `ctx.on(...)`、`ctx.effect(...)`、`ctx.tools.register`，宿主不提供就没有事件 | 假 ctx：`{ on:(_n,fn)=>{…; return ()=>{} } }`（见 `test/observer.test.mjs` 的 `fakeCtx`）。`ctx.effect` 要**立即执行回调**并登记卸载，否则会漏掉「注册根本没发生」 |
| **要宿主 gateway** | dispatch 7 道 | `session.create/rename/selectModel/prompt/cancel/follow` 全是网关调用 | 假 gateway：`{ gateway: () => ({ invoke }) }`，`invoke` 按 `method` 分支抛错或返回。`stream` 单列（`faces.stream`，不是 `invoke`） |
| **要假 req/res** | routes 21 道 | 直接读 `req.socket.remoteAddress`、`for await (const chunk of req)`、`res.writeHead/end` | 假 req/res（见 `test/routes.test.mjs`）：`req` 要实现 `async *[Symbol.asyncIterator]`，`res` 收 `writeHead(status)` + `end(text)` 后 `JSON.parse` |
| **纯源码文本** | g-service-missing（死代码，无法行为复现）；`routes.js` 的 `/answer` **顺序**判据 | 行为测不出来：`run` 抛错时函数在赋值前就 return，不调 `save()`，磁盘状态不变，行为断言照样绿 | 源码结构断言：`source.split("/answer'")[1]` 后比较 `indexOf('faces.dispatcher.run(')` < `indexOf("ticket.status = 'running'")`（`test/confirmation.test.mjs:285–307` 已这么做） |
| **浏览器内联副本** | `lib/client.js` 里那份 `cardModel` | 浏览器侧无构建步骤，`client.js` 里是 `lib/card-model.js` 的**逐字副本**，不能 import | 文本比对：把 `card-model.js` 去掉 `export` 关键字后，与 `client.js` 里 `const cardModel = (() => {` 到 `return { … }` 之间的内容逐字比较（`test/client-bundle.test.mjs` 已这么做） |

### 5.2 特别注意：这些「闸门」其实不是闸门，但很容易被写进清单

| 位置 | 实际行为 | 为什么不是闸门 |
|---|---|---|
| `tools.js:85–91` `guarded()` | `args` 为 null/数组/非对象时归一成 `{}` | 它**不拒绝**，只是防止 `args.batchId` 抛 TypeError；真正的拒绝在下游各工具里 |
| `ledger.js:82–99` `list()` | 坏文件跳过、非 `.json` 跳过 | 容错，不是拒绝（已在 `g-list-skip` 里作为「剔除」记录） |
| `observer.js:107–114` tail 读失败 | `tailError` 记进 result，**不中断**回报 | 有意的降级：读不到正文也要回报，并在正文里说明「读不到」 |
| `tools.js:481–483` | `model:{}` 算「没定模型」 | 是 `dispatchProblems` 的一条 push（g-ticket-model），不是独立函数 |
| `core.js:159` `asked` 计数 | 排除 `synthetic:true` 的探测问 | 计数口径，不拒绝任何东西（但 `remaining` 用它，值得单独断言） |
| `routes.js:117–125` | `approved` 再点回 200 | 幂等，有意不拒绝 |

### 5.3 `nextRound` 的边界（容易写错探针）

实测结果（`check.mjs` 若要覆盖 g-probe，请照这张表写）：

| 入参 | 输出 `questions` 的 id | 备注 |
|---|---|---|
| 空树 + `size=4` | `['PROBE']` | 探测问在没有前沿时也会合成 |
| 空树 + `size=0` | `[]` | `limit>0` 才合成探测问 |
| 空树 + `size=-1` / `2.5` | `[]` | 非正整数视为 0 |
| 全闭合 + 无风险 + `size=4` | `['PROBE']` | 探测问只看 `risks.length`，不看前沿是否为空 |
| 前沿有 `kind:'risk'` 但 `size=1` 只装得下第一张 | `['D1']`（**没有 D5**） | `nextRound` core.js:145–148：`picked.length < limit` 才补，`size=1` 时补不进 → 风险探测**被 size 挤掉** |
| 有 1 条风险 + `size=4` | 不含 `PROBE` | `risks.length > 0` 就不再追问 |

最后一行第二列那个「`size=1` 时风险探测被挤掉」是**真实的行为缺口**，
不是探针写错——如果 `check.mjs` 要断言「每轮必带一个风险探测」，`size=1` 这个用例会红。

---

## 6. 数量汇总

| 文件 | 闸门数 | 其中枚举型 |
|---|---|---|
| lib/core.js | 36 | 9（E1–E6、E8、E14 及 `MIN_ANSWERED_QUESTIONS` 阈值） |
| lib/tools.js | 25 | 2（E7、E15） |
| lib/observer.js | 6 | 0（状态名硬编码，非列表驱动） |
| lib/dispatch.js | 7 | 0 |
| lib/ledger.js | 3 | 0 |
| lib/verifyscan.js | 2 | 2（E11、E12） |
| lib/refusals.js | 1 | 1（E13） |
| lib/routes.js | 21 | 0 |
| lib/index.js | 1 | 0 |
| lib/card-model.js + client.js | 3 | 0 |
| **合计** | **105** | **15** |

另附（不计入 105）：6 个 `problems` 家族，共 **33** 条 `problems.push`
（dependency 3 / risk 3 / converge 7 / approve 2 / designGate 6 / dispatch 12），
其中 4 条是转调、29 条是独立判据。
