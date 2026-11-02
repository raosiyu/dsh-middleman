/**
 * 规则层回归：三道闸门、前沿、风险四栏、turn/end 分类。
 *
 * 跑法：node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  frontier, blocked, nextRound, dependencyProblems, openCount,
  riskGaps, riskProblems, convergeProblems, approveProblems, dispatchProblems,
  readyTickets, classifyTurnEnd, RISK_FIELDS,
} from '../lib/core.js'

/** 一棵已经全部定完、风险齐全、工单合法的最小批次。 */
function goodBatch() {
  return {
    id: 'D-test',
    status: 'approved',
    decisions: [
      { id: 'D1', kind: 'goal', title: 't', body: 'b', dependsOn: [], answer: 'a' },
    ],
    risks: [
      { id: 'R-1', title: 'r', trigger: '触发条件够长', impact: '影响够长了', mitigation: '缓解够长了', verification: '验证够长了' },
    ],
    spec: { goal: 'g', nonGoals: [], acceptance: ['能跑通'] },
    tickets: [
      {
        id: 'T-1', title: 't', brief: 'b', blockedBy: [], riskIds: ['R-1'], riskFree: false,
        model: { provider: 'p', model: 'm' }, modelReason: '便宜够用', status: 'pending',
      },
    ],
  }
}

test('前沿只放前置条件已满足的决定', () => {
  const batch = {
    decisions: [
      { id: 'D1', dependsOn: [], answer: 'a' },
      { id: 'D2', dependsOn: ['D1'] },
      { id: 'D3', dependsOn: ['D2'] },
    ],
  }
  assert.deepEqual(frontier(batch).map((d) => d.id), ['D2'])
  assert.deepEqual(blocked(batch).map((d) => d.id), ['D3'])
})

test('没登记任何风险时，代码自己追加一条风险探测', () => {
  const batch = {
    decisions: [{ id: 'D1', kind: 'goal', title: 't', body: 'b', dependsOn: [], answer: 'a' }],
    risks: [],
  }
  const round = nextRound(batch)
  assert.ok(round.questions.some((q) => q.synthetic === true), '应当追加合成的风险探测')
})

test('已经登记过风险就不再每轮追问', () => {
  const batch = {
    decisions: [{ id: 'D2', kind: 'goal', title: 't', body: 'b', dependsOn: [] }],
    risks: [{ id: 'R-1' }],
  }
  assert.equal(nextRound(batch).questions.some((q) => q.synthetic === true), false)
})

test('风险四栏缺一栏就报出来', () => {
  const gaps = riskGaps({
    trigger: '子会话超时且没有回传',
    impact: '主会话一直等，卡住整条流程',
    mitigation: '30 秒没回报就标 failed',
    verification: '无',
  })
  assert.deepEqual(gaps, ['怎么验证'])
})

test('「无」「n/a」这种敷衍算缺失', () => {
  const gaps = riskGaps({ trigger: '子会话超时', impact: '主会话卡住', mitigation: '无', verification: 'n/a' })
  assert.deepEqual(gaps, ['缓解', '怎么验证'])
})

test('风险四栏的名字与顺序是固定的', () => {
  assert.deepEqual(RISK_FIELDS.map(([field]) => field), ['trigger', 'impact', 'mitigation', 'verification'])
})

test('收敛要求风险台账非空', () => {
  const batch = goodBatch()
  batch.risks = []
  assert.ok(convergeProblems(batch).some((p) => p.includes('一条风险都没登记')))
})

test('收敛要求至少一条验收标准', () => {
  const batch = goodBatch()
  batch.spec.acceptance = []
  assert.ok(convergeProblems(batch).some((p) => p.includes('验收标准')))
})

test('收敛要求前沿清空', () => {
  const batch = goodBatch()
  batch.decisions.push({ id: 'D9', dependsOn: [], title: 'x', body: 'y' })
  assert.ok(convergeProblems(batch).some((p) => p.includes('前沿上还有')))
})

test('模型进程不能批准自己的设计', () => {
  const batch = goodBatch()
  batch.status = 'converged'
  assert.ok(approveProblems(batch, true).some((p) => p.includes('不对模型开放')))
  assert.deepEqual(approveProblems(batch, false), [])
})

test('没批准的批次不能派发', () => {
  const batch = goodBatch()
  batch.status = 'converged'
  assert.ok(dispatchProblems(batch).some((p) => p.includes('还没批准')))
})

test('工单不挂风险、也不写 riskFree 理由，就拦住', () => {
  const batch = goodBatch()
  batch.tickets[0].riskIds = []
  assert.ok(dispatchProblems(batch).some((p) => p.includes('没挂风险')))

  batch.tickets[0].riskFree = true
  assert.ok(dispatchProblems(batch).some((p) => p.includes('没写理由')))
})

test('工单引用了不存在的风险就拦住', () => {
  const batch = goodBatch()
  batch.tickets[0].riskIds = ['R-9']
  assert.ok(dispatchProblems(batch).some((p) => p.includes('不存在的风险')))
})

test('工单没写 modelReason 就拦住', () => {
  const batch = goodBatch()
  batch.tickets[0].modelReason = '  '
  assert.ok(dispatchProblems(batch).some((p) => p.includes('modelReason')))
})

test('工单没定模型就拦住', () => {
  const batch = goodBatch()
  delete batch.tickets[0].model
  assert.ok(dispatchProblems(batch).some((p) => p.includes('没定模型')))
})

test('阻塞边成环就拦住', () => {
  const batch = goodBatch()
  batch.tickets = [
    { id: 'T-1', blockedBy: ['T-2'], riskIds: ['R-1'], model: { provider: 'p', model: 'm' }, modelReason: 'r' },
    { id: 'T-2', blockedBy: ['T-1'], riskIds: ['R-1'], model: { provider: 'p', model: 'm' }, modelReason: 'r' },
  ]
  assert.ok(dispatchProblems(batch).some((p) => p.includes('成环')))
})

test('依赖指向不存在的决定就拦住', () => {
  const batch = { decisions: [{ id: 'D1', dependsOn: ['D9'] }] }
  assert.ok(dependencyProblems(batch).some((p) => p.includes('不存在')))
})

test('完全合法的批次三道闸门都过', () => {
  assert.deepEqual(convergeProblems(goodBatch()), [])
  assert.deepEqual(dispatchProblems(goodBatch()), [])
})

test('就绪工单要等前置完成', () => {
  const batch = {
    tickets: [
      { id: 'T-1', blockedBy: [], status: 'done' },
      { id: 'T-2', blockedBy: ['T-1'], status: 'pending' },
      { id: 'T-3', blockedBy: ['T-2'], status: 'pending' },
    ],
  }
  assert.deepEqual(readyTickets(batch).map((t) => t.id), ['T-2'])
})

test('turn/end 只有 completed 算成功', () => {
  assert.equal(classifyTurnEnd({ kind: 'completed' }).status, 'done')
})

test('max-tokens 与 interrupted 记 partial 而不是 failed', () => {
  assert.equal(classifyTurnEnd({ kind: 'max-tokens' }).status, 'partial')
  assert.equal(classifyTurnEnd({ kind: 'interrupted' }).status, 'partial')
})

test('error / aborted / blocked 记 failed', () => {
  for (const kind of ['error', 'aborted', 'blocked']) {
    assert.equal(classifyTurnEnd({ kind }).status, 'failed')
  }
})

test('未闭合决定计数', () => {
  const batch = { decisions: [{ id: 'D1', answer: 'a' }, { id: 'D2' }, { id: 'D3', deferred: 'later' }] }
  assert.equal(openCount(batch), 1)
})
