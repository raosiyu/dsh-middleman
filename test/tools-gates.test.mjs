/**
 * 工具面与路由面的回归：一次审计找出的 9 个漏洞。
 *
 * 最有代表性的是第一条：**整道设计闸门可被绕过**。
 *
 * design_question 原来写 `answer: String(args.answer)`——不给 answer 时
 * String(undefined) 是字符串 "undefined"，非空，于是下游所有
 * trim() !== '' 的检查都把它当「已回答」。设计闸门（至少 3 个已回答的
 * 问题）于是一道就能过。
 *
 * 而工具的 JSON Schema 写着 required: ['batchId','question','answer']——
 * 但插件用的是裸 tools.register()，宿主不校验参数，Schema 只是摆设。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'mm-tools-'))
process.env.WT_HOME = home

const { buildTools } = await import('../lib/tools.js')
const { blankBatch, save, load } = await import('../lib/ledger.js')
const { makeRoutes } = await import('../lib/routes.js')

/** 造一个只记派发调用的假派发面。 */
function fakeFaces(over = {}) {
  const calls = []
  return {
    calls,
    faces: {
      dispatcher: {
        async spawn(ticket) { calls.push({ method: 'spawn', ticket }); return { sessionId: 'session-new', model: ticket.model } },
        async run(sessionId, text) { calls.push({ method: 'run', sessionId, text }) },
        async steer(sessionId, text) { calls.push({ method: 'steer', sessionId, text }) },
        async cancel(sessionId) { calls.push({ method: 'cancel', sessionId }) },
        async selectModel(sessionId, model) { calls.push({ method: 'selectModel', sessionId, model }); return model },
        async modelCatalog() { return { groups: [] } },
        ...over.dispatcher,
      },
      testFiles: async () => [],
      warn() {},
      ...over,
    },
  }
}

/** 取工具面里某个工具的 execute。 */
function toolOf(tools, name) {
  const found = tools.find((tool) => tool.name === name)
  assert.ok(found !== undefined, '工具面里没有 ' + name)
  return found.execute
}

/** 造一个空账本批次（还没问过任何问题）。 */
async function emptyBatch(id) {
  const batch = blankBatch('工具面测试')
  batch.id = id
  batch.cwd = home
  await save(batch)
  return batch
}

/** 造一个已经过了设计闸门的批次。 */
async function readyBatch(id) {
  const batch = blankBatch('工具面测试')
  batch.id = id
  batch.cwd = home
  batch.status = 'approved'
  batch.questions = [
    { question: 'q1', answer: 'a1' },
    { question: 'q2', answer: 'a2' },
    { question: 'q3', answer: 'a3' },
  ]
  batch.plan = { steps: '一步', output: '产出' }
  batch.risks = [{
    id: 'R-1', title: '风险',
    trigger: '触发条件够长了', impact: '影响够长了',
    mitigation: '缓解够长了', verification: '人工核对：看一眼',
  }]
  batch.spec = { goal: '目标', nonGoals: [], acceptance: ['能跑通'] }
  batch.tickets = []
  await save(batch)
  return batch
}

// ── #1 String(undefined) 让整道设计闸门可被绕过 ──────────────────

test('design_question 不给 answer 时拒绝，不记成字符串 "undefined"', async () => {
  const batch = await emptyBatch('D-tool-q')
  const tools = buildTools(fakeFaces().faces)
  const result = await toolOf(tools, 'design_question')({ batchId: batch.id, question: 'q' })

  assert.equal(result.ok, false, '没给 answer 也记下来了')
  assert.equal(result.code, 'invalid-request')

  const saved = await load('D-tool-q')
  assert.equal(saved.questions.length, 0, '没给答案却记了一条问答')
})

test('design_question 不给 question 时也拒绝', async () => {
  const batch = await emptyBatch('D-tool-q2')
  const tools = buildTools(fakeFaces().faces)
  const result = await toolOf(tools, 'design_question')({ batchId: batch.id, answer: 'a' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid-request')
})

test('design_plan 不给 steps/output 时拒绝，不记成 "undefined"', async () => {
  const batch = await emptyBatch('D-tool-p')
  const tools = buildTools(fakeFaces().faces)
  const result = await toolOf(tools, 'design_plan')({ batchId: batch.id })

  assert.equal(result.ok, false, '没给 steps/output 也记下来了')
  assert.equal(result.code, 'invalid-request')

  const saved = await load('D-tool-p')
  assert.equal(saved.plan, undefined, '没给的规划却写进账本了')
})

test('三条空答案凑不出「已回答三个问题」', async () => {
  // 端到端：三条都不给 answer，再写一个空规划，然后试着派发。
  const batch = await emptyBatch('D-tool-bypass')
  const tools = buildTools(fakeFaces().faces)
  const ask = toolOf(tools, 'design_question')
  const plan = toolOf(tools, 'design_plan')

  for (let i = 0; i < 3; i++) {
    await ask({ batchId: batch.id, question: 'q' + i })
  }
  await plan({ batchId: batch.id })

  const saved = await load('D-tool-bypass')
  assert.equal(saved.questions.length, 0, '三条空问答被记下来了')
  assert.equal(saved.plan, undefined)
})

// ── #2 design_split 抹掉已派发的票 ──────────────────────────────

test('design_split 不许重新拆已经派出去的票', async () => {
  const batch = await readyBatch('D-tool-split')
  batch.tickets = [{
    id: 'T-1', title: '已派出', brief: 'b', blockedBy: [], riskIds: ['R-1'],
    riskFree: false, model: { provider: 'p', model: 'm' }, modelReason: 'r',
    status: 'suspended', childSessionId: 'session-live-1',
  }]
  await save(batch)

  const tools = buildTools(fakeFaces().faces)
  const result = await toolOf(tools, 'design_split')({
    batchId: batch.id,
    tickets: [{
      id: 'T-1', title: '改过了', brief: 'b2', blockedBy: [], riskIds: ['R-1'],
      model: { provider: 'p', model: 'm' }, modelReason: 'r',
    }],
  })

  assert.equal(result.ok, false, '重新拆已派出的票被放行了')
  assert.equal(result.code, 'split-blocked')

  const saved = await load('D-tool-split')
  assert.equal(saved.tickets[0].childSessionId, 'session-live-1', '子会话 id 被抹掉了')
  assert.equal(saved.tickets[0].status, 'suspended', '状态被重置了')
  assert.equal(saved.tickets[0].title, '已派出', '票被改掉了')
})

// ── #3 钉模型失败时留下孤儿会话 ─────────────────────────────────

test('钉模型失败时把刚建好的会话取消掉', async () => {
  const calls = []
  const dispatcher = {
    gateway: () => ({
      async invoke({ method, args }) {
        calls.push({ method, args })
        if (method === 'create') return { sessionId: 'session-orphan' }
        if (method === 'selectModel') throw new Error('宿主拒绝了这个模型')
        return {}
      },
    }),
    peer: () => ({ id: 'p' }),
    defaultModel: () => undefined,
    defaultModelSave: async () => {},
    warn() {},
  }
  const { createDispatcher } = await import('../lib/dispatch.js')
  const d = createDispatcher(dispatcher)

  await assert.rejects(
    () => d.spawn({
      id: 'T-1', title: 't', brief: 'b',
      model: { provider: 'p', model: 'no-such-model' },
    }, { cwd: home }),
    (error) => {
      assert.equal(error.code, 'model-pin-failed')
      return true
    },
  )

  const cancelled = calls.find((c) => c.method === 'cancel')
  assert.ok(cancelled !== undefined, '刚建好的会话没被取消——它成了还在计费的孤儿')
  assert.equal(cancelled.args.request.sessionId, 'session-orphan')
})

// ── #4 /feedback 谎报已送达 ────────────────────────────────────

test('批次没有主会话时，feedback 说清楚它哪儿也没送到', async () => {
  const batch = await readyBatch('D-tool-fb')
  batch.parentSessionId = undefined
  batch.tickets = [{
    id: 'T-1', title: '票', brief: 'b', blockedBy: [], riskIds: ['R-1'],
    riskFree: false, model: { provider: 'p', model: 'm' }, modelReason: 'r',
    status: 'suspended', childSessionId: 'session-c1',
  }]
  await save(batch)

  const { faces, calls } = fakeFaces()
  const routes = makeRoutes(faces)
  const feedback = routes.find((r) => r.path === '/whale-tail/api/feedback')

  const captured = { status: 0, body: null }
  await feedback.handler({
    method: 'POST',
    url: '/whale-tail/api/feedback',
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ batchId: batch.id, ticketId: 'T-1', message: '改一下' }), 'utf8')
    },
  }, {
    writeHead(status) { captured.status = status },
    end(text) { captured.body = JSON.parse(text) },
  })

  assert.notEqual(captured.body.deliveredTo, 'parent', '没送出去却报 parent')
  assert.equal(captured.body.deliveredTo, 'nowhere')
  assert.equal(calls.filter((c) => c.method === 'run').length, 0)
})

// ── #5 /retarget 忽略宿主真正选中的 ────────────────────────────

test('/retarget 写回宿主真正选中的，不是我们请求的', async () => {
  const batch = await readyBatch('D-tool-rt')
  batch.tickets = [{
    id: 'T-1', title: '票', brief: 'b', blockedBy: [], riskIds: ['R-1'],
    riskFree: false, model: { provider: 'p', model: 'm', reasoningEffort: 'high' },
    modelReason: 'r', status: 'suspended', childSessionId: 'session-c2',
  }]
  await save(batch)

  // 宿主会把模型 id 规范化，并在没指定强度时填它自己的默认值。
  const { faces } = fakeFaces({
    dispatcher: {
      async selectModel() {
        return { provider: 'p', model: 'm2-preview', reasoningEffort: 'medium' }
      },
    },
  })
  const routes = makeRoutes(faces)
  const retarget = routes.find((r) => r.path === '/whale-tail/api/retarget')

  await retarget.handler({
    method: 'POST',
    url: '/whale-tail/api/retarget',
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({
        batchId: batch.id, ticketId: 'T-1',
        model: { provider: 'p', model: 'm2' },
      }), 'utf8')
    },
  }, { writeHead() {}, end() {} })

  const saved = await load('D-tool-rt')
  // 宿主跑的是 m2-preview / medium，账本与卡片必须显示同一个。
  assert.equal(saved.tickets[0].model.model, 'm2-preview', '账本写的是我们请求的，不是宿主选的')
  assert.equal(saved.tickets[0].model.reasoningEffort, 'medium')
  assert.equal(saved.tickets[0].effort, 'medium')
})

// ── #6 各种畸形参数不该崩 ─────────────────────────────────────

test('畸形参数给可读拒绝，不崩', async () => {
  const batch = await readyBatch('D-tool-bad')
  const tools = buildTools(fakeFaces().faces)

  const cases = [
    ['design_answer', { batchId: batch.id, risk: null }, 'invalid-request'],
    ['design_split', { batchId: batch.id, tickets: 'not-an-array' }, 'invalid-request'],
    ['design_split', { batchId: batch.id, tickets: [null] }, 'invalid-request'],
    // 四栏不全的风险被拒，但那是 risk-incomplete，不是 invalid-request。
    ['design_answer', { batchId: batch.id, risk: { trigger: 'x' } }, 'risk-incomplete'],
  ]
  for (const [name, args, code] of cases) {
    const result = await toolOf(tools, name)(args)
    assert.equal(result.ok, false, name + ' 收下了畸形参数')
    assert.equal(result.code, code, name + ' 没给 ' + code)
  }
})

// ── #7 middleman_status 在批次缺 risks 时不崩 ──────────────────

test('middleman_status 在批次缺 risks 时不崩', async () => {
  const batch = blankBatch('缺字段')
  batch.id = 'D-tool-status'
  await save(batch)

  const tools = buildTools(fakeFaces().faces)
  const result = await toolOf(tools, 'middleman_status')({ batchId: 'D-tool-status' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.risks, [])
})

// ── #8 partial / failed 的票永久挡住后继 ───────────────────────

test('partial 与 failed 的票不再永久挡住后继', async () => {
  const { readyTickets } = await import('../lib/core.js')
  const ticket = (id, status, blockedBy) => ({
    id, title: id, brief: 'b', blockedBy, riskIds: ['R-1'], riskFree: false,
    model: { provider: 'p', model: 'm' }, modelReason: 'r', status,
  })

  for (const terminal of ['partial', 'failed', 'done', 'cancelled']) {
    const batch = { tickets: [ticket('T-1', terminal, []), ticket('T-2', 'pending', ['T-1'])] }
    const ready = readyTickets(batch).map((t) => t.id)
    assert.deepEqual(ready, ['T-2'], terminal + ' 的票把后继永久挡住了')
  }
})

// ── #9 risk 与 decisionId 同时给时静默丢掉决定 ──────────────────

test('risk 与 decisionId 同时给时拒绝，不静默丢掉决定', async () => {
  const batch = await readyBatch('D-tool-both')
  const tools = buildTools(fakeFaces().faces)
  const result = await toolOf(tools, 'design_answer')({
    batchId: batch.id,
    decisionId: 'D1',
    answer: '定了',
    risk: {
      title: '风险', trigger: '触发条件够长了', impact: '影响够长了',
      mitigation: '缓解够长了', verification: '人工核对：看一眼',
    },
  })

  assert.equal(result.ok, false, '两个都给了却静默丢掉一个')
  assert.equal(result.code, 'invalid-request')
})

test('清理临时目录', () => {
  rmSync(home, { recursive: true, force: true })
})

test('宿主不校验参数：九个工具收到任何畸形 args 都不许抛 TypeError', async () => {
  // 插件用裸 tools.register() 注册，宿主**不按 JSON Schema 校验参数**。
  // 模型传 null / undefined / 数字 / 字符串 / 数组都是可能的。
  //
  // 判据：要么正常返回，要么抛**可读的** MiddlemanError（带机器码）；
  // 抛 TypeError（比如 "Cannot read properties of null"）就是崩了。
  const { isMiddlemanError } = await import('../lib/refusals.js')
  const tools = buildTools(fakeFaces().faces)
  const badArgs = [null, undefined, 42, 'not-an-object', []]

  for (const definition of tools) {
    for (const bad of badArgs) {
      try {
        const result = await definition.execute(bad)
        // 正常返回也算过——但必须是带 ok 字段的形状，不能是 undefined。
        assert.equal(typeof result, 'object', definition.name + ' 返回了 ' + typeof result)
      } catch (error) {
        assert.ok(
          isMiddlemanError(error),
          definition.name + '(' + JSON.stringify(bad) + ') 抛了 ' + error.constructor.name
            + '：' + error.message + '（应当是带机器码的可读拒绝）',
        )
      }
    }
  }
})
