/**
 * R-1 的验证：主会话绕过盘问直接派发。
 *
 * 这条风险的缓解措施写在 dispatch_task 里——没有 batchId 一律拒绝。
 * 回报里写的验证方式是「单测：不传 batchId 断言抛错且不建会话」，
 * 这条单测此前并不存在，于是缓解措施只是「写着」，没有被盯住。
 *
 * 这里补上，并且把「不建会话」也断言了：不光要抛错，还得保证
 * dispatcher.spawn 一次都没被调用——抛了错却把子会话建出来，
 * 额度已经花掉，那才是这条风险真正要防的事。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'mm-r1-'))
process.env.WT_HOME = home

const { buildTools } = await import('../lib/tools.js')
const { blankBatch, save } = await import('../lib/ledger.js')

/**
 * 造一个只记 spawn 调用的假派发面。
 * @returns {{ faces: object, spawns: Array }}
 */
function fakeFaces() {
  const spawns = []
  return {
    spawns,
    faces: {
      dispatcher: {
        async spawn(ticket, options) {
          spawns.push({ ticket, options })
          return { sessionId: 'session-should-not-exist', model: { provider: 'p', model: 'm' } }
        },
      },
      // 仓库里真实的测试文件：R-1 的验证方式承诺的正是这一条。
      testFiles: async () => ['risk-r1.test.mjs'],
      warn() {},
    },
  }
}

/** 取工具面里某个工具的 execute。 */
function toolOf(tools, name) {
  const found = tools.find((tool) => tool.name === name)
  assert.ok(found !== undefined, '工具面里没有 ' + name)
  return found
}

test('dispatch_task 不带 batchId 时抛错，并且一个子会话都不建', async () => {
  const { faces, spawns } = fakeFaces()
  const tools = buildTools(faces)
  const dispatch = toolOf(tools, 'dispatch_task')

  await assert.rejects(
    () => dispatch.execute({ ticketId: 'T-1' }),
    (error) => {
      assert.equal(error.code, 'batch-required', '该用稳定的机器码 batch-required，实际是：' + error.code)
      assert.match(error.message, /batchId/)
      return true
    },
  )

  assert.equal(spawns.length, 0, '抛了错却还是建了子会话——额度已经花掉，这条风险没防住')
})

test('dispatch_task 带空串 batchId 也一样拒绝', async () => {
  const { faces, spawns } = fakeFaces()
  const tools = buildTools(faces)
  const dispatch = toolOf(tools, 'dispatch_task')

  await assert.rejects(
    () => dispatch.execute({ batchId: '   ', ticketId: 'T-1' }),
    (error) => error.code === 'batch-required',
  )
  assert.equal(spawns.length, 0)
})

test('批次存在但设计闸门没过时，拒绝派发，也不建会话', async () => {
  const { faces, spawns } = fakeFaces()
  const tools = buildTools(faces)
  const dispatch = toolOf(tools, 'dispatch_task')

  // 一个刚开的批次：没有已回答的问题、没有流程规划、没有风险。
  const batch = blankBatch('R-1 闸门验证')
  batch.tickets = [{
    id: 'T-1', title: '未就绪的票', brief: '', blockedBy: [], riskIds: [],
    riskFree: false, riskFreeReason: undefined,
    model: { provider: 'p', model: 'm' },
    modelReason: '快',
    source: undefined, payload: undefined, effort: undefined, notes: undefined,
    status: 'pending',
  }]
  await save(batch)

  const result = await dispatch.execute({ batchId: batch.id, ticketId: 'T-1' })
  assert.equal(result.ok, false, '闸门没过却放行了')
  assert.equal(result.code, 'dispatch-blocked')
  assert.ok(result.problems.length > 0, '拒绝时得说清差什么')
  assert.equal(spawns.length, 0, '闸门没过却建了子会话')
})

test('批次与票都齐了才真的建会话', async () => {
  const { faces, spawns } = fakeFaces()
  const tools = buildTools(faces)
  const dispatch = toolOf(tools, 'dispatch_task')

  const batch = blankBatch('R-1 放行验证')
  batch.status = 'approved'
  batch.questions = [
    { question: 'q1', answer: 'a1' },
    { question: 'q2', answer: 'a2' },
    { question: 'q3', answer: 'a3' },
  ]
  batch.plan = { steps: '第一步', output: '一份文件' }
  batch.risks = [{
    id: 'R-1',
    title: '绕过盘问',
    trigger: '不带 batchId',
    impact: '额度白花',
    mitigation: '代码里拒绝',
    // 指名道姓：承诺了哪条测试，就得真有那条。
    verification: '单测：risk-r1.test.mjs 断言抛错且不建会话',
  }]
  batch.tickets = [{
    id: 'T-1', title: '可以派的票', brief: '干活', blockedBy: [], riskIds: ['R-1'],
    riskFree: false, riskFreeReason: undefined,
    model: { provider: 'p', model: 'm' },
    modelReason: '快',
    source: undefined, payload: undefined, effort: undefined, notes: undefined,
    status: 'pending',
  }]
  await save(batch)

  const result = await dispatch.execute({ batchId: batch.id, ticketId: 'T-1' })
  assert.equal(result.ok, true, '闸门过了却没放行：' + JSON.stringify(result))
  assert.equal(spawns.length, 1, '该建一个子会话，实际建了 ' + spawns.length + ' 个')
  assert.equal(result.status, 'suspended', '建好的子会话应当是挂起状态，不点执行就不跑')
})

test('不存在的批次：报错，不是崩，也不是静默放行', async () => {
  const { faces, spawns } = fakeFaces()
  const tools = buildTools(faces)
  const dispatch = toolOf(tools, 'dispatch_task')

  await assert.rejects(() => dispatch.execute({ batchId: 'D-does-not-exist', ticketId: 'T-1' }))
  assert.equal(spawns.length, 0)
})

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})
