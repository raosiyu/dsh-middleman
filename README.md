# dsh-middleman

主会话当中台：**盘问 → 收敛 → 人工批准 → 派发独立子会话（挂起等执行）→ 结果自动回传**。

一个 DeepSeek Harness（DSH）插件。它补的是现成方案缺的那一层：

| 现成能力 | 缺什么 |
|---|---|
| `subagent` 工具 | 立刻就跑，没有挂起；模型和父会话相同 |
| 小队（dsh-agents） | 能钉预设和模型，但一调就开跑 |
| 任务板 | 有 todo 列当挂起，但没有「派发前先把设计问清楚」 |

中台要的是：**派发时把会话建好、模型定好，但不发第一条消息**——等你点执行。

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

## 三条风险，已绑在代码上

| ID | 触发 | 缓解 | 验证 |
|---|---|---|---|
| R-1 | 主会话把 `dispatch_task` 当普通 subagent 用，跳过盘问 | 没有 `batchId` 一律拒绝 | `dispatch.test.mjs` 断言抛错 |
| R-2 | 子会话撞 `max-tokens` 或被中断，却被当成失败 | 按 reason 分类，记 `partial` 并标截断位置 | `core.test.mjs` 断言 status |
| R-3 | 派发前根本没问清楚 | 至少 3 个已回答问题 + 流程规划 + 一条风险，缺一不可 | `core.test.mjs` 断言 designGateProblems |

R-2 的理由：长任务被截断很常见。一律标失败，你会开始忽略失败通知。

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
npm test          # 49 个用例，应该全绿
```

然后用上面「应用内安装」把本地目录装上。

### 验证装好了

侧边栏多一行「中台」。点开是空的批次列表，说明装对了。

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

- **`selectModel` 会改全局默认模型。** 派发前读、派完恢复；恢复失败只记日志，不回滚派发。
- **技能组合受限。** `/grill-with-docs`、`/to-tickets` 这些主流程技能是 `disable-model-invocation`，模型调不动。所以盘问逻辑内建在插件里，没有外包给技能。
- **面板用 `React.createElement`。** 不用 JSX，于是仓库里就是能直接装的那一份，不需要构建步骤；代价是写起来比 JSX 啰嗦。
- **浏览器半区必须按 DSH 的客户端模块协议注册**（`window.__ModuleLoader__.load({id, factory})`）。写成普通 ESM 导出 `apply`，宿主会当宿主插件装载，然后卡在「waiting for service: slots」——slots 是浏览器侧的服务。
- **`session/modelCatalog` 在 0.2.1-rc.5 上会抛** `Cannot read properties of undefined (reading 'aborted')`。所以模型目录直接从 `ctx.llm` 读，不走那条网关路径。
- **`inject` 必须列全。** 少一个服务会在运行时报 `cannot get property X without inject`，而不是启动时失败——所以 `inject` 有专门的测试盯着。

## 测试

```sh
node --test test/*.test.mjs
```

49 个用例：前沿计算、四道闸门、环检测、风险四栏、设计闸门、`turn/end` 分类、派发顺序、默认模型恢复、路由与工具注册。

## 许可

MIT