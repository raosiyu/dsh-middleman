/**
 * 七条路由，每一条都要真的被调用过。
 *
 * 为什么有这条：/retarget 从上线起就没跑通过——报错是
 * 「faces.dispatcher.selectModel is not a function」，dispatcher 里
 * 根本没这个方法。之所以能活这么久，是因为 host.test.mjs 只数了
 * 「有 7 条路由」，只有 /feedback 与 /run 两条被真正调用过。
 *
 * 所以这里把七条全调一遍，不许有「注册了但没跑」的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'mm-routes-'))
process.env.WT_HOME = home

const { makeRoutes } = await import('../lib/routes.js')
const { blankBatch, save, load } = await import('../lib/ledger.js')

/**
 * 造一个假请求与假响应。
 * @param {object} options - body、method、remoteAddress。
 */
function fakeReq(options = {}) {
  const body = options.body === undefined ? '' : JSON.stringify(options.body)
  return {
    method: options.method ?? 'POST',
    url: options.url ?? '/whale-tail/api/state',
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (body !== '') yield Buffer.from(body, 'utf8')
    },
  }
}

/**
 * 造一个假响应，收集状态码与 JSON 体。
 */
function fakeRes() {
  const captured = { status: 0, body: null }
  return {
    captured,
    writeHead(status) { captured.status = status },
    end(text) {
      captured.body = text === undefined || text === null ? null : JSON.parse(text)
    },
  }
}

/**
 * 造一批带票的批次。
 * @param {string} id - 批次 id。
 * @param {object} over - 票字段的覆盖。
 */
async function seedBatch(id, over = {}) {
  const batch = blankBatch('路由测试批次')
  batch.id = id
  batch.cwd = home
  batch.status = 'approved'
  batch.parentSessionId = 'session-parent-1'
  batch.questions = [{ question: 'q', answer: 'a' }, { question: 'q', answer: 'a' }, { question: 'q', answer: 'a' }]
  batch.plan = { steps: ['一'], output: '产出', parallel: '无' }
  batch.risks = [{
    id: 'R-1', title: '风险', trigger: '触发', impact: '影响',
    mitigation: '缓解', verification: '人工核对：看一眼',
  }]
  batch.tickets = [{
    id: 'T-1',
    title: '一张票',
    brief: '做点事',
    blockedBy: [],
    riskIds: ['R-1'],
    model: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
    modelReason: '快',
    source: '.scratch/x.md',
    payload: 'echo hi',
    effort: 'high',
    notes: { before: '先读 README', order: '先跑它', parallel: '无' },
    status: 'suspended',
    // 已经派出去的票：/run 与 /retarget 都要子会话 id。
    childSessionId: 'session-child-1',
    ...over,
  }]
  await save(batch)
  return batch
}

/**
 * 造一套路由与记录调用。
 * @param {object} dispatcher - 假派发面。
 */
function setup(dispatcher = {}) {
  const calls = []
  const faces = {
    dispatcher: {
      async run(sessionId, text) { calls.push({ method: 'run', sessionId, text }) },
      async steer(sessionId, text) { calls.push({ method: 'steer', sessionId, text }) },
      async cancel(sessionId) { calls.push({ method: 'cancel', sessionId }) },
      async selectModel(sessionId, model) {
        calls.push({ method: 'selectModel', sessionId, model })
        return model
      },
      async modelCatalog() { return { groups: [{ id: 'g', name: 'G', models: [] }] } },
      ...dispatcher,
    },
    warn() {},
  }
  const routes = makeRoutes(faces)
  const byPath = new Map(routes.map((route) => [route.path, route]))
  return { routes, byPath, calls }
}

/**
 * 调一条路由。
 * @param {object} route - 路由。
 * @param {object} options - 请求选项。
 */
async function call(route, options = {}) {
  const res = fakeRes()
  await route.handler(fakeReq(options), res)
  return res.captured
}

test('八条路由都在，而且每条都被真的调用过', async () => {
  const { routes, byPath, calls } = setup()
  // 先收敛再批准：/approve 只接受收敛后的批次。
  await seedBatch('D-routes-all', { status: 'converged' })

  const invoked = new Set()

  // 1. /state（全部）
  let r = await call(byPath.get('/whale-tail/api/state'), { method: 'GET', url: '/whale-tail/api/state' })
  assert.equal(r.status, 200)
  assert.ok(Array.isArray(r.body.batches))
  invoked.add('/state')

  // 2. /state（单个）
  r = await call(byPath.get('/whale-tail/api/state'), {
    method: 'GET', url: '/whale-tail/api/state?batchId=D-routes-all',
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.batch.id, 'D-routes-all')

  // 3. /approve
  r = await call(byPath.get('/whale-tail/api/approve'), { body: { batchId: 'D-routes-all' } })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  invoked.add('/approve')

  // 4. /run
  r = await call(byPath.get('/whale-tail/api/run'), {
    body: { batchId: 'D-routes-all', ticketId: 'T-1' },
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  invoked.add('/run')

  // 5. /feedback
  r = await call(byPath.get('/whale-tail/api/feedback'), {
    body: { batchId: 'D-routes-all', ticketId: 'T-1', message: '换个方向' },
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  invoked.add('/feedback')

  // 6. /retarget —— 这条就是漏测漏出 bug 的那条
  r = await call(byPath.get('/whale-tail/api/retarget'), {
    body: {
      batchId: 'D-routes-all',
      ticketId: 'T-1',
      model: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'medium' },
      modelReason: '换个模型',
    },
  })
  assert.equal(r.status, 200, '/retarget 应当成功，实际：' + JSON.stringify(r.body))
  assert.equal(r.body.ok, true)
  invoked.add('/retarget')

  // 7. /cancel
  r = await call(byPath.get('/whale-tail/api/cancel'), {
    body: { batchId: 'D-routes-all', ticketId: 'T-1' },
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  invoked.add('/cancel')

  // 8. /models
  r = await call(byPath.get('/whale-tail/api/models'), { method: 'GET' })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  invoked.add('/models')

  // 9. /answer —— 先把票做成「在等人」，再答它。
  //
  // 这条必须是**真的调用**：新加一条路由却没人调过，等于它能坏而
  // 没人知道——这正是本文件存在的理由（上一版有条路由调了个不存在
  // 的方法，全绿，因为没人真的调它）。
  {
    const { load, save } = await import('../lib/ledger.js')
    const batch = await load('D-routes-all')
    batch.tickets = [{
      id: 'T-1', title: '票', brief: 'b', blockedBy: [], riskIds: [], riskFree: true,
      riskFreeReason: '只是路由测试', model: { provider: 'p', model: 'm' },
      modelReason: 'r', status: 'waiting', childSessionId: 'session-routes-answer',
      waiting: { question: '要 A 还是 B？', askedAt: Date.now(), sessionId: 'session-routes-answer' },
    }]
    await save(batch)
  }
  r = await call(byPath.get('/whale-tail/api/answer'), {
    body: { batchId: 'D-routes-all', ticketId: 'T-1', answer: 'A' },
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.status, 'running')
  invoked.add('/answer')

  // 每条都被调到了。
  assert.equal(routes.length, 8)
  for (const path of routes.map((route) => route.path)) {
    assert.ok(invoked.has(path.replace('/whale-tail/api', '')), '这条路由从没被调用过：' + path)
  }
})

test('/retarget 真的会去改子会话的模型', async () => {
  const { byPath, calls } = setup()
  await seedBatch('D-routes-retarget', { childSessionId: 'session-child-9' })

  const r = await call(byPath.get('/whale-tail/api/retarget'), {
    body: {
      batchId: 'D-routes-retarget',
      ticketId: 'T-1',
      model: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'medium' },
    },
  })

  assert.equal(r.status, 200)
  const select = calls.find((c) => c.method === 'selectModel')
  assert.ok(select !== undefined, '没有去改子会话的模型')
  assert.equal(select.sessionId, 'session-child-9')
  assert.equal(select.model.reasoningEffort, 'medium')
})

test('/retarget 之后账本上的模型与强度都改了', async () => {
  const { byPath } = setup()
  await seedBatch('D-routes-retarget2', { childSessionId: 'session-child-10' })

  await call(byPath.get('/whale-tail/api/retarget'), {
    body: {
      batchId: 'D-routes-retarget2',
      ticketId: 'T-1',
      model: { provider: 'workbuddy', model: 'glm-5.3', reasoningEffort: 'low' },
    },
  })

  const saved = await load('D-routes-retarget2')
  const ticket = saved.tickets[0]
  assert.equal(ticket.model.model, 'glm-5.3')
  assert.equal(ticket.model.reasoningEffort, 'low')
  // 强度只有一个真相来源：effort 必须跟着 model 走。
  assert.equal(ticket.effort, 'low', 'effort 没跟着 model.reasoningEffort 走，两个字段会分叉')
})

test('/retarget 钉不上模型时不装作成功', async () => {
  const { byPath } = setup({
    async selectModel() { throw new Error('网关拒绝了这个模型') },
  })
  await seedBatch('D-routes-retarget3', { childSessionId: 'session-child-11' })

  const r = await call(byPath.get('/whale-tail/api/retarget'), {
    body: {
      batchId: 'D-routes-retarget3',
      ticketId: 'T-1',
      model: { provider: 'x', model: 'y' },
    },
  })

  assert.notEqual(r.status, 200, '钉不上却回 200，等于账本改了、实际没改')
  assert.equal(r.body.ok, false)

  // 账本不能被改成新模型——否则卡片显示的与子会话跑的又对不上。
  const saved = await load('D-routes-retarget3')
  assert.equal(saved.tickets[0].model.model, 'deepseek-v4.1-flash', '失败的换模型却把账本改了')
})

test('/retarget 不带 model 时拒绝', async () => {
  const { byPath } = setup()
  await seedBatch('D-routes-retarget4')
  const r = await call(byPath.get('/whale-tail/api/retarget'), {
    body: { batchId: 'D-routes-retarget4', ticketId: 'T-1' },
  })
  assert.equal(r.status, 400)
  assert.equal(r.body.code, 'invalid-request')
})

test('/retarget 在票还没派出去时只改账本', async () => {
  const { byPath, calls } = setup()
  // 还没派出去的票没有子会话 id。
  await seedBatch('D-routes-retarget5', { childSessionId: undefined })

  const r = await call(byPath.get('/whale-tail/api/retarget'), {
    body: {
      batchId: 'D-routes-retarget5',
      ticketId: 'T-1',
      model: { provider: 'workbuddy', model: 'glm-5.3', reasoningEffort: 'low' },
    },
  })

  assert.equal(r.status, 200)
  assert.equal(calls.filter((c) => c.method === 'selectModel').length, 0, '还没建会话，不该去钉模型')
  const saved = await load('D-routes-retarget5')
  assert.equal(saved.tickets[0].model.model, 'glm-5.3')
})

test('非环回连接一律拒绝', async () => {
  const { byPath } = setup()
  await seedBatch('D-routes-fence')
  const r = await call(byPath.get('/whale-tail/api/state'), {
    method: 'GET',
    remoteAddress: '203.0.113.9',
  })
  assert.equal(r.status, 403)
  assert.equal(r.body.code, 'forbidden')
})

test('不存在的批次给的是可读的拒绝，不是 500', async () => {
  const { byPath } = setup()
  const r = await call(byPath.get('/whale-tail/api/feedback'), {
    body: { batchId: 'D-does-not-exist', ticketId: 'T-1', message: 'x' },
  })
  assert.notEqual(r.status, 500, '批次不存在不该报 500')
  assert.equal(r.body.ok, false)
})

test('派发面上真的有 selectModel 这个方法', async () => {
  // 这条是给 /retarget 兜底的。
  //
  // 上面那些路由测试用的都是假派发面——路由只要调了 faces.dispatcher.selectModel
  // 就过，哪怕真派发面上根本没有这个方法。这正是那个 bug 活下来的原因：
  // 「faces.dispatcher.selectModel is not a function」。
  //
  // 所以这里对着**真的** createDispatcher 检查：路由调用的每一个方法，
  // 真派发面上都必须有。
  const { createDispatcher } = await import('../lib/dispatch.js')
  const dispatcher = createDispatcher({
    gateway: () => ({ invoke: async () => ({}) }),
    peer: () => ({ id: 'peer-1' }),
    defaultModel: () => undefined,
    warn() {},
  })

  const source = readFileSync(new URL('../lib/routes.js', import.meta.url), 'utf8')
  const used = new Set([...source.matchAll(/faces\.dispatcher\.(\w+)/g)].map((m) => m[1]))

  assert.ok(used.size >= 4, '没从路由里抠出 dispatcher 方法名，实际：' + [...used].join(','))

  for (const name of used) {
    assert.equal(
      typeof dispatcher[name],
      'function',
      '路由调用了 faces.dispatcher.' + name + '，但真派发面上没有这个方法',
    )
  }
})

test('真派发面的 selectModel 真的会去网关钉模型，并恢复默认模型', async () => {
  // 光「方法存在」不够——它还得真的干对事：
  //   - 传 session.selectModel，参数里带 provider / model / reasoningEffort
  //   - 换完把全局默认模型恢复回去（selectModel 有个副作用会改全局默认）
  const { createDispatcher } = await import('../lib/dispatch.js')
  const calls = []
  const saved = []

  const dispatcher = createDispatcher({
    gateway: () => ({
      async invoke({ namespace, method, args, peer, signal }) {
        calls.push({ namespace, method, args, peer, signal })
        if (method === 'selectModel') return { selected: { ...args.request, ok: true } }
        return {}
      },
    }),
    peer: () => ({ id: 'peer-1' }),
    defaultModel: () => ({ provider: 'old-p', model: 'old-m' }),
    defaultModelSave: async (value) => { saved.push(value) },
    warn() {},
  })

  const result = await dispatcher.selectModel('session-x', {
    provider: 'workbuddy',
    model: 'deepseek-v4.1-flash',
    reasoningEffort: 'medium',
  })

  const select = calls.find((c) => c.method === 'selectModel')
  assert.ok(select !== undefined, '没有去网关钉模型')
  assert.equal(select.namespace, 'session')
  assert.deepEqual(select.args.request, {
    sessionId: 'session-x',
    provider: 'workbuddy',
    model: 'deepseek-v4.1-flash',
    reasoningEffort: 'medium',
  })
  assert.ok(select.signal !== undefined, '网关需要 signal，不给它会抛 aborted')
  assert.ok(select.peer !== undefined, '网关需要 peer')

  // 默认模型被恢复了。
  assert.equal(saved.length, 1, '换完模型没有恢复全局默认模型')
  assert.deepEqual(saved[0], { provider: 'old-p', model: 'old-m' })

  assert.equal(result.model, 'deepseek-v4.1-flash')
})

test('钉模型失败时不装作成功', async () => {
  const { createDispatcher } = await import('../lib/dispatch.js')
  const dispatcher = createDispatcher({
    gateway: () => ({
      async invoke({ method }) {
        if (method === 'selectModel') throw new Error('网关拒绝了这个模型')
        return {}
      },
    }),
    peer: () => ({ id: 'peer-1' }),
    defaultModel: () => undefined,
    warn() {},
  })

  await assert.rejects(
    () => dispatcher.selectModel('session-y', { model: 'nope' }),
    (error) => {
      assert.equal(error.code, 'model-pin-failed')
      return true
    },
  )
})

test('清理临时目录', () => {
  rmSync(home, { recursive: true, force: true })
})

test('/feedback 在子会话跑着的时候直接 steer 它', async () => {
  // 人看到子会话跑偏了，当场就该能拉回来，不用等它跑完再返工。
  const { byPath, calls } = setup()
  await seedBatch('D-feedback-running', { status: 'running' })

  const r = await call(byPath.get('/whale-tail/api/feedback'), {
    body: { batchId: 'D-feedback-running', ticketId: 'T-1', message: '方向反了，先看 README' },
  })

  assert.equal(r.status, 200)
  assert.equal(r.body.deliveredTo, 'child')
  const steer = calls.find((c) => c.method === 'steer')
  assert.ok(steer !== undefined, '没有 steer 子会话')
  assert.equal(steer.sessionId, 'session-child-1')
  assert.equal(steer.text, '方向反了，先看 README')
  // 不该同时推给主会话——那是「票还没跑」时的事。
  assert.equal(calls.filter((c) => c.method === 'run').length, 0, '不该同时推给主会话')
})

test('/feedback 在票还挂着的时候推给主会话', async () => {
  const { byPath, calls } = setup()
  await seedBatch('D-feedback-suspended', { status: 'suspended' })

  const r = await call(byPath.get('/whale-tail/api/feedback'), {
    body: { batchId: 'D-feedback-suspended', ticketId: 'T-1', message: '换个方向' },
  })

  assert.equal(r.status, 200)
  assert.equal(r.body.deliveredTo, 'parent')
  assert.equal(calls.filter((c) => c.method === 'steer').length, 0, '还没跑的票没有活着的子会话可 steer')
  const run = calls.find((c) => c.method === 'run')
  assert.ok(run !== undefined, '没有推给主会话')
  assert.equal(run.sessionId, 'session-parent-1')
  assert.match(run.text, /\[工单修改意见\] T-1/)
})

test('/feedback steer 失败时不装作送到了', async () => {
  const { byPath } = setup({
    async steer() { throw new Error('网关拒绝了这个 steer') },
  })
  await seedBatch('D-feedback-steer-fail', { status: 'running' })

  const r = await call(byPath.get('/whale-tail/api/feedback'), {
    body: { batchId: 'D-feedback-steer-fail', ticketId: 'T-1', message: 'x' },
  })

  assert.notEqual(r.status, 200, 'steer 失败却回 200，人以为说到了其实没送到')
  assert.equal(r.body.ok, false)
  assert.equal(r.body.code, 'steer-failed')
})

test('意见为空时拒绝', async () => {
  const { byPath } = setup()
  await seedBatch('D-feedback-empty')
  const r = await call(byPath.get('/whale-tail/api/feedback'), {
    body: { batchId: 'D-feedback-empty', ticketId: 'T-1', message: '   ' },
  })
  assert.equal(r.status, 400)
  assert.equal(r.body.code, 'invalid-request')
})
