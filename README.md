# dsh-middleman

主会话当中台：**盘问 → 收敛 → 人工批准 → 派发独立子会话（挂起等执行）→ 结果自动回传**。

一个 DeepSeek Harness（DSH）插件。它补的是现成方案缺的那一层：

| 现成能力 | 缺什么 |
|---|---|
| `subagent` 工具 | 立刻就跑，没有挂起；模型和父会话相同 |
| 小队（dsh-agents） | 能钉预设和模型，但一调就开跑 |
| 任务板 | 有 todo 列当挂起，但没有「派发前先把设计问清楚」 |

中台要的是：**派发时把会话建好、模型定好，但不发第一条消息**——等你点执行。

## 为什么是这三个闸门

规则写在代码里，不写在提示词里。提示词会被模型合理化掉。

1. **收敛**：设计树前沿清空、规格有验收标准、风险四栏齐全、依赖边合法
2. **批准**：只有人能点。`approve` 不在工具面上，模型没有对应工具可调
3. **派发**：批次已批准、每张票挂风险、写了 `modelReason`、阻塞边不成环

## 流程

```
design_open      开一个设计批次（盘问阶段的容器）
design_round     取下一轮要问的问题；代码保证只要还没登记风险就带一个风险探测
design_answer    定一个决定，或登记一条风险（四栏缺一栏就拒绝）
design_converge  收敛成规格
   ↓  人在中台面板点「批准」
design_split     拆成工单，每张挂风险、写 modelReason
dispatch_task    建会话 + 定模型 + 挂起（不发第一条消息）
   ↓  人在中台面板点「执行」
（子会话开跑）→ turn/end → 结果自动推回主会话
```

## 两条风险，已绑在代码上

| ID | 触发 | 缓解 | 验证 |
|---|---|---|---|
| R-1 | 主会话把 `dispatch_task` 当普通 subagent 用，跳过盘问 | 没有 `batchId` 一律拒绝 | `dispatch.test.mjs` 断言抛错 |
| R-2 | 子会话撞 `max-tokens` 或被中断，却被当成失败 | 按 reason 分类，记 `partial` 并标截断位置 | `core.test.mjs` 断言 status |

R-2 的理由：长任务被截断很常见。一律标失败，你会开始忽略失败通知。

## 安装

### 一键安装（推荐）

```sh
curl -fsSL https://raw.githubusercontent.com/raosiyu/dsh-middleman/main/install.sh | sh
```

脚本会下载源码、跑一遍测试，然后告诉你**在应用里粘贴哪个路径**。

> 为什么不能全自动：桌面版（Electron 应用）的 profile 由应用自己管，命令行 `dsh plugin --profile desktop add` 会被直接拒绝（`profile "desktop" is managed exclusively by the Electron application`）。最后一步只能在应用里点。

### 应用内安装（手动版，最直接）

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
npm test          # 42 个用例，应该全绿
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

32 个用例：前沿计算、三道闸门、环检测、风险四栏、`turn/end` 分类、派发顺序、默认模型恢复。

## 许可

MIT