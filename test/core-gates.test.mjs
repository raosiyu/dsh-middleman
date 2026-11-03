/**
 * 规则层的回归：一次审计找出的 16 个漏洞，每条一个断言。
 *
 * 这批漏洞有同一个特征：**闸门看起来在，实际上没在**。
 * 写「有四栏齐全的风险」，代码只查了 risks.length；写「前沿清空」，
 * 前沿在成环时永远是空的；写「验证方式承诺的单测得存在」，
 * 换个措辞或换个后缀就绕过去了。
 *
 * 所以每条断言都写成「**这种形状必须被拦住**」——
 * 断言闸门在，而不是断言闸门不在。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  convergeProblems, designGateProblems, dispatchProblems, dependencyProblems,
  openCount, riskProblems, riskGaps, verificationTestGap, nextRound,
  approveProblems, isClosed,
} from '../lib/core.js'

/** 一条四栏齐全的风险。 */
const GOOD_RISK = {
  id: 'R-1',
  trigger: '触发条件够长了',
  impact: '影响够长了',
  mitigation: '缓解够长了',
  verification: '验证够长了',
}

/** 一张四栏齐全的票。 */
const GOOD_TICKET = {
  id: 'T-1',
  title: '一张票',
  brief: '做点事',
  blockedBy: [],
  riskIds: ['R-1'],
  riskFree: false,
  model: { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
  modelReason: '快',
  status: 'pending',
}

/** 一个除了要测的那一处，其余都合规的批次。 */
function batchOf(over = {}) {
  return {
    id: 'D-test',
    status: 'approved',
    decisions: [],
    questions: [
      { question: 'q1', answer: 'a1' },
      { question: 'q2', answer: 'a2' },
      { question: 'q3', answer: 'a3' },
    ],
    plan: { steps: '一步', output: '产出' },
    risks: [GOOD_RISK],
    spec: { goal: '目标', nonGoals: [], acceptance: ['能跑通'] },
    tickets: [GOOD_TICKET],
    ...over,
  }
}

// ── #1 决定依赖成环 → 收敛闸门放行 ──────────────────────────────

test('决定依赖成环时，收敛闸门拦住', () => {
  const batch = batchOf({
    decisions: [
      { id: 'D1', kind: 'goal', title: 'a', body: 'b', dependsOn: ['D2'] },
      { id: 'D2', kind: 'design', title: 'a', body: 'b', dependsOn: ['D1'] },
    ],
  })
  // 环里的决定互相阻塞 → 前沿永远是空的。只查前沿就会放行。
  assert.ok(
    convergeProblems(batch).some((p) => p.includes('个决定没定')),
    '成环的设计树被当成走完了',
  )
  assert.ok(
    dependencyProblems(batch).some((p) => p.includes('成环')),
    '依赖校验没有报环',
  )
})

test('没有环的时候不误报', () => {
  const batch = batchOf({
    decisions: [
      { id: 'D1', kind: 'goal', title: 'a', body: 'b', dependsOn: [], answer: '定了' },
      { id: 'D2', kind: 'design', title: 'a', body: 'b', dependsOn: ['D1'], answer: '定了' },
    ],
  })
  assert.deepEqual(dependencyProblems(batch), [])
})

// ── #2 设计闸门不校验风险四栏 ──────────────────────────────────

test('四栏全是敷衍语时，设计闸门拦住', () => {
  const batch = batchOf({
    risks: [{ id: 'R-1', trigger: '无', impact: 'n/a', mitigation: '无', verification: '无' }],
  })
  assert.ok(
    designGateProblems(batch).some((p) => p.includes('缺')),
    '四栏敷衍的风险被当成合规',
  )
  assert.ok(dispatchProblems(batch).some((p) => p.includes('缺')))
})

// ── #3 工单 id 重复 → 找不到环 ──────────────────────────────────

test('工单 id 重复时报出来，且重复 id 藏起来的环也报出来', () => {
  const ticket = (id, blockedBy, title) => ({
    ...GOOD_TICKET, id, title, blockedBy,
  })
  const batch = batchOf({
    tickets: [ticket('T-1', ['T-2'], 'A'), ticket('T-2', ['T-1'], 'B'), ticket('T-1', [], 'dup')],
  })
  const problems = dispatchProblems(batch)
  assert.ok(problems.some((p) => p.includes('id 重复')), '重复 id 没报出来')
  assert.ok(problems.some((p) => p.includes('成环')), '重复 id 藏起来的环没报出来')
})

// ── #4/#5/#6 验证承诺的三种绕过 ────────────────────────────────

const FILES = ['risk-r1.test.mjs', 'core.test.mjs', 'observer-report.test.mjs']

test('承诺了不存在的测试文件，一律拦住', () => {
  const cases = [
    '单测：见 lib/core.mjs',          // 前缀匹配曾把它放行
    '单测：见 test/risk-r1.js',       // .js 后缀曾绕过严格检查
    '单测：见 test/core.test.ts',     // .ts 后缀曾绕过严格检查
    '单元测试：见 test/ghost.test.mjs',   // 同义词曾绕过
    '自动化测试：见 test/ghost.test.mjs', // 同义词曾绕过
    'unit test: test/ghost.test.mjs',     // 同义词曾绕过
  ]
  for (const verification of cases) {
    assert.notEqual(
      verificationTestGap({ id: 'R-1', verification }, FILES),
      '',
      '这条承诺被放行了：' + verification,
    )
  }
})

test('真的存在、或者本来就是人工核对，放行', () => {
  const allowed = [
    '单测：risk-r1.test.mjs 断言抛错',
    '单测：risk-r1 里断言',
    '人工核对：在面板上确认这张票是「已批准」',
    '这次跑一遍看看',
  ]
  for (const verification of allowed) {
    assert.equal(
      verificationTestGap({ id: 'R-1', verification }, FILES),
      '',
      '这条被误拦了：' + verification,
    )
  }
})

// ── #7/#8 台账缺字段时崩溃 ──────────────────────────────────────

test('批次缺 risks 时不崩，给可读拒绝', () => {
  const batch = batchOf({ risks: undefined })
  assert.ok(Array.isArray(designGateProblems(batch)))
  assert.ok(Array.isArray(dispatchProblems(batch)))
  assert.ok(Array.isArray(convergeProblems(batch)))
  // nextRound 返回的是对象，不是数组——断言它不抛就行。
  assert.doesNotThrow(() => nextRound(batch))
  assert.ok(Array.isArray(nextRound(batch).questions))
})

test('risks 不是数组时不当成「有风险」', () => {
  const batch = batchOf({ risks: {} })
  assert.ok(designGateProblems(batch).length > 0, 'risks = {} 被放行了')
})

test('risks 里有一条 null 时不崩', () => {
  assert.ok(Array.isArray(riskProblems([null])))
  assert.ok(Array.isArray(riskGaps(null)))
})

// ── #9 model: {} 通过「没定模型」闸门 ───────────────────────────

test('模型没真正指定时拦住', () => {
  for (const model of [{}, { provider: 'p' }, { provider: 'p', model: '' }]) {
    const batch = batchOf({ tickets: [{ ...GOOD_TICKET, model }] })
    assert.ok(
      dispatchProblems(batch).some((p) => p.includes('没定模型')),
      '空模型被放行了：' + JSON.stringify(model),
    )
  }
})

// ── #10 nextRound 的 remaining 按整棵树算 ───────────────────────

test('remaining 说的是整棵树还剩多少', () => {
  // 前沿上只有 D1（另外两个被 D1 挡住），所以这轮问了 1 个。
  // 但整棵树上还有 3 个没定 —— 原来 remaining 按前沿算，于是显示「还剩 0 个」。
  const decisions = [
    { id: 'D1', kind: 'goal', title: 'a', body: 'b', dependsOn: [] },
    { id: 'D2', kind: 'scope', title: 'a', body: 'b', dependsOn: ['D1'] },
    { id: 'D3', kind: 'design', title: 'a', body: 'b', dependsOn: ['D1'] },
  ]
  const batch = { decisions, risks: [] }
  const round = nextRound(batch, 2)
  assert.equal(openCount(batch), 3)
  assert.equal(round.asked, 1, '前沿上只有 D1')
  assert.equal(round.remaining, 2, '被挡住的那两个也得算进去')
})

// ── #11 nextRound 突破 size 上限 ───────────────────────────────

test('一轮最多问 size 个', () => {
  const decisions = [
    { id: 'D1', kind: 'goal', title: 'a', body: 'b', dependsOn: [] },
    { id: 'D2', kind: 'scope', title: 'a', body: 'b', dependsOn: [] },
    { id: 'D4', kind: 'risk', title: 'a', body: 'b', dependsOn: [] },
  ]
  const round = nextRound({ decisions, risks: [] }, 2)
  assert.ok(round.questions.length <= 2, '一轮问出了 ' + round.questions.length + ' 个')
})

// ── #12 空答案算已闭合 ─────────────────────────────────────────

test('空答案不算已回答', () => {
  assert.equal(isClosed({ answer: '' }), false)
  assert.equal(isClosed({ answer: null }), false)
  assert.equal(isClosed({ answer: '定了' }), true)
  const batch = batchOf({ decisions: [{ id: 'D1', dependsOn: [], answer: '' }] })
  assert.ok(convergeProblems(batch).some((p) => p.includes('个决定没定')))
})

// ── #13 空验收标准 ─────────────────────────────────────────────

test('验收标准不能是空串', () => {
  const batch = batchOf({ spec: { goal: 'g', nonGoals: [], acceptance: [''] } })
  assert.ok(convergeProblems(batch).some((p) => p.includes('验收标准')))
})

// ── #14 英文敷衍语 ─────────────────────────────────────────────

test('英文敷衍语也算敷衍', () => {
  for (const filler of ['none', 'null', 'None', 'NULL', 'n.a.']) {
    const gaps = riskGaps({ trigger: filler, impact: 'bbbb', mitigation: 'cccc', verification: 'dddd' })
    assert.ok(gaps.includes('触发条件'), '敷衍语被接受了：' + filler)
  }
})

// ── #15 approveProblems fail-open ───────────────────────────────

test('批准只认明确的 false，其余一律拦', () => {
  const batch = batchOf({ status: 'converged' })
  assert.deepEqual(approveProblems(batch, false), [])
  for (const value of [true, 1, 'true', {}, undefined]) {
    assert.ok(
      approveProblems(batch, value).some((p) => p.includes('不对模型开放')),
      '模型侧批准被放行了：' + JSON.stringify(value),
    )
  }
})

// ── #16 事实型问题凑数 ─────────────────────────────────────────

test('事实型的问题不算盘问', () => {
  const batch = batchOf({
    questions: [
      { kind: 'fact', question: 'q1', answer: 'a1' },
      { kind: 'fact', question: 'q2', answer: 'a2' },
      { kind: 'fact', question: 'q3', answer: 'a3' },
    ],
  })
  assert.ok(designGateProblems(batch).some((p) => p.includes('盘问没做够')))
})

test('同一条问三遍不算数', () => {
  const batch = batchOf({
    questions: [
      { question: '同一个问题', answer: 'a' },
      { question: '同一个问题', answer: 'a' },
      { question: '同一个问题', answer: 'a' },
    ],
  })
  assert.ok(designGateProblems(batch).some((p) => p.includes('盘问没做够')))
})
