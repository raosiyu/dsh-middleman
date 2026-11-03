/**
 * 闸门清单：每一道闸门一行，冻结在这里，跟代码对账。
 *
 * ## 为什么清单是手写的、而不全是扫出来的
 *
 * 「清单不手写」说的是**不靠人记得去改**。但清单本身必须存在，否则自检就
 * 不知道自己该盯什么。所以这里的做法是：
 *
 * - **闸门的身份由扫描决定**（`scripts/gates/inventory.mjs`）：`problems.push`
 *   的每一处、`TICKET_STATUS` 的每个键、`isTerminalStatus` 判的每个状态、
 *   `RISK_FIELDS` 的四栏、routes/tools/dispatch 的每个拒绝调用点、observer 的
 *   四条判据——都是扫出来的，id 由源码位置与措辞决定。
 * - **这份清单只写「它由谁来验」**：每个锚点 id 指向哪条探针。
 * - **对账双向**：清单里登记了但源码里扫不到 → 闸门被删了；源码里扫到了但
 *   清单没登记 → 新闸门没人盯。两边任何一边缺，`npm run check` 都会红。
 *
 * 也就是说：删掉一道闸门的实现，扫描立刻少一条锚点，清单里那条就成了孤儿，
 * 报出来。不需要有谁记得来改这份文件。
 *
 * ## `covers` 的写法
 *
 * 值是探针 id（`g-*`），实现在 `scripts/gates/*.mjs` 导出的数组里：
 * `core.mjs` → `coreGates`、`tools.mjs` → `toolGates`、`routes.mjs` →
 * `routeGates`、`observer.mjs` → `observerGates`。
 *
 * 一条探针可以盯多道闸门（同一个判据拦的是几件事），一道闸门也可以被多条
 * 探针盯（源码锚点 + 行为各一条）。但**每一道都必须至少有一条探针**。
 *
 * @module dsh-whale-tail/scripts/gates/manifest
 */

/** 探针模块的注册表：模块文件 → 导出的数组名。 */
export const PROBE_MODULES = [
  { file: 'scripts/gates/core.mjs', exportName: 'coreGates' },
  { file: 'scripts/gates/tools.mjs', exportName: 'toolGates' },
  { file: 'scripts/gates/routes.mjs', exportName: 'routeGates' },
  { file: 'scripts/gates/observer.mjs', exportName: 'observerGates' },
  { file: 'scripts/gates/dispatch.mjs', exportName: 'probes' },
]

/**
 * 每个锚点该由哪几条探针验证。
 *
 * 键是 `scanAnchors()` 给出的锚点 id，值是探针 id 数组。
 *
 * 归一化规则（`scripts/check.mjs` 里实现，这里说明）：
 * 扫描出的 id 形如 `lib/core.js#push:convergeProblems/规格缺目标`。
 * 清单里可以用**更粗**的写法登记同一条，只要扫描出的 id 以它开头：
 *
 * - `lib/core.js#push:convergeProblems/` —— 这个函数里所有 push 都归它；
 * - `lib/core.js#status:` —— 所有状态；
 * - `lib/core.js` —— 这个文件的全部锚点。
 *
 * 粗登记方便一次覆盖一大片（比如「所有状态都由 g-core-terminal-waiting 盯」），
 * 但**粗登记不等于免检**：不管登记得多粗，扫描出的每一条仍然要真的被某个
 * 前缀命中，一条没命中就报孤儿。
 *
 * 有意不登记的：一个都没有。如果真的有一道闸门暂时没有探针，正确做法是补
 * 探针，而不是在清单里划掉——划掉等于这道闸门从此没人盯，而这份文件本身
 * 就是「不许悄悄失守」的那一层。
 */
export const GATE_OWNERS = {
  // ── core.js：纯规则层 ────────────────────────────────────────────
  'lib/core.js#status:': [
    'g-core-terminal-waiting',
  ],
  'lib/core.js#terminal:': [
    'g-core-terminal-waiting',
    'g-core-ready-blocked-by-waiting',
  ],
  'lib/core.js#risk-field:': [
    'g-core-risk-four-fields',
    'g-tool-risk-four-fields',
  ],
  'lib/core.js#push:convergeProblems/': [
    'g-core-converge-open-decisions',
    'g-core-converge-cycle',
    'g-core-converge-spec',
  ],
  'lib/core.js#push:designGateProblems/': [
    'g-core-design-questions',
    'g-tool-dispatch-blocked',
  ],
  'lib/core.js#push:dispatchProblems/': [
    'g-core-dispatch-risk-binding',
    'g-core-dispatch-ticket-cycle',
    'g-core-dispatch-duplicate-ids',
    'g-core-dispatch-model',
    'g-core-verification-test-present',
    'g-tool-dispatch-blocked',
  ],
  'lib/core.js#push:approveProblems/': [
    'g-core-approve-human-only',
  ],
  'lib/core.js#push:riskProblems/': [
    'g-core-risk-four-fields',
    'g-core-risk-filler',
    'g-tool-risk-four-fields',
    'g-tool-risk-filler',
  ],
  'lib/core.js#push:dependencyProblems/': [
    'g-core-converge-cycle',
    'g-core-dispatch-ticket-cycle',
  ],

  // ── tools.js：模型调的九件工具 ──────────────────────────────────
  'lib/tools.js#refusal:design_answer/invalid-request/risk 与 decisionId 只能给一个': [
    'g-tool-risk-four-fields',
  ],
  'lib/tools.js#refusal:design_answer/invalid-request/risk 得是一个对象': [
    'g-tool-risk-four-fields',
  ],
  'lib/tools.js#refusal:design_answer/risk-incomplete/风险缺：': [
    'g-tool-risk-four-fields',
    'g-tool-risk-filler',
  ],
  'lib/tools.js#refusal:design_answer/verification-unbacked/verification-unbacked': [
    'g-tool-verification-test-missing',
    'g-tool-verification-unspecified',
  ],
  'lib/tools.js#error:dispatch_task/batch-required/': [
    'g-tool-batch-required',
    'g-tool-batch-required-blank',
  ],
  'lib/tools.js#refusal:design_converge/converge-blocked/': [
    'g-core-converge-spec',
    'g-core-converge-open-decisions',
  ],
  'lib/tools.js#refusal:design_split/split-blocked/': [
    'g-core-dispatch-risk-binding',
    'g-core-dispatch-ticket-cycle',
  ],
  'lib/tools.js#refusal:dispatch_task/dispatch-blocked/': [
    'g-tool-dispatch-blocked',
  ],
  'lib/tools.js#refusal:': [
    'g-tool-dispatch-blocked',
  ],
  'lib/tools.js#error:buildTools/invalid-request/必须带 batchId': [
    'g-tool-batch-required',
  ],

  // ── routes.js：面板打的那些端点 ────────────────────────────────
  'lib/routes.js#refuse:makeRoutes/forbidden/': [
    'g-route-refuse-shape',
  ],
  'lib/routes.js#refuse:makeRoutes/internal/': [
    'g-route-refuse-shape',
  ],
  'lib/routes.js#refuse:approve/not-converged/': [
    'g-route-approve-human-only',
  ],
  'lib/routes.js#refuse:run/ticket-missing/': [
    'g-route-execute-not-dispatched',
  ],
  'lib/routes.js#refuse:run/not-dispatched/': [
    'g-route-execute-not-dispatched',
  ],
  'lib/routes.js#refuse:run/already-running/': [
    'g-route-execute-only-suspended',
  ],
  'lib/routes.js#refuse:answer/not-waiting/': [
    'g-route-answer-not-waiting',
  ],
  'lib/routes.js#refuse:answer/invalid-request/回答不能为空': [
    'g-route-answer-empty',
  ],
  'lib/routes.js#refuse:answer/no-session/': [
    'g-route-answer-not-waiting',
  ],
  'lib/routes.js#refuse:retarget/invalid-request/必须带 model': [
    'g-route-model-shape',
  ],
  'lib/routes.js#refuse:': [
    'g-route-refuse-shape',
  ],

  // ── dispatch.js：建会话的那条路 ────────────────────────────────
  'lib/dispatch.js#error:createDispatcher/gateway-unavailable/': [
    'g-dispatch-gateway',
  ],
  'lib/dispatch.js#error:': [
    'g-dispatch-gateway',
  ],

  // ── refusals.js：拒绝码 → HTTP 状态码的映射表 ──────────────────
  'lib/refusals.js#status-code:': [
    'g-route-refuse-shape',
  ],

  // ── observer.js：四条静默的判据 ────────────────────────────────
  'lib/observer.js#judgment:waiting-gate': [
    'g-observer-waiting',
  ],
  'lib/observer.js#judgment:unstarted-gate': [
    'g-observer-unstarted',
  ],
  'lib/observer.js#judgment:dedupe-gate': [
    'g-observer-dedupe',
  ],
  'lib/observer.js#judgment:unknown-session-gate': [
    'g-observer-unknown-session',
  ],
}

/**
 * 必须存在的探针。清单里的每一条 `GATE_OWNERS` 值都要出现在这里——
 * 打错一个字就变成「指向一条不存在的探针」，对账会红。
 *
 * @type {string[]}
 */
export const EXPECTED_PROBES = [
  // core
  'g-core-terminal-waiting',
  'g-core-ready-blocked-by-waiting',
  'g-core-risk-four-fields',
  'g-core-risk-filler',
  'g-core-converge-open-decisions',
  'g-core-converge-cycle',
  'g-core-converge-spec',
  'g-core-approve-human-only',
  'g-core-design-questions',
  'g-core-dispatch-risk-binding',
  'g-core-dispatch-ticket-cycle',
  'g-core-dispatch-duplicate-ids',
  'g-core-dispatch-model',
  'g-core-verification-test-present',
  // tools
  'g-tool-batch-required',
  'g-tool-batch-required-blank',
  'g-tool-dispatch-blocked',
  'g-tool-risk-four-fields',
  'g-tool-risk-filler',
  'g-tool-verification-test-missing',
  'g-tool-verification-test-present',
  'g-tool-verification-unspecified',
  'g-tool-answered-count-dedupe',
  'g-tool-design-question-fact',
  // routes
  'g-route-refuse-shape',
  'g-route-answer-not-waiting',
  'g-route-answer-empty',
  'g-route-execute-only-suspended',
  'g-route-execute-not-dispatched',
  'g-route-model-shape',
  'g-route-approve-human-only',
  'g-route-body-limit',
  // observer
  'g-observer-waiting',
  'g-observer-unstarted',
  'g-observer-dedupe',
  'g-observer-unknown-session',
  // dispatch
  'g-dispatch-gateway',
]
