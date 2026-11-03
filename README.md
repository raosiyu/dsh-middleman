# dsh-middleman

主会话当中台：**盘问 → 收敛 → 人工批准 → 派发独立子会话（挂起等执行）→ 结果自动回传**。

一个 DeepSeek Harness（DSH）插件。它补的是现成方案缺的那一层：

| 现成能力 | 缺什么 |
|---|---|
| `subagent` 工具 | 立刻就跑，没有挂起；模型和父会话相同 |
| 小队（dsh-agents） | 能钉预设和模型，但一调就开跑 |
| 任务板 | 有 todo 列当挂起，但没有「派发前先把设计问清楚」 |

中台要的是：**派发时把会话建好、模型定好，但不发第一条消息**——等你点执行。

> **第一次用请看 [USAGE.md](USAGE.md)** —— 装、怎么触发、卡片怎么看、模型怎么选、出错了怎么办，一篇读完。
> 这份 README 讲的是它为什么这么做。

## 怎么触发

**一句话：在主会话里用自然语言说事，模型会自己走流程。**

插件在每个会话的系统提示里挂了一段说明，告诉模型这个面存在、怎么用、以及哪些动作会被拒（`lib/index.js` 的 `PROMPT_TEXT`）。所以你**不需要记任何命令名**，只要说出意图，模型会调对应的工具。

### 三个入口

| 你想做的事 | 怎么说（任选其一） | 模型会做什么 |
|---|---|---|
| 派活给子会话 | **「用中台派个子任务」**、**「开个设计批次」**、**「派发子任务」** | `design_open` → 盘问 → 收敛 → 等你批准 → 拆票 → 派发 |
| 让它盘问你 | **「盘问一下」**、**「先盘问再动手」** | `design_round` → 连续几轮问你，每轮带风险探测 |
| 只规划不派发 | **「流程规划」**、**「怎么分工」** | `design_plan` → 写下分几步、产出什么、什么能并行 |

可靠的触发词是上面加粗的那几个（中台 / 设计批次 / 派发子任务 / 盘问 / 流程规划）——它们写在系统提示段末尾，模型一定认得。

除此之外，你把需求说完整了模型也可能自己走这条路（比如「帮我设计一个插件，主会话派任务给子会话」——需求里明说了「派任务给子会话」，模型会判断该用这个面）。但**别指望**只说「设计个插件」就一定进中台——那句话太泛，模型可能直接开干。

派发相关的触发词在每条工具的描述里也各带了一份（`design_open` 写「设计批次 / 开个设计」，`design_question` 写「盘问 / 提问」，`design_plan` 写「流程规划 / 怎么分工」），所以模型从工具表也能认出该调哪条。

### 一次完整的对话长什么样

```
你：帮我设计一个插件，主会话当中台，派任务给子会话
模型：（调 design_open，开批次）先问你几个问题——
模型：① 这个插件装在哪？【推荐：DSH 插件，因为……】
模型：② 子会话独立跑还是共享上下文？【推荐：独立，因为……】
模型：③ 什么情况下这个方案会失败？（风险探测）
你：答三个问题
模型：（记 design_question ×3，定 design_answer，写 design_plan）
模型：（design_converge）设计收敛了，等你批准
    ↓  你在侧边栏「中台」里点「批准这份设计」
模型：（design_split）拆成 3 张票，各挂风险、各写 modelReason
模型：（dispatch_task）派 T-1，卡片出现在这条消息下面
    ↓  你在卡片上点「执行」
     （子会话开跑）→ 跑完 → 结果自动推回这条主会话
```

### 你在哪几个地方动手

插件一共三处需要人介入，其余全自动：

| 位置 | 做什么 |
|---|---|
| **侧边栏「中台」** | 看批次列表；收敛后点「批准这份设计」；点「执行」放行子会话 |
| **对话流里的派发卡片** | 核对这张票要发什么、用哪个模型；点「执行」；用「换个模型…」下拉改模型；点「有修改意见」（跑着时是「追加指令」，直接发给子会话） |
| **主会话对话** | 回答盘问；最后收子会话的回报 |

### 不想用自然语言的话

工具是模型面向的，不是人面向的——人直接调没有意义。但**盘问阶段你必须回答**，那部分走的是主会话的正常对话（模型会一条一条问你）。

### 只想看看长什么样，不想花钱

见下面「[手感演示](#手感演示不建会话不花钱)」——走一遍盘问、收敛、三道闸门，派发那一步只打印计划，不建会话。

## 为什么是这四道闸门

规则写在代码里，不写在提示词里。提示词会被模型合理化掉。

1. **设计**：至少 3 个已回答的问题、一份流程规划、至少一条四栏齐全的风险
2. **收敛**：设计树前沿清空、规格有验收标准、风险四栏齐全、依赖边合法
3. **批准**：只有人能点。`approve` 不在工具面上，模型没有对应工具可调
4. **派发**：批次已批准、每张票挂风险、写了 `modelReason`、阻塞边不成环

## 跟 ask-matt 技能组合怎么接

这套流程抄的是 [mattpocock/skills](https://github.com/mattpocock/skills) 里
`/grill-with-docs` → `/to-spec` → `/to-tickets` → `/implement` 那条主流程的骨架，
但**盘问逻辑内建在插件里**，不外包给技能。

原因：`ask-matt`、`grill-with-docs`、`to-spec`、`to-tickets` 这些技能都带
`disable-model-invocation: true`，模型调不动它们。只有 `grilling` 是模型可调的。
所以插件自己实现了那套盘问纪律：

| 纪律 | 实现 |
|---|---|
| 事实是你的活 | 提示段明确写「能自己查的就去查，别问用户」 |
| 决定是用户的活 | 每个问题必须带推荐答案和理由 |
| 前沿才能问 | `design_round` 只放前置条件已满足的决定 |
| 每轮带风险探测 | 代码保证：没登记过风险就自动追加一问 |
| 风险要有验证方式 | 四栏缺一栏拒绝，「无」「n/a」不算 |

技能组合仍然可以叠加用：主会话想走 `/grill-with-docs` 就自己调用，插件的
账本照样记；不想走技能，插件自己也够用。

## 流程

```
design_open      开一个设计批次（盘问阶段的容器）
design_round     取下一轮要问的问题；代码保证只要还没登记风险就带一个风险探测
design_question  记一个问过用户的问题和答案（派发前至少 3 个）
design_answer    定一个决定，或登记一条风险（四栏缺一栏就拒绝）
design_plan      写下流程规划：分几步、每步产出什么、什么能并行
design_converge  收敛成规格
   ↓  人在中台面板点「批准」
design_split     拆成工单，每张挂风险、写 modelReason
dispatch_task    建会话 + 定模型 + 挂起（不发第一条消息）
   ↓  人在中台面板点「执行」
（子会话开跑）→ turn/end → 结果自动推回主会话
```

## 四条风险，已绑在代码上

| ID | 触发 | 缓解 | 验证 |
|---|---|---|---|
| R-1 | 主会话把 `dispatch_task` 当普通 subagent 用，跳过盘问 | 没有 `batchId` 一律拒绝 | `risk-r1.test.mjs` 断言抛错**且**一个子会话都没建 |
| R-2 | 子会话撞 `max-tokens` 或被中断，却被当成失败 | 按 reason 分类，记 `partial` 并标截断位置 | `core.test.mjs` 断言 status |
| R-3 | 派发前根本没问清楚 | 至少 3 个已回答问题 + 流程规划 + 一条风险，缺一不可 | `core.test.mjs` 断言 designGateProblems |
| R-4 | 风险的「验证方式」写的是空话——承诺的单测根本不存在 | 验证方式里写了「单测」就必须指名那条测试文件，登记与派发时各查一次 | `verification-gate.test.mjs` 断言拦住没兑现的承诺 |

R-2 的理由：长任务被截断很常见。一律标失败，你会开始忽略失败通知。

R-4 的理由：风险登记由模型自己写，「验证方式」也是模型自己写——没人核，就只是一句话。于是承诺了 `单测：xxx.test.mjs`，仓库里却根本没有 `xxx.test.mjs`。这条闸门在**登记**和**派发**两处各查一次：登记时拦住空话，派发时再拦一次（防止绕过登记直接派）。写不成单测的验证方式可以写「人工核对：…」，那是允许的。

## 安装

### 一键安装（推荐）

```sh
curl -fsSL https://raw.githubusercontent.com/raosiyu/dsh-middleman/main/install.sh | sh
```

脚本做三件事：把包 `pnpm add` 进 profile 的 node_modules、把 bundle 名挂进
profile 的 `dsh.profile.bundles`、跑一遍测试自检。全自动，不用回应用里点。

装完**完全退出 DSH 再打开**（不是关窗口），侧边栏会多一行「中台」。

> 为什么不直接用 `dsh plugin --profile desktop add`：桌面版的 profile 由
> Electron 应用独占，CLI 里有硬检查会拒绝：
> `error: profile "desktop" is managed exclusively by the Electron application`。
> 脚本绕开这条检查，自己做插件管理器做的同一件事。

常用参数：

```sh
./install.sh --profile web      # 装到别的 profile
./install.sh --dry-run          # 只打印会发生什么
./install.sh --uninstall        # 卸掉
```

### 应用内安装（手动版）

1. 打开 DeepSeek Harness
2. 侧边栏 → **插件** → **安装**
3. 粘贴仓库地址或本地路径：

```
https://github.com/raosiyu/dsh-middleman
```

4. **完全退出应用，再打开**

### 从源码

```sh
git clone https://github.com/raosiyu/dsh-middleman.git
cd dsh-middleman
npm test          # 176 个功能用例 + 2 个文档对账用例，应该全绿
```

然后用上面「应用内安装」把本地目录装上。

### 验证装好了

侧边栏多一行「中台」。点开是空的批次列表，说明装对了。

### 然后就能用了

在**任意一个主会话**里说一句：

```
用中台派个子任务：帮我把 XXX 做掉
```

模型会自己开批次、盘问你、收敛、等你批准。详见上面「[怎么触发](#怎么触发)」。

**注意**：装完要**完全退出 DSH 再打开**，插件才会加载（`install.sh` 装的是 profile 的 `node_modules` 和 bundle 清单，热重载不认）。

## 手感演示（不建会话、不花钱）

```sh
node bin/mm.mjs
```

走一遍盘问、收敛、三道闸门，派发那一步只打印计划。

## 数据

台账在 `~/.dsh/middleman/designs/<batchId>.json`。一个批次一份，只存状态与引用，不存对话正文。

```jsonc
{
  "id": "D-20261102-3cxz",
  "status": "approved",          // grilling → converged → approved → dispatched
  "decisions": [ /* 设计树的每个决定 */ ],
  "questions": [ /* 问过用户的问题与答案，派发前至少 3 个 */ ],
  "plan":      { "steps": "", "output": "", "parallel": "" },
  "risks":     [ /* 四栏齐全的风险 */ ],
  "spec":      { "goal": "", "nonGoals": [], "acceptance": [] },
  "tickets":   [ /* 工单，带 riskIds 与 modelReason */ ]
}
```

## 模型怎么选

主会话按工单类型挑，**必须写 `modelReason`**，你在面板上能直接看出它是不是乱选。建议：

| 票的类型 | 倾向 |
|---|---|
| 调研、探索 | 便宜、快 |
| 架构、设计 | 最强 |
| 机械改动、重命名 | 便宜 |
| 验收、独立测试 | 和实现方**不同的**模型 |

最后一条：同一模型自己验自己，容易漏掉自己犯的错。

## 已知取舍

- **卡片只在实时渲染时存在。** 刷新会话后，对话流里那张派发卡片是空的——宿主不把 toolview 的渲染结果持久化进会话事件。台账里的工单还在，面板里的「执行」按钮也还在，所以活照跑，只是那张卡片不再复现。
- **`selectModel` 会改全局默认模型。** 派发前读、派完恢复；恢复失败只记日志，不回滚派发。改模型那条路（`/retarget`）同样如此。
- **技能组合受限。** `/grill-with-docs`、`/to-tickets` 这些主流程技能是 `disable-model-invocation`，模型调不动。所以盘问逻辑内建在插件里，没有外包给技能。
- **面板用 `React.createElement`。** 不用 JSX，于是仓库里就是能直接装的那一份，不需要构建步骤；代价是写起来比 JSX 啰嗦。
- **浏览器半区必须按 DSH 的客户端模块协议注册**（`window.__ModuleLoader__.load({id, factory})`）。写成普通 ESM 导出 `apply`，宿主会当宿主插件装载，然后卡在「waiting for service: slots」——slots 是浏览器侧的服务。
- **`session/modelCatalog` 在 0.2.1-rc.5 上会抛** `Cannot read properties of undefined (reading 'aborted')`。所以模型目录直接从 `ctx.llm` 读，不走那条网关路径。
- **`inject` 必须列全。** 少一个服务会在运行时报 `cannot get property X without inject`，而不是启动时失败——所以 `inject` 有专门的测试盯着。
- **子会话历史走 `session/follow`，不走 `session/page`。** page 的 `throughSeq` 是「读到第几号事件」，猜错就抛 "past cursor"，猜成 -1 则永远是空数组——两种猜法都表现为「子会话一个字没说」。follow 自己报游标，不用猜。

## 测试

```sh
node --test test/*.test.mjs
```

176 个用例：前沿计算、四道闸门、环检测、风险四栏、设计闸门、`turn/end` 分类、派发顺序、默认模型恢复、七条路由每条都被调用过、路由调用的方法在真派发面上都存在、浏览器 bundle 的运行期守卫、推理强度的单一真相来源、触发词不许被悄悄删掉、闸门本身的漏洞（成环放行、四栏敷衍放行、验证承诺三种绕过、空答案凑数）。

### 派发卡片的可视验证台

对话流里的卡片被两件事夹住：**对话流虚拟化**（内容只在视口附近进 DOM）与**我自己这一轮还在往同一条流里追加内容**（宿主不断把视口拉回底部）。所以直接对真对话流截图永远截不到——卡片在 DOM 里，但不在视口里。

`scripts/visual-harness.mjs` 换一条路：把**仓库里那一份** `lib/client.js` 原封不动装进页面，喂**真实账本里的工单**，用真 React 真 DOM 渲染。渲染的是同一份代码、同一份数据，只是不受虚拟化影响——截图因此是确定的。

```sh
mkdir -p /tmp/mm-harness && cd /tmp/mm-harness && npm init -y && npm i react react-dom esbuild
node scripts/visual-harness.mjs <batchId> <ticketId> <outDir>
```

它会起一个本地服务器（页面的 `/dsh-middleman/api/*` 代理到真插件），用 CDP 打开页面、等卡片渲染完，输出 `dispatch-card.png` 与 `dispatch-card.txt`。

**这个台子抓到过一个真 bug**：卡片上写「推理强度 low」，子会话其实跑的是 high——工单里 `model.reasoningEffort`（派发时真正传下去的那个）与 `effort`（冗余字段）各写各的，判断层优先读了后者。

## 许可

MIT