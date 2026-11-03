/**
 * 「请确认」通道：子会话能停下来等人，人答一句它接着跑。
 *
 * 这是这轮新加的能力。之前的缺口是：
 *
 *   子会话遇到需要人拍板的地方，没有通道可走。它只能硬着头皮猜，
 *   或者跑错了被观察器记成 failed——「等你」和「失败了」是两回事，
 *   混在一起的话，人也会开始忽略失败通知。
 *
 * 三条要钉住的：
 * 1. 子会话能把它停下（票变 waiting，不是 failed）。
 * 2. 人答完能把它续上（票回 running，答案真的送进去了）。
 * 3. 送失败时**不改状态**——先送再改，否则台账会说「在跑」而其实没收到。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'mm-confirm-'))
process.env.MM_HOME = home

const { buildTools } = await import('../lib/tools.js')
const { blankBatch, save, load } = await import('../lib/ledger.js')
const { makeRoutes } = await import('../lib/routes.js')
const { waitingTickets, readyTickets, isTerminalStatus, isWaitingForHuman, TICKET_STATUS } =
  await import('../lib/core.js')

/** 造一个已派发、子会话在跑、会停下来的票。 */
async function dispatchedBatch(id, { sessionId = 'session-child-1' } = {}) {
  const batch = blankBatch('请确认测试')
  batch.id = id
  batch.cwd = home
  batch.status = 'approved'
  batch.questions = [1, 2, 3].map((i) => ({ question: 'q' + i, answer: 'a' + i }))
  batch.plan = { steps: '一步', output: '产出' }
  batch.risks = [{
    id: 'R-1', title: '风险',
    trigger: '触发条件够长了', impact: '影响够长了',
    mitigation: '缓解够长了', verification: '人工核对：看一眼',
  }]
  batch.spec = { goal: 'g', nonGoals: [], acceptance: ['ok'] }
  batch.tickets = [{
    id: 'T-1', title: '会停下来的票', brief: '做到一半要问人',
    blockedBy: [], riskIds: ['R-1'], riskFree: false,
    model: { provider: 'p', model: 'm' }, modelReason: '够用',
    status: 'running', childSessionId: sessionId,
  }]
  await save(batch)
  return batch
}

/** 造一个带 confirmations 面的假宿主。 */
function facesWith(over = {}) {
  const runs = []
  const faces = {
    dispatcher: {
      async spawn(t) { return { sessionId: 's-new', model: t.model } },
      async run(sessionId, text) { runs.push({ sessionId, text }) },
      async steer(sessionId, text) { runs.push({ sessionId, text, mode: 'steer' }) },
      async cancel() {},
      async selectModel(id, m) { return m },
      async modelCatalog() { return { groups: [] } },
      ...over.dispatcher,
    },
    testFiles: async () => [],
    warn() {},
    ...over,
  }
  // confirmations 要能按 sessionId 反查——这里用真台账扫，跟线上一样。
  faces.confirmations = {
    async find(sessionId) {
      const { list } = await import('../lib/ledger.js')
      for (const row of await list()) {
        const batch = await load(row.id)
        const ticket = (batch.tickets ?? []).find((t) => t.childSessionId === sessionId)
        if (ticket !== undefined) return { batch, ticket }
      }
      return undefined
    },
  }
  return { faces, runs }
}

/** 调一个路由。 */
async function call(route, body) {
  const captured = { status: 0, body: null }
  await route.handler({
    method: 'POST',
    url: '',
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body), 'utf8') },
  }, {
    writeHead(status) { captured.status = status },
    end(text) { captured.body = JSON.parse(text) },
  })
  return captured
}

const routeOf = (faces, path) =>
  makeRoutes(faces).find((r) => r.path === '/dsh-middleman/api' + path)

// ── 状态语义 ──────────────────────────────────────────────────

test('waiting 不是终态，也不该被当成失败', () => {
  assert.equal(isTerminalStatus(TICKET_STATUS.waiting), false, 'waiting 被当成终态了')
  assert.equal(isTerminalStatus(TICKET_STATUS.failed), true)
  assert.equal(isWaitingForHuman({ status: 'waiting' }), true)
  assert.equal(isWaitingForHuman({ status: 'running' }), false)
})

test('在等人的票能被单独找出来', () => {
  const batch = {
    tickets: [
      { id: 'T-1', status: 'waiting' },
      { id: 'T-2', status: 'running' },
      { id: 'T-3', status: 'waiting' },
    ],
  }
  assert.deepEqual(waitingTickets(batch).map((t) => t.id), ['T-1', 'T-3'])
})

test('在等人的票不会挡住后继（它是停着，不是失败）', () => {
  // 关键区别：一张票在等人时，它的后继不该被解开——因为活还没干完。
  // 但它也不该让后继**永久**被卡住到人回答之后也解不开。
  const batch = {
    tickets: [
      { id: 'T-1', status: 'waiting' },
      { id: 'T-2', status: 'pending', blockedBy: ['T-1'] },
    ],
  }
  // 人还没答，T-1 没完成 → T-2 不能开始。
  assert.deepEqual(readyTickets(batch).map((t) => t.id), [])

  // 人答完之后 T-1 变 done，T-2 就能开始了。
  batch.tickets[0].status = 'done'
  assert.deepEqual(readyTickets(batch).map((t) => t.id), ['T-2'])
})

// ── 子会话停下来 ──────────────────────────────────────────────

test('子会话调 request_confirmation 后票变成 waiting', async () => {
  await dispatchedBatch('D-c1')
  const { faces } = facesWith()
  const tools = buildTools(faces)
  const ask = tools.find((t) => t.name === 'request_confirmation').execute

  const result = await ask(
    {
      question: '要用 SQLite 还是 JSON 文件存？',
      options: ['SQLite', 'JSON 文件'],
      recommendation: 'JSON——数据量小，不用为它引依赖',
    },
    { agent: { session: { id: 'session-child-1' } } },
  )

  assert.equal(result.ok, true)
  assert.equal(result.mode, 'blocking')
  assert.equal(result.status, 'waiting')

  const saved = await load('D-c1')
  assert.equal(saved.tickets[0].status, 'waiting')
  assert.equal(saved.tickets[0].waiting.question, '要用 SQLite 还是 JSON 文件存？')
  assert.deepEqual(saved.tickets[0].waiting.options, ['SQLite', 'JSON 文件'])
  assert.equal(saved.tickets[0].waiting.sessionId, 'session-child-1')
})

test('不在子会话里调这个工具会被拒，而不是乱标记一张票', async () => {
  await dispatchedBatch('D-c2')
  const { faces } = facesWith()
  const ask = buildTools(faces).find((t) => t.name === 'request_confirmation').execute

  const result = await ask({ question: '这样可以吗' }, { agent: { session: { id: 'session-not-a-ticket' } } })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'not-a-dispatched-ticket')

  const saved = await load('D-c2')
  assert.equal(saved.tickets[0].status, 'running', '不该乱改别人的票')
})

test('non-blocking 的请示只留记录，不打断', async () => {
  await dispatchedBatch('D-c3')
  const { faces } = facesWith()
  const ask = buildTools(faces).find((t) => t.name === 'request_confirmation').execute

  const result = await ask(
    { question: '我按 JSON 做了，你有意见再说', blocking: false },
    { agent: { session: { id: 'session-child-1' } } },
  )
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'advisory')

  const saved = await load('D-c3')
  assert.equal(saved.tickets[0].status, 'running', 'non-blocking 不该把票停下')
  assert.equal(saved.tickets[0].consultations.length, 1)
})

// ── 人回答，它接着跑 ──────────────────────────────────────────

test('人答完之后票回 running，答案真的送进了子会话', async () => {
  const batch = await dispatchedBatch('D-c4')
  batch.tickets[0].status = 'waiting'
  batch.tickets[0].waiting = {
    question: '要用 SQLite 还是 JSON？', options: ['SQLite', 'JSON'],
    askedAt: Date.now(), sessionId: 'session-child-1',
  }
  await save(batch)

  const { faces, runs } = facesWith()
  const answer = routeOf(faces, '/answer')
  const result = await call(answer, { batchId: 'D-c4', ticketId: 'T-1', answer: '用 JSON' })

  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.status, 'running')

  // 答案得真的送到那个子会话，而且带上了问题上下文。
  assert.equal(runs.length, 1, '答案没送出去')
  assert.equal(runs[0].sessionId, 'session-child-1')
  assert.match(runs[0].text, /用 JSON/)
  assert.match(runs[0].text, /要用 SQLite 还是 JSON？/, '没把问题带过去，子会话不知道在答什么')

  const saved = await load('D-c4')
  assert.equal(saved.tickets[0].status, 'running')
  assert.equal(saved.tickets[0].waiting, undefined, 'waiting 没有清掉，会一直显示在等人')
  assert.equal(saved.tickets[0].answers.length, 1)
  assert.equal(saved.tickets[0].answers[0].answer, '用 JSON')
})

test('送不到子会话时不改状态——不能让台账说「在跑」而其实没收到', async () => {
  const batch = await dispatchedBatch('D-c5')
  batch.tickets[0].status = 'waiting'
  batch.tickets[0].waiting = { question: 'q', askedAt: Date.now(), sessionId: 'session-child-1' }
  await save(batch)

  const { faces } = facesWith({
    dispatcher: {
      async run() { throw new Error('会话已关闭') },
      async spawn() { return { sessionId: 's' } },
      async steer() {}, async cancel() {},
      async selectModel(id, m) { return m },
      async modelCatalog() { return { groups: [] } },
    },
  })
  const result = await call(routeOf(faces, '/answer'),
    { batchId: 'D-c5', ticketId: 'T-1', answer: '用 JSON' })

  assert.equal(result.status, 502)
  assert.equal(result.body.code, 'deliver-failed')

  const saved = await load('D-c5')
  assert.equal(saved.tickets[0].status, 'waiting', '送失败却把状态改了——台账会谎报')
  assert.notEqual(saved.tickets[0].waiting, undefined, 'waiting 被清了，人以为答过了')
  // 答案也不该被记下来：没送到的答复不是答复。
  assert.equal(saved.tickets[0].answers, undefined, '没送出去的答复却被记成了已答')
})

test('给不在等人的票作答会被拒', async () => {
  await dispatchedBatch('D-c6')
  const { faces } = facesWith()
  const result = await call(routeOf(faces, '/answer'),
    { batchId: 'D-c6', ticketId: 'T-1', answer: '随便' })
  assert.equal(result.status, 409)
  assert.equal(result.body.code, 'not-waiting')
})

test('空回答会被拒', async () => {
  const batch = await dispatchedBatch('D-c7')
  batch.tickets[0].status = 'waiting'
  batch.tickets[0].waiting = { question: 'q', askedAt: Date.now(), sessionId: 'session-child-1' }
  await save(batch)

  const { faces } = facesWith()
  const result = await call(routeOf(faces, '/answer'),
    { batchId: 'D-c7', ticketId: 'T-1', answer: '   ' })
  assert.equal(result.status, 400)
  assert.equal(result.body.code, 'invalid-request')
})

test('清理临时目录', () => {
  rmSync(home, { recursive: true, force: true })
})

test('回答路由的顺序：先送出去，再改状态（写在代码结构上钉住）', () => {
  // 为什么用代码结构而不是行为来钉这一条：
  //
  // 行为测不出来。把 `ticket.status = 'running'` 提到 await run() 之前，
  // run 抛错后函数直接 return 了——那条路径上根本不调 save()，所以磁盘
  // 上的票还是 waiting，行为断言照样绿。我试过两种变异，都是绿的。
  //
  // 但「先改状态再送」这个写法是真的危险：哪天有人在 return 之前加了
  // 一句 save（很自然的防御性写法），台账就会谎报「在跑」。所以把顺序
  // 钉在源码结构上——run 必须先于那次赋值出现。
  const source = readFileSync(new URL('../lib/routes.js', import.meta.url), 'utf8')
  const answerBlock = source.split("/answer'")[1]
  assert.ok(answerBlock !== undefined, '没找到 /answer 那段')

  const runAt = answerBlock.indexOf('faces.dispatcher.run(')
  const assignAt = answerBlock.indexOf("ticket.status = 'running'")
  assert.ok(runAt >= 0, '/answer 里没有调用 dispatcher.run')
  assert.ok(assignAt >= 0, '/answer 里没有把状态改成 running')
  assert.ok(
    runAt < assignAt,
    '先改了状态才送答案——送失败时台账会谎报「在跑」。要把 dispatcher.run 放到赋值之前',
  )
})
