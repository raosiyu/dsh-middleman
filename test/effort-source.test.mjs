/**
 * 推理强度只有一个真相来源：model.reasoningEffort。
 *
 * 真事故：卡片上写「推理强度 low」，子会话其实跑的是 high。
 *
 * 原因是工单里有两个字段各写各的——model.reasoningEffort（派发时钉模型
 * 真正传下去的那个）与 effort（给人看的冗余）。判断层原本先读 effort，
 * 于是显示值与实际值可以分叉。
 *
 * 这条测试守住两处：
 *   1. 判断层显示的必须是 model.reasoningEffort；
 *   2. design_split 落账时就把 effort 对齐到 model.reasoningEffort，
 *      不让两个字段在账本里就分叉。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'mm-effort-'))
process.env.WT_HOME = home

const { buildTools } = await import('../lib/tools.js')
const { blankBatch, save, load } = await import('../lib/ledger.js')
const { ticketView } = await import('../lib/card-model.js')

/** 取工具面里某个工具的 execute。 */
function toolOf(tools, name) {
  const found = tools.find((tool) => tool.name === name)
  assert.ok(found !== undefined, '工具面里没有 ' + name)
  return found
}

/**
 * 造一个批次：已问够问题、有规划、有一条四栏齐全的风险，可以拆票。
 * @param {string} id - 批次 id。
 */
async function readyBatch(id) {
  const batch = blankBatch('测试批次')
  batch.id = id
  batch.cwd = home
  batch.questions = [
    { question: 'q1', answer: 'a1' },
    { question: 'q2', answer: 'a2' },
    { question: 'q3', answer: 'a3' },
  ]
  batch.plan = { steps: ['一', '二'], output: '产出' }
  batch.risks = [{
    id: 'R-1',
    title: '风险',
    trigger: '触发',
    impact: '影响',
    mitigation: '缓解',
    verification: '人工核对：看一眼卡片',
  }]
  await save(batch)
  return batch
}

test('design_split 落账时把 effort 对齐到 model.reasoningEffort', async () => {
  const batch = await readyBatch('D-effort-1')
  const tools = buildTools({ warn() {}, testFiles: async () => [] })
  const split = toolOf(tools, 'design_split')

  await split.execute({
    batchId: batch.id,
    tickets: [{
      id: 'T-1',
      title: '一张票',
      brief: '做点事',
      model: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
      modelReason: '快',
      effort: 'low',
      riskIds: ['R-1'],
    }],
  })

  const saved = await load('D-effort-1')
  const ticket = saved.tickets[0]
  assert.equal(ticket.model.reasoningEffort, 'high', 'model 里的推理强度被改动了')
  assert.equal(ticket.effort, 'high', 'effort 没有对齐到 model.reasoningEffort——两个字段会分叉')
})

test('model 里没写推理强度时，effort 被补进 model', async () => {
  const batch = await readyBatch('D-effort-2')
  const tools = buildTools({ warn() {}, testFiles: async () => [] })
  const split = toolOf(tools, 'design_split')

  await split.execute({
    batchId: batch.id,
    tickets: [{
      id: 'T-1',
      title: '一张票',
      brief: '做点事',
      model: { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
      modelReason: '快',
      effort: 'medium',
      riskIds: ['R-1'],
    }],
  })

  const saved = await load('D-effort-2')
  const ticket = saved.tickets[0]
  assert.equal(ticket.model.reasoningEffort, 'medium', 'effort 没有被补进 model')
  assert.equal(ticket.effort, 'medium')
})

test('两个都没写时不硬塞一个值', async () => {
  const batch = await readyBatch('D-effort-3')
  const tools = buildTools({ warn() {}, testFiles: async () => [] })
  const split = toolOf(tools, 'design_split')

  await split.execute({
    batchId: batch.id,
    tickets: [{
      id: 'T-1',
      title: '一张票',
      brief: '做点事',
      model: { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
      modelReason: '快',
      riskIds: ['R-1'],
    }],
  })

  const saved = await load('D-effort-3')
  const ticket = saved.tickets[0]
  assert.equal(ticket.model.reasoningEffort, undefined)
  assert.equal(ticket.effort, undefined)
})

test('卡片显示的强度与账本里子会话会用的强度一致', async () => {
  const batch = await readyBatch('D-effort-4')
  const tools = buildTools({ warn() {}, testFiles: async () => [] })
  const split = toolOf(tools, 'design_split')

  await split.execute({
    batchId: batch.id,
    tickets: [{
      id: 'T-1',
      title: '一张票',
      brief: '做点事',
      model: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
      modelReason: '快',
      effort: 'low',
      riskIds: ['R-1'],
    }],
  })

  const saved = await load('D-effort-4')
  const ticket = saved.tickets[0]
  const view = ticketView(ticket)
  const shown = view.fields.find(([label]) => label === '推理强度')

  // 卡片上写的，必须等于派发时钉模型真正传下去的那个值。
  assert.deepEqual(shown, ['推理强度', ticket.model.reasoningEffort])
  assert.equal(shown[1], 'high')
})

test('清理临时目录', () => {
  rmSync(home, { recursive: true, force: true })
})
