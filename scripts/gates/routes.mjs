/**
 * 拒绝闸门的探针：每道探针都同时盯住两件事。
 *
 * 1. **源码锚点**——那段 `refuse(...)` 调用还在不在。把一条拒绝删掉，
 *    探针立刻报破。
 * 2. **行为**——真的调一次路由，断言状态码与机器码，并且断言
 *    **副作用没有发生**：该拒的不能改台账、不能往子会话里发东西。
 *
 * 为什么两件都要：只查源码挡不住「写了但顺序不对」，只查行为挡不住
 * 「拒绝还在，但状态码悄悄从 404 漂成 409」——后者是最难发现的一类，
 * 因为两边各自都「看起来没问题」。
 *
 * 台账全部落在 `mkdtempSync(join(tmpdir(), 'mm-check-'))` 里，探针之间
 * 用各自的临时目录，跑完就删。**绝不碰用户的 ~/.dsh**——每个探针在动
 * 台账之前先验一次 `home()` 落在临时目录里，不对就当场停下。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import { makeRoutes } from '../../lib/routes.js'
import { statusForCode } from '../../lib/refusals.js'
import { blankBatch, home, load, save } from '../../lib/ledger.js'

const ROUTES_URL = new URL('../../lib/routes.js', import.meta.url)

/**
 * 每次重新读源码：探针跑的时候看到的永远是盘上那一份，不是导入时的快照。
 * 做「删了会报破」的实验时这一点很关键——改完文件不用重启进程。
 */
function routesSource() {
  return readFileSync(ROUTES_URL, 'utf8')
}

/** 破了就用这句中文说明报破。 */
function check(condition, message) {
  if (!condition) throw new Error(message)
}

/** 源码里必须还能匹配到这段。 */
function anchor(source, pattern, message) {
  if (!pattern.test(source)) {
    throw new Error(message + '（源码里已经找不到这段：' + pattern + '）')
  }
}

/** 某个下标在第几行——报破时说清位置，别让人自己去翻。 */
function lineAt(text, index) {
  return text.slice(0, index).split('\n').length
}

// ── 假宿主与假请求（照 test/routes.test.mjs、test/confirmation.test.mjs 的形状）──

/**
 * 造一个假请求。
 *
 * `raw` 给的是原样字符串（用来造非法 JSON 与超大请求体），
 * `body` 会被 JSON.stringify——跟真浏览器发的一样。
 */
function fakeReq(options = {}) {
  const payload = options.raw !== undefined
    ? options.raw
    : (options.body === undefined ? '' : JSON.stringify(options.body))
  return {
    method: options.method ?? 'POST',
    url: options.url ?? '/whale-tail/api/state',
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (payload !== '') yield Buffer.from(payload, 'utf8')
    },
  }
}

/** 造一个假响应，收集状态码与解析后的 JSON 体。 */
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

/** 调一个路由，返回 {status, body}。 */
async function call(route, options = {}) {
  const res = fakeRes()
  await route.handler(fakeReq(options), res)
  return res.captured
}

/** 按路径取一条路由。 */
function routeOf(faces, path) {
  const route = makeRoutes(faces).find((candidate) => candidate.path === '/whale-tail/api' + path)
  check(route !== undefined, '没有这条路由：/whale-tail/api' + path + '——它被改名或删掉了')
  return route
}

/**
 * 造一套假派发面，并把每一次调用记进数组。
 *
 * 「送信 0 次」这类断言全靠这个数组：拒绝如果还是偷偷调了 run/steer，
 * 数组里就会出现一条，探针立刻报破。
 */
function facesWith(over = {}) {
  const calls = []
  const faces = {
    dispatcher: {
      async spawn(ticket) {
        calls.push({ method: 'spawn', ticket })
        return { sessionId: 'session-spawned', model: ticket?.model }
      },
      async run(sessionId, text) { calls.push({ method: 'run', sessionId, text }) },
      async steer(sessionId, text) { calls.push({ method: 'steer', sessionId, text }) },
      async cancel(sessionId) { calls.push({ method: 'cancel', sessionId }) },
      async selectModel(sessionId, model) {
        calls.push({ method: 'selectModel', sessionId, model })
        return model
      },
      async modelCatalog() { return { groups: [] } },
      ...over.dispatcher,
    },
    testFiles: async () => [],
    warn(message) { calls.push({ method: 'warn', message }) },
  }
  return { faces, calls }
}

/** 数某个方法被调了几次。 */
const countOf = (calls, method) => calls.filter((entry) => entry.method === method).length

// ── 台账：自己的临时目录，探针之间互不干扰 ──────────────────────

/**
 * 在一个临时台账目录里跑一段。
 *
 * 出来之前一定把 WT_HOME 恢复原样、目录删掉：探针不能给下一个探针
 * 留状态，更不能把东西留在盘上。
 */
async function withHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mm-check-'))
  const area = resolve(tmpdir()) + sep
  check(resolve(dir).startsWith(area), '临时台账目录不在 tmpdir 下，拒绝继续：' + dir)

  const previous = process.env.WT_HOME
  process.env.WT_HOME = dir
  try {
    // 动任何东西之前先验一次：台账真的落在这个临时目录里。
    check(
      resolve(home()) === resolve(dir),
      '台账没落到临时目录（实际：' + home() + '）——探针会写进用户目录，当场停下',
    )
    return await fn(dir)
  } finally {
    if (previous === undefined) delete process.env.WT_HOME
    else process.env.WT_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * 造一个已批准的批次带一张票。
 *
 * 形状抄 test/confirmation.test.mjs 的 `dispatchedBatch()`：三个已回答的
 * 问题、流程规划、四栏齐全的风险、规格——这样探针测的是**路由的拒绝**，
 * 而不是碰巧被设计闸门挡住了。
 */
async function seedBatch(id, over = {}) {
  const batch = blankBatch('探针批次')
  batch.id = id
  batch.cwd = home()
  batch.status = 'approved'
  batch.parentSessionId = 'session-parent-probe'
  batch.questions = [1, 2, 3].map((i) => ({
    question: '第 ' + i + ' 个问题？',
    answer: '第 ' + i + ' 个答案',
    kind: 'design',
  }))
  batch.plan = { steps: '一步', output: '一份产出', parallel: '无' }
  batch.risks = [{
    id: 'R-1',
    title: '风险',
    trigger: '触发条件写长一点',
    impact: '影响写长一点',
    mitigation: '缓解写长一点',
    verification: '人工核对：看一眼探针输出',
  }]
  batch.spec = { goal: '一个目标', nonGoals: [], acceptance: ['能跑出红绿'] }
  batch.tickets = [{
    id: 'T-1',
    title: '一张票',
    brief: '做点事',
    blockedBy: [],
    riskIds: ['R-1'],
    riskFree: false,
    model: { provider: 'probe-provider', model: 'probe-model' },
    modelReason: '够用',
    source: '.scratch/probe.md',
    payload: 'echo hi',
    effort: 'medium',
    notes: { before: '先读 README', order: '先跑它', parallel: '无' },
    status: 'suspended',
    childSessionId: 'session-child-probe',
    ...over,
  }]
  await save(batch)
  return batch
}

/**
 * 断言一个拒绝的**形状**：{ok:false, code, error}，而且不吐栈。
 *
 * 字段名是 **error**（lib/routes.js 的 refuse 本体 + 客户端读 result.error），
 * 不是 message。这里只认 error——真有人把它改成 message，浏览器上那张
 * 卡片会开始弹「操作失败」而不是原因，正是要拦的。
 */
function assertRefusalShape(body, expectCode, where) {
  check(body !== null && typeof body === 'object', where + '：响应体不是 JSON 对象')
  check(body.ok === false, where + '：拒绝的 ok 必须是 false，实际：' + JSON.stringify(body.ok))
  check(typeof body.code === 'string' && body.code !== '', where + '：拒绝必须带机器码 code')
  check(body.code === expectCode, where + '：机器码对不上，期望 ' + expectCode + '，实际 ' + body.code)
  check(
    typeof body.error === 'string' && body.error.trim() !== '',
    where + '：拒绝必须带一句给人看的话（字段名是 error）',
  )
  check(!/\n\s+at\s/.test(body.error), where + '：拒绝里带了栈——它只该是一句有界的话')
}

/**
 * 策略类拒绝：拦的是「这个操作不该做」，状态码由 statusForCode 决定。
 *
 * 这份清单必须**正好**等于下面这些——多一个（新加的策略码忘了登记）
 * 少一个（某个策略码从路由里消失了）都报破。两组之外没有第三种。
 */
const STRATEGY_CODES = [
  'batch-missing',
  'ticket-missing',
  'invalid-request',
  'batch-unreadable',
  'not-converged',
  'not-dispatched',
  'already-running',
  'not-waiting',
  'no-session',
]

/**
 * 从不写死在 routes.js 里、只经 statusForCode 映射的码。
 *
 * batch-missing / batch-unreadable 是台账 load() 抛的，路由层那圈
 * catch 用 statusForCode 把它翻成 404/503——所以它们不会出现在
 * `refuse(res, NNN, ...)` 的硬编码里，但仍然是策略码。
 */
const DYNAMIC_STRATEGY_CODES = ['batch-missing', 'batch-unreadable']

/**
 * 豁免清单：**故意**不走 statusForCode 的拒绝。
 *
 * 它们不是「策略拒绝」，而是围栏与传输层故障——statusForCode 那张表
 * 只回答「用户能不能自己修」，而这几条回答的是另一个问题：
 * 403 是「你不是本机」，500 是「我们自己炸了」，502 是「对面没接住」。
 * 硬套 409 会把「重试」和「改输入」混成同一件事。
 */
const STATUS_OVERRIDES = new Map([
  ['forbidden', 403],       // 围栏：只接受环回连接
  ['internal', 500],        // 我们自己的 bug，不是用户的输入问题
  ['steer-failed', 502],    // 上游没接住，可能重试就好
  ['model-pin-failed', 502], // 同上
  ['deliver-failed', 502],  // 同上
])

// ── 探针 ──────────────────────────────────────────────────────

export const routeGates = [
  /**
   * 拒绝的形状 + 写死的状态码与映射表是否一致。
   *
   * 这条盯的是最容易漂的那种毛病：routes.js 里写着 409，而
   * refusals.js 的 statusForCode 说这个码该是 404——两边各自都「看起来
   * 没问题」，可面板上人看到的是 409，客户端就按「重试」处理，而其实
   * 是「找不到」。所以逐条扫、逐条比。
   */
  {
    id: 'g-route-refuse-shape',
    title: '每个拒绝都是 {ok:false, code, 一句话}，写死的状态码与映射表一致',
    covers: ['routes.js#refuse-shape'],
    probe: async () => {
      const source = routesSource()

      // 拒绝的本体：这个对象形状是客户端与模型共用的契约。
      anchor(
        source,
        /writeJson\(\s*res,\s*status,\s*\{\s*ok:\s*false,\s*code,\s*error:\s*message\s*\}\s*\)/,
        '拒绝不再是 {ok:false, code, error} 这个形状了——客户端与模型都按它行事',
      )

      // 映射表本身（行为核对，比 grep 可靠）。
      const table = [
        ['batch-missing', 404],
        ['ticket-missing', 404],
        ['invalid-request', 400],
        ['batch-unreadable', 503],
        ['not-waiting', 409],
        ['not-converged', 409],
        ['already-running', 409],
        ['not-dispatched', 409],
        ['no-session', 409],
      ]
      for (const [code, expected] of table) {
        check(
          statusForCode(code) === expected,
          'statusForCode(' + code + ') 应当是 ' + expected + '，实际是 ' + statusForCode(code),
        )
      }

      // 路由层那圈 catch 必须还在用映射表把 MiddlemanError 翻成状态码。
      // 少了这一条，台账抛的 batch-missing 会一路走到 500。
      anchor(
        source,
        /refuse\(\s*res,\s*statusForCode\(error\.code\),\s*error\.code,\s*error\.message\s*\)/,
        'catch 里「按 statusForCode 翻状态码」那条没了——台账的 batch-missing 会变成 500',
      )

      /**
       * 扫出**所有**写死了状态码的拒绝调用点。
       *
       * 第 80 行那种 `refuse(res, statusForCode(error.code), ...)` 不在这
       * 一支里（它没有数字），上面那条 anchor 单独盯它。
       */
      const hardcoded = [...source.matchAll(/refuse\(\s*res,\s*(\d{3})\s*,\s*'([^']+)'/g)]

      /**
       * 调用点的完整清单（按「状态码 + 机器码」的多重集比，不按行号——
       * 行号一改就漂，多集比的是「这几条拒绝还在不在」）。
       *
       * 少一条 → 有人把某道闸门删了；多一条 → 有人新加了一道拒绝，
       * 得在这里登记，并且想过它该不该走映射表。
       */
      const expected = [
        [403, 'forbidden'],           // 环回围栏
        [500, 'internal'],            // 我们自己的 bug
        [409, 'not-converged'],       // approve
        [404, 'ticket-missing'],      // run
        [409, 'not-dispatched'],      // run
        [409, 'already-running'],     // run
        [404, 'ticket-missing'],      // feedback
        [400, 'invalid-request'],     // feedback 空意见
        [502, 'steer-failed'],        // feedback steer 失败
        [404, 'ticket-missing'],      // retarget
        [400, 'invalid-request'],     // retarget 没带 model
        [502, 'model-pin-failed'],    // retarget 钉不上
        [404, 'ticket-missing'],      // answer
        [409, 'not-waiting'],         // answer 不在等人
        [400, 'invalid-request'],     // answer 空回答
        [409, 'no-session'],          // answer 没有子会话
        [502, 'deliver-failed'],      // answer 送不出去
        [404, 'ticket-missing'],      // cancel
      ]

      const actualList = hardcoded.map((m) => [Number(m[1]), m[2]])
      const key = (entry) => entry[0] + ' ' + entry[1]

      const tally = (entries) => {
        const counts = new Map()
        for (const entry of entries) {
          const k = key(entry)
          counts.set(k, (counts.get(k) ?? 0) + 1)
        }
        return counts
      }
      const wantCounts = tally(expected)
      const haveCounts = tally(actualList)
      const problems = []
      for (const [k, n] of wantCounts) {
        const have = haveCounts.get(k) ?? 0
        if (have < n) problems.push(k + ' 少掉了（原本 ' + n + ' 条，现在 ' + have + ' 条）')
      }
      for (const [k, have] of haveCounts) {
        const n = wantCounts.get(k) ?? 0
        if (have > n) problems.push(k + ' 多出来了（原本 ' + n + ' 条，现在 ' + have + ' 条）——新加的拒绝得在 expected 里登记')
      }
      check(problems.length === 0, '拒绝调用点与登记清单对不上：' + problems.join('；'))

      for (const match of hardcoded) {
        const status = Number(match[1])
        const code = match[2]
        const where = 'routes.js:' + lineAt(source, match.index)

        const override = STATUS_OVERRIDES.get(code)
        if (override !== undefined) {
          check(
            status === override,
            where + ' 的拒绝 ' + code + ' 一直是 ' + override + '，现在变成了 ' + status
              + '——它属于豁免清单，状态码不该漂',
          )
          continue
        }

        // 策略类拒绝：写死的状态码必须与映射表一致。
        check(
          STRATEGY_CODES.includes(code),
          where + ' 的拒绝 ' + code + ' 既不在策略码清单里、也不在豁免清单里，'
            + '两道名单都没有它——先决定它属于哪一类',
        )
        const expectedStatus = statusForCode(code)
        check(
          status === expectedStatus,
          where + " 的拒绝 '" + code + "' 写死了 " + status + '，但 statusForCode 说它该是 '
            + expectedStatus + '——两边已经漂了。要么让它们一致，要么把它登记进豁免清单并说明'
            + '它为什么不走映射表',
        )
      }

      /**
       * 反向断言：策略码集合必须**正好**是这九个。
       *
       * 从源码里实际扫出来的策略码（写死的那些，去掉豁免）+ 只经
       * statusForCode 的动态码，跟 STRATEGY_CODES 比。多一个（新加了策略
       * 拒绝却忘了登记）少一个（某道策略拒接从路由里消失了）都报破。
       */
      const scannedStrategy = new Set(
        actualList.map((entry) => entry[1]).filter((code) => !STATUS_OVERRIDES.has(code)),
      )
      for (const code of DYNAMIC_STRATEGY_CODES) scannedStrategy.add(code)
      const declared = new Set(STRATEGY_CODES)
      const missingFromSource = [...declared].filter((code) => !scannedStrategy.has(code))
      const missingFromDeclared = [...scannedStrategy].filter((code) => !declared.has(code))
      check(
        missingFromSource.length === 0,
        '这些策略码登记在清单里，但源码里已经扫不到了（闸门或被删、或被改了码）：'
          + missingFromSource.join('、'),
      )
      check(
        missingFromDeclared.length === 0,
        '源码里有这些策略码，但没登记进 STRATEGY_CODES：' + missingFromDeclared.join('、')
          + '——新加策略拒绝时得让它走 statusForCode，并在清单里登记',
      )
      check(
        declared.size === STRATEGY_CODES.length,
        'STRATEGY_CODES 里有重复项',
      )

      // 行为：挑几条真的拒绝一下，看形状与状态码对不对。
      await withHome(async () => {
        const { faces, calls } = facesWith()
        await seedBatch('CHECK-refuse-shape')

        // 这张票从没派出去——/run 要用 to 试「没派发就点执行」。
        await seedBatch('CHECK-refuse-undispatched', { childSessionId: undefined })

        const samples = [
          {
            where: '批次不存在', path: '/feedback', status: 404, code: 'batch-missing',
            options: { body: { batchId: 'CHECK-no-such-batch', ticketId: 'T-1', message: 'x' } },
          },
          {
            where: '工单不存在', path: '/feedback', status: 404, code: 'ticket-missing',
            options: { body: { batchId: 'CHECK-refuse-shape', ticketId: 'T-9', message: 'x' } },
          },
          {
            where: '意见为空', path: '/feedback', status: 400, code: 'invalid-request',
            options: { body: { batchId: 'CHECK-refuse-shape', ticketId: 'T-1', message: '   ' } },
          },
          {
            where: '票没在等人', path: '/answer', status: 409, code: 'not-waiting',
            options: { body: { batchId: 'CHECK-refuse-shape', ticketId: 'T-1', answer: 'A' } },
          },
          {
            where: '没带 model', path: '/retarget', status: 400, code: 'invalid-request',
            options: { body: { batchId: 'CHECK-refuse-shape', ticketId: 'T-1' } },
          },
          {
            where: '票还没派发', path: '/run', status: 409, code: 'not-dispatched',
            options: { body: { batchId: 'CHECK-refuse-undispatched', ticketId: 'T-1' } },
          },
          {
            where: '非环回连接', path: '/state', status: 403, code: 'forbidden',
            options: { method: 'GET', url: '/whale-tail/api/state', remoteAddress: '203.0.113.9' },
          },
        ]

        for (const sample of samples) {
          const result = await call(routeOf(faces, sample.path), sample.options)
          check(
            result.status === sample.status,
            sample.where + '：期望 ' + sample.status + '，实际 ' + result.status
              + '（' + JSON.stringify(result.body) + '）',
          )
          assertRefusalShape(result.body, sample.code, sample.where)
          if (STRATEGY_CODES.includes(sample.code)) {
            check(
              statusForCode(sample.code) === result.status,
              sample.where + '：返回的 ' + result.status + ' 跟映射表里的 '
                + statusForCode(sample.code) + ' 不一致',
            )
          }
        }

        // 上面七条全是拒绝，一条都不该造成副作用。
        check(countOf(calls, 'run') === 0, '拒绝路径上调了 dispatcher.run——拒绝不该往子会话里发东西')
        check(countOf(calls, 'steer') === 0, '拒绝路径上调了 dispatcher.steer')
        check(countOf(calls, 'selectModel') === 0, '拒绝路径上调了 dispatcher.selectModel')
      })
    },
  },

  /**
   * 票不在等人时，作答必须被拒，而且答案**不能**被送进任何子会话。
   *
   * 为什么这条重要：票在 running 时它那一轮还没结束，这时把答案当成
   * 新消息推进去，等于在它跑到一半时插话——而且人以为自己在回答一个
   * 问题，其实什么问题都没被问。
   */
  {
    id: 'g-route-answer-not-waiting',
    title: '票不在 waiting 时作答被拒（409 not-waiting），且没有发给子会话',
    covers: ['routes.js#answer-not-waiting'],
    probe: async () => {
      const source = routesSource()
      anchor(source, /refuse\(\s*res,\s*409,\s*'not-waiting'/, '「票没在等人」这条拒绝没了')
      anchor(source, /ticket\.status !== 'waiting'/, '「票必须在 waiting 才作答」这个判断没了')

      await withHome(async () => {
        const { faces, calls } = facesWith()
        // 票正在跑：它没有在等人。
        await seedBatch('CHECK-answer-not-waiting', { status: 'running' })

        const result = await call(routeOf(faces, '/answer'), {
          body: { batchId: 'CHECK-answer-not-waiting', ticketId: 'T-1', answer: '用 JSON' },
        })

        check(result.status === 409, '票没在等人却回了 ' + result.status + '，应当是 409')
        assertRefusalShape(result.body, 'not-waiting', '票没在等人时作答')
        check(
          countOf(calls, 'run') === 0,
          '被拒了却还是调了 dispatcher.run——子会话收到了一条它不该收到的消息',
        )
        check(countOf(calls, 'steer') === 0, '被拒了却调了 dispatcher.steer')

        const saved = await load('CHECK-answer-not-waiting')
        check(saved.tickets[0].status === 'running', '被拒的回答却改了票的状态：' + saved.tickets[0].status)
        check(saved.tickets[0].answers === undefined, '被拒的回答却被记进了台账——人以为答过了')
        check(saved.tickets[0].waiting === undefined, '被拒的回答却写上了 waiting 字段')

        // 反面证据：这张票真的在等人时，同一条路由必须放行。
        // 少了这一段，一个「永远拒绝」的实现也能让上面全部变绿。
        saved.tickets[0].status = 'waiting'
        saved.tickets[0].waiting = {
          question: '要 A 还是 B？', askedAt: Date.now(), sessionId: 'session-child-probe',
        }
        await save(saved)
        const ok = await call(routeOf(faces, '/answer'), {
          body: { batchId: 'CHECK-answer-not-waiting', ticketId: 'T-1', answer: '用 JSON' },
        })
        check(ok.status === 200, '票真的在等人时作答却被拒了：' + ok.status + ' ' + JSON.stringify(ok.body))
        check(countOf(calls, 'run') === 1, '在等人的票答完之后答案没有送出去')
      })
    },
  },

  /**
   * 空白回答要被拒在门外，而且一次送信都不能发生。
   *
   * 空字符串送到子会话那边，它收到一条空消息，接着跑——人以为自己
   * 答了什么，其实什么都没说。
   */
  {
    id: 'g-route-answer-empty',
    title: '空白回答被拒（400 invalid-request），送信 0 次',
    covers: ['routes.js#answer-empty'],
    probe: async () => {
      const source = routesSource()
      anchor(source, /refuse\(\s*res,\s*400,\s*'invalid-request',\s*'回答不能为空'/, '「回答不能为空」这条拒绝没了')
      anchor(source, /const answer = typeof body\.answer === 'string' \? body\.answer\.trim\(\)/, '空回答的判据（trim 后为空）没了')

      await withHome(async () => {
        const { faces, calls } = facesWith()
        await seedBatch('CHECK-answer-empty', {
          status: 'waiting',
          waiting: { question: '要 A 还是 B？', askedAt: Date.now(), sessionId: 'session-child-probe' },
        })

        // 三种空白：全空格、空串、干脆没带这个字段。
        const blanks = [
          { name: '全空格', body: { batchId: 'CHECK-answer-empty', ticketId: 'T-1', answer: '   ' } },
          { name: '空串', body: { batchId: 'CHECK-answer-empty', ticketId: 'T-1', answer: '' } },
          { name: '没带 answer', body: { batchId: 'CHECK-answer-empty', ticketId: 'T-1' } },
        ]
        for (const blank of blanks) {
          const result = await call(routeOf(faces, '/answer'), { body: blank.body })
          check(
            result.status === 400,
            blank.name + '的回答应当被拒成 400，实际 ' + result.status,
          )
          assertRefusalShape(result.body, 'invalid-request', blank.name + '的回答')
        }

        check(countOf(calls, 'run') === 0, '空回答却调了 dispatcher.run——子会话收到一条空消息')
        check(countOf(calls, 'steer') === 0, '空回答却调了 dispatcher.steer')

        const saved = await load('CHECK-answer-empty')
        check(saved.tickets[0].status === 'waiting', '空回答却把票从 waiting 改成了 ' + saved.tickets[0].status)
        check(saved.tickets[0].waiting !== undefined, '空回答却清掉了 waiting 字段——人以为答过了')
        check(saved.tickets[0].answers === undefined, '空回答却被记进台账')
      })
    },
  },

  /**
   * 票已经在跑时再点「执行」，必须是 409 already-running，
   * 并且 dispatcher.run 一次都不许被调。
   *
   * 重复点执行会让同一张票起两个轮次：产出交叉、台账上一个 startedAt
   * 对不上两个真实开始时间，而且人不会知道自己点重了。
   */
  {
    id: 'g-route-execute-only-suspended',
    title: '票已经在跑时点执行被拒（409 already-running），dispatcher.run 0 次',
    covers: ['routes.js#execute-only-suspended'],
    probe: async () => {
      const source = routesSource()
      anchor(source, /refuse\(\s*res,\s*409,\s*'already-running'/, '「已经在跑了」这条拒绝没了')
      anchor(source, /if \(ticket\.status === 'running'\)/, '「票在跑就拒绝执行」这个判断没了')

      await withHome(async () => {
        const { faces, calls } = facesWith()
        await seedBatch('CHECK-execute-running', { status: 'running', startedAt: 1 })

        const result = await call(routeOf(faces, '/run'), {
          body: { batchId: 'CHECK-execute-running', ticketId: 'T-1' },
        })

        check(result.status === 409, '票已经在跑却回了 ' + result.status + '，应当是 409')
        assertRefusalShape(result.body, 'already-running', '重复点执行')
        check(countOf(calls, 'run') === 0, '被拒了却还是把子会话跑起来了——同一张票起了两个轮次')

        const saved = await load('CHECK-execute-running')
        check(saved.tickets[0].status === 'running', '被拒的执行却改了状态：' + saved.tickets[0].status)
        check(saved.tickets[0].startedAt === 1, '被拒的执行却刷新了 startedAt——台账上的开始时间变成假的')

        // 反面证据：挂起中的票点执行必须真的跑起来。
        saved.tickets[0].status = 'suspended'
        delete saved.tickets[0].startedAt
        await save(saved)
        const ok = await call(routeOf(faces, '/run'), {
          body: { batchId: 'CHECK-execute-running', ticketId: 'T-1' },
        })
        check(ok.status === 200, '挂起中的票点执行却被拒了：' + ok.status + ' ' + JSON.stringify(ok.body))
        check(countOf(calls, 'run') === 1, '挂起中的票点执行了，却没真的跑起来')
        check(
          typeof calls[0].text === 'string' && calls[0].text.includes('做点事'),
          '跑起来了但没把任务书带过去：' + JSON.stringify(calls[0].text),
        )
      })
    },
  },

  /**
   * 还没派发的票（没有 childSessionId）点执行，要被拒成 not-dispatched。
   *
   * 没有子会话就没有可跑的东西；硬跑会用 undefined 去调 dispatcher.run，
   * 报出来的错没人看得懂。
   */
  {
    id: 'g-route-execute-not-dispatched',
    title: '票还没派发时点执行被拒（409 not-dispatched）',
    covers: ['routes.js#execute-not-dispatched'],
    probe: async () => {
      const source = routesSource()
      anchor(source, /refuse\(\s*res,\s*409,\s*'not-dispatched'/, '「还没派发」这条拒绝没了')
      anchor(source, /typeof ticket\.childSessionId !== 'string'/, '「必须先派发」这个判断没了')

      await withHome(async () => {
        const { faces, calls } = facesWith()
        // 没有 childSessionId：这张票从没派出去。
        await seedBatch('CHECK-execute-not-dispatched', { status: 'suspended', childSessionId: undefined })

        const result = await call(routeOf(faces, '/run'), {
          body: { batchId: 'CHECK-execute-not-dispatched', ticketId: 'T-1' },
        })

        check(result.status === 409, '没派发的票点执行却回了 ' + result.status + '，应当是 409')
        assertRefusalShape(result.body, 'not-dispatched', '没派发就点执行')
        check(countOf(calls, 'run') === 0, '被拒了却调了 dispatcher.run——拿 undefined 去跑会话')

        const saved = await load('CHECK-execute-not-dispatched')
        check(saved.tickets[0].status === 'suspended', '被拒的执行却改了状态：' + saved.tickets[0].status)
        check(saved.tickets[0].startedAt === undefined, '被拒的执行却写上了 startedAt')
      })
    },
  },

  /**
   * 改模型不带 `model:{provider,model}` 要被拒，账本也不许动。
   *
   * `model: {}` 看着像「定了」，其实没有——真让它过去，派发时会拿
   * undefined 去调 session.selectModel，卡片上显示的模型与实际跑的
   * 又是两回事。
   */
  {
    id: 'g-route-model-shape',
    title: '改模型没带 model:{provider,model} 被拒（400 invalid-request），账本不动',
    covers: ['routes.js#model-shape'],
    probe: async () => {
      const source = routesSource()
      anchor(
        source,
        /refuse\(\s*res,\s*400,\s*'invalid-request',\s*'必须带 model: \{provider, model\}'/,
        '「必须带 model」这条拒绝没了',
      )
      anchor(source, /typeof model\.model !== 'string'/, '「model.model 必须是字符串」这个判断没了')

      await withHome(async () => {
        const { faces, calls } = facesWith()
        await seedBatch('CHECK-model-shape')

        const bad = [
          { name: '完全没带 model', model: undefined },
          { name: 'model 是空对象', model: {} },
          { name: '只有 provider', model: { provider: 'x' } },
          { name: 'model 不是对象', model: 'x/y' },
        ]
        for (const sample of bad) {
          const body = { batchId: 'CHECK-model-shape', ticketId: 'T-1' }
          if (sample.model !== undefined) body.model = sample.model
          const result = await call(routeOf(faces, '/retarget'), { body })
          check(
            result.status === 400,
            sample.name + '：应当被拒成 400，实际 ' + result.status
              + '（' + JSON.stringify(result.body) + '）',
          )
          assertRefusalShape(result.body, 'invalid-request', sample.name)
        }

        check(countOf(calls, 'selectModel') === 0, '被拒的改模型却还是去钉了子会话的模型')

        const saved = await load('CHECK-model-shape')
        check(
          saved.tickets[0].model.model === 'probe-model',
          '被拒的改模型却把账本改了：' + JSON.stringify(saved.tickets[0].model),
        )

        // 反面证据：带上合法的 model，必须真的改成。
        const ok = await call(routeOf(faces, '/retarget'), {
          body: {
            batchId: 'CHECK-model-shape',
            ticketId: 'T-1',
            model: { provider: 'probe-provider', model: 'probe-model-2', reasoningEffort: 'low' },
          },
        })
        check(ok.status === 200, '合法的 model 却被拒了：' + ok.status + ' ' + JSON.stringify(ok.body))
        check(countOf(calls, 'selectModel') === 1, '合法改模型却没真的去钉子会话')
        const after = await load('CHECK-model-shape')
        check(after.tickets[0].model.model === 'probe-model-2', '合法的改模型没写回账本')
      })
    },
  },

  /**
   * 批准只能给收敛后的批次。
   *
   * 这条路由本来就是「只有人点得到」的那一半：模型没有对应的工具。
   * 但光靠「没有工具」不够——批次没收敛时点了批准，等于把一份没问完
   * 的设计放出去派发。
   */
  {
    id: 'g-route-approve-human-only',
    title: '批次未收敛时批准被拒（409 not-converged），台账不许被改成 approved',
    covers: ['routes.js#approve-human-only'],
    probe: async () => {
      const source = routesSource()
      anchor(source, /refuse\(\s*res,\s*409,\s*'not-converged'/, '「只有收敛后才能批准」这条拒绝没了')
      anchor(source, /if \(batch\.status !== 'converged'\)/, '「必须是收敛状态」这个判断没了')

      await withHome(async () => {
        const { faces, calls } = facesWith()
        await seedBatch('CHECK-approve-not-converged', {})
        // 把批次退回到设计阶段。
        const batch = await load('CHECK-approve-not-converged')
        batch.status = 'grilling'
        await save(batch)

        const result = await call(routeOf(faces, '/approve'), {
          body: { batchId: 'CHECK-approve-not-converged' },
        })

        check(result.status === 409, '未收敛的批次却被批准了：' + result.status)
        assertRefusalShape(result.body, 'not-converged', '未收敛时批准')

        const saved = await load('CHECK-approve-not-converged')
        check(saved.status === 'grilling', '被拒的批准却改了批次状态：' + saved.status)
        check(saved.approvedAt === undefined, '被拒的批准却写上了 approvedAt')
        check(saved.approvedBy === undefined, '被拒的批准却写上了 approvedBy')
        check(countOf(calls, 'run') === 0, '批准路径不该动子会话')

        // 反面证据：收敛之后同一条路由必须放行，而且批准人只能是 human。
        saved.status = 'converged'
        await save(saved)
        const ok = await call(routeOf(faces, '/approve'), {
          body: { batchId: 'CHECK-approve-not-converged' },
        })
        check(ok.status === 200, '收敛后的批次却被拒了：' + ok.status + ' ' + JSON.stringify(ok.body))
        const approved = await load('CHECK-approve-not-converged')
        check(approved.status === 'approved', '批准了却没写回 approved：' + approved.status)
        check(approved.approvedBy === 'human', '批准人不是 human 了：' + String(approved.approvedBy))
      })
    },
  },

  /**
   * 请求体超上限 / 不合法 JSON，都要被拒成 400 invalid-request。
   *
   * 这条闸门挡的是「一口气把整个会话正文塞进来」那种请求：没有上限，
   * 一个坏客户端就能把内存吃光；而非法 JSON 如果没有被拦在这里，
   * 会以 500 + 一段栈的形式回到浏览器。
   */
  {
    id: 'g-route-body-limit',
    title: '请求体超上限或非法 JSON 被拒（400 invalid-request）',
    covers: ['routes.js#body-limit'],
    probe: async () => {
      const source = routesSource()
      anchor(source, /const BODY_LIMIT = 64 \* 1024/, '请求体上限的定义没了')
      anchor(
        source,
        /if \(size > BODY_LIMIT\) throw new MiddlemanError\('invalid-request',\s*'请求体超过上限'\)/,
        '「请求体超过上限」这条拒绝没了',
      )
      anchor(
        source,
        /throw new MiddlemanError\('invalid-request',\s*'请求体不是合法 JSON'\)/,
        '「请求体不是合法 JSON」这条拒绝没了',
      )

      await withHome(async () => {
        const { faces, calls } = facesWith()
        await seedBatch('CHECK-body-limit')

        // 1) 超大请求体：比 64KiB 大一点就够。
        const tooBig = await call(routeOf(faces, '/feedback'), {
          raw: '{"batchId":"CHECK-body-limit","message":"' + 'x'.repeat(70 * 1024) + '"}',
        })
        check(tooBig.status === 400, '超大请求体应当被拒成 400，实际 ' + tooBig.status)
        assertRefusalShape(tooBig.body, 'invalid-request', '超大请求体')

        // 2) 非法 JSON。
        const broken = await call(routeOf(faces, '/feedback'), {
          raw: '{"batchId": "CHECK-body-limit", "message": ',
        })
        check(broken.status === 400, '非法 JSON 应当被拒成 400，实际 ' + broken.status)
        assertRefusalShape(broken.body, 'invalid-request', '非法 JSON')

        // 两种坏请求都不许碰台账、不许送信。
        const saved = await load('CHECK-body-limit')
        check(saved.tickets[0].feedback === undefined, '坏请求却在票上留下了 feedback')
        check(countOf(calls, 'run') === 0, '坏请求却调了 dispatcher.run')

        // 反面证据：正常大小的合法请求必须通得过——否则「上限」就成了「全拒」。
        const ok = await call(routeOf(faces, '/feedback'), {
          body: { batchId: 'CHECK-body-limit', ticketId: 'T-1', message: '换个方向' },
        })
        check(ok.status === 200, '正常请求却被拒了：' + ok.status + ' ' + JSON.stringify(ok.body))
        const after = await load('CHECK-body-limit')
        check(
          Array.isArray(after.tickets[0].feedback) && after.tickets[0].feedback.length === 1,
          '正常请求的意见没写进台账',
        )
      })
    },
  },
]
