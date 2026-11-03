/**
 * 观察器闸门的自检探针。
 *
 * 为什么需要这一层：lib/observer.js 里的四道闸门（等人不结算、没跑过不结算、
 * 同轮去重、陌生会话直接返回）都是**静默**的——它们正常工作时什么都不说，
 * 被人删掉一行也照样一切「看起来正常」，直到真机上出现「在等你被记成已完成」
 * 或者「主会话收到一串重复回报」。test/ 里的用例盯得住今天，但它们是测试，
 * 不是自检：跑不起来的时候没人知道闸门还在不在。
 *
 * 所以每条探针做两件事：
 *
 * 1. **源码锚点**：判据原文还在不在。注释改写不算破，判据被删才算破。
 * 2. **行为**：造假台账 + 假宿主，真发一次 turn/end，看票有没有被错误结算。
 *    每条行为探针都带一张**对照票**（status: running，该被结算）：观察器
 *    整体坏掉时对照票不结算，探针同样报破——否则「什么都没发生」会被当成
 *    「闸门拦住了」，探针就变成永远绿的空转。
 *
 * 探针只读 lib/，不写仓库里的任何文件；临时台账落在系统临时目录，跑完就删。
 *
 * @module dsh-whale-tail/scripts/gates/observer
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installObserver } from '../../lib/observer.js'
import { blankBatch, list, save } from '../../lib/ledger.js'

/** 观察器源码的位置。每个探针现读一次，改完源码不必重启进程。 */
const SOURCE_URL = new URL('../../lib/observer.js', import.meta.url)

/** 对照票与探针票共用的主会话 id：不是它，观察器根本不会回传。 */
const PARENT_SESSION = 'session-probe-parent'

/**
 * 读观察器源码。
 * @returns {string} 源码全文。
 */
function observerSource() {
  try {
    return readFileSync(SOURCE_URL, 'utf8')
  } catch (error) {
    throw new Error('读不到 lib/observer.js，观察器的闸门没法自检：' + String(error?.message ?? error))
  }
}

/**
 * 查源码锚点。
 *
 * 只认判据原文，不认注释：注释是给人读的，判据才是拦住事故的那一行。
 * 判据被删掉、或者被改写成永远不成立的形状，这里就报破。
 *
 * @param source - 源码全文。
 * @param anchors - 锚点清单，每项 {text, why}。
 * @returns {string[]} 问题列表；空数组表示锚点都在。
 */
function anchorProblems(source, anchors) {
  const problems = []
  for (const anchor of anchors) {
    if (!source.includes(anchor.text)) {
      problems.push('源码判据不见了：`' + anchor.text + '`（' + anchor.why + '）')
    }
  }
  return problems
}

/**
 * 在临时台账目录里跑一段。
 *
 * WT_HOME 是进程级环境变量，所以探针必须**顺序**跑：每个探针进来时把
 * 它指到自己的临时目录，出去时还原成原值（原本没设就删掉），最后把
 * 目录整个删掉——不在别人的 ~/.dsh 里留垃圾。
 *
 * @param fn - 要跑的函数，收一个临时目录路径。
 * @returns fn 的返回值。
 */
async function withTempHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'mm-check-'))
  const previous = process.env.WT_HOME
  process.env.WT_HOME = home
  try {
    return await fn(home)
  } finally {
    if (previous === undefined) delete process.env.WT_HOME
    else process.env.WT_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

/**
 * 造一个只记监听器的假 ctx。
 *
 * 形状照 test/observer-report.test.mjs：观察器只用到 ctx.on，且要拿到
 * 卸载函数。每个探针用**新的** ctx 对象——installObserver 用 WeakMap
 * 按 ctx 去重，复用同一个对象会把前一个探针的观察器卸掉。
 *
 * @returns {{listeners: Function[], ctx: object}}
 */
function fakeCtx() {
  const listeners = []
  const ctx = {
    on(_name, listener) {
      listeners.push(listener)
      return () => {
        const at = listeners.indexOf(listener)
        if (at >= 0) listeners.splice(at, 1)
      }
    },
  }
  return { listeners, ctx }
}

/**
 * 造一个只记录调用的假派发面。
 *
 * tail 返回的形状照 test/observer-report.test.mjs 的 assistantTail()：
 * 一条 assistant/message，content 里一段 text。lastAssistantText 认的就是它。
 *
 * @param tailText - tail() 回的助手正文。
 * @returns {{faces: object, runs: object[], tails: string[], warns: unknown[]}}
 */
function fakeFaces(tailText = '子会话的答复') {
  const runs = []
  const tails = []
  const warns = []
  const faces = {
    dispatcher: {
      async tail(sessionId) {
        tails.push(sessionId)
        return [{
          type: 'assistant/message',
          data: { message: { role: 'assistant', content: [{ type: 'text', text: tailText }] } },
        }]
      },
      async run(sessionId, text) {
        runs.push({ sessionId, text })
      },
    },
    warn(message) {
      warns.push(message)
    },
  }
  return { faces, runs, tails, warns }
}

/**
 * 往台账里落一个批次。
 *
 * 批次带 parentSessionId——不带的话观察器就算该回传也不会调 run，
 * 「run 没被调」就测不出东西。
 *
 * @param id - 批次 id。
 * @param specs - 票规格数组，每项 {id, status, sessionId, waiting?, reportedTurn?}。
 */
async function seedBatch(id, specs) {
  const batch = blankBatch('闸门探针 ' + id)
  batch.id = id
  batch.parentSessionId = PARENT_SESSION
  batch.tickets = specs.map((spec) => ({
    id: spec.id,
    title: '探针票 ' + spec.id,
    brief: '闸门探针',
    blockedBy: [],
    riskIds: [],
    riskFree: true,
    riskFreeReason: '闸门探针，不涉及真实风险',
    model: { provider: 'p', model: 'm' },
    modelReason: '探针不真的派发',
    status: spec.status,
    childSessionId: spec.sessionId,
    ...(spec.waiting === undefined ? {} : { waiting: spec.waiting }),
    ...(spec.reportedTurn === undefined ? {} : { reportedTurn: spec.reportedTurn }),
  }))
  await save(batch)
  return batch
}

/**
 * 从台账读回一张票。
 * @param batchId - 批次 id。
 * @param ticketId - 票 id。
 * @returns 票；批次或票不存在时是 undefined。
 */
async function loadTicket(batchId, ticketId) {
  const batch = (await list()).find((candidate) => candidate.id === batchId)
  return (batch?.tickets ?? []).find((candidate) => candidate.id === ticketId)
}

/**
 * 发一次 turn/end。
 * @param handler - ctx.on('session/event') 拿到的那支监听器。
 * @param sessionId - 子会话 id。
 * @param turn - 轮次号。
 */
async function fire(handler, sessionId, turn) {
  await handler({ id: sessionId }, {
    type: 'turn/end',
    data: { turn, reason: { kind: 'completed' } },
  })
}

/**
 * 装上观察器，返回监听器。
 * @param faces - 假派发面。
 * @returns {{listener: Function, uninstall: Function}}
 */
function install(faces) {
  const { listeners, ctx } = fakeCtx()
  const uninstall = installObserver(ctx, faces)
  return { listener: listeners[0], uninstall, listeners }
}

/** 把问题列表收成一条可读的错。 */
function broken(what, problems) {
  return new Error(what + '：\n- ' + problems.join('\n- '))
}

/** 一道闸门。 */
// { id: 'g-observer-waiting', title: '...', covers: ['observer.js#waiting-gate'], probe: async () => { /* 通过就正常返回；破了就 throw new Error('中文说明') */ } }
export const observerGates = [
  {
    id: 'g-observer-waiting',
    title: '票在等人时，turn/end 不结算也不回传',
    covers: ['observer.js#waiting-gate'],
    probe: async () => {
      const problems = anchorProblems(observerSource(), [
        { text: "ticket.status === 'waiting'", why: '「状态写着 waiting」这一条判据' },
        { text: 'ticket.waiting !== undefined', why: '「带 waiting 字段」这一条判据——它才是真凭据' },
      ])

      try {
        await withTempHome(async () => {
          const batchId = 'GATE-waiting'
          await seedBatch(batchId, [
            {
              id: 'T-1',
              status: 'waiting',
              sessionId: 'session-obs-waiting',
              waiting: {
                question: '要 A 还是 B？',
                options: ['A', 'B'],
                askedAt: Date.now(),
                sessionId: 'session-obs-waiting',
              },
            },
            // 对照票：跑着的票**该**被结算。观察器整体坏掉时它不结算，
            // 探针于是报破——否则「什么都没发生」会被误当成「闸门拦住了」。
            { id: 'T-C', status: 'running', sessionId: 'session-obs-control' },
          ])

          const { faces, runs, tails } = fakeFaces()
          const { listener, uninstall } = install(faces)
          try {
            if (typeof listener !== 'function') {
              problems.push('观察器没订阅 session/event，探针无从下手')
              return
            }

            // 子会话停下来等人，紧接着那一轮结束——真机上覆盖 waiting 的那一刻。
            await fire(listener, 'session-obs-waiting', 1)
            const waitingTicket = await loadTicket(batchId, 'T-1')
            if (waitingTicket?.status !== 'waiting') {
              problems.push('在等人的票被结算成了 ' + String(waitingTicket?.status)
                + '——面板上看不出它在等你，人不会去答那个问题')
            }
            if (waitingTicket?.waiting === undefined) {
              problems.push('waiting 字段被观察器清掉了，面板上看不出它在等什么')
            }
            if (waitingTicket?.reportedTurn !== undefined) {
              problems.push('在等人的票被记了 reportedTurn=' + String(waitingTicket?.reportedTurn)
                + '，下一轮真跑完时会被去重吃掉')
            }

            await fire(listener, 'session-obs-control', 1)
            const control = await loadTicket(batchId, 'T-C')
            if (control?.status !== 'done') {
              problems.push('对照票（running）没被结算，观察器根本没生效，这条探针证明不了 waiting 闸')
            }
          } finally {
            uninstall()
          }

          if (runs.length !== 1) {
            problems.push('dispatcher.run 被调了 ' + runs.length + ' 次，只该是 1 次（对照票那一次）')
          }
          if (!String(runs[0]?.text ?? '').includes('T-C')) {
            problems.push('回传给主会话的那条里没有对照票 T-C——多半是把在等人的票当成跑完了')
          }
          if (tails.length !== 1 || tails[0] !== 'session-obs-control') {
            problems.push('读历史读了 [' + tails.join(', ') + ']；在等人的票不该被读历史，只该读对照票')
          }
        })
      } catch (error) {
        if (problems.length === 0) problems.push('行为探针本身报错：' + String(error?.message ?? error))
      }

      if (problems.length > 0) {
        throw broken('观察器里那道 waiting 闸不见了——票在等人时会被结算成 done', problems)
      }
    },
  },

  {
    id: 'g-observer-unstarted',
    title: '票还没开跑（pending / suspended）时，turn/end 不结算',
    covers: ['observer.js#unstarted-gate'],
    probe: async () => {
      const problems = anchorProblems(observerSource(), [
        { text: "ticket.status === 'pending'", why: '「还没派发」这一条判据' },
        { text: "ticket.status === 'suspended'", why: '「人还没点执行」这一条判据' },
      ])

      try {
        await withTempHome(async () => {
          const batchId = 'GATE-unstarted'
          await seedBatch(batchId, [
            { id: 'T-P', status: 'pending', sessionId: 'session-obs-pending' },
            { id: 'T-S', status: 'suspended', sessionId: 'session-obs-suspended' },
            { id: 'T-C', status: 'running', sessionId: 'session-obs-control' },
          ])

          const { faces, runs, tails } = fakeFaces()
          const { listener, uninstall } = install(faces)
          try {
            if (typeof listener !== 'function') {
              problems.push('观察器没订阅 session/event，探针无从下手')
              return
            }

            // 挂起时子会话已经建好，但人还没点「执行」——它一步都没跑。
            await fire(listener, 'session-obs-pending', 1)
            await fire(listener, 'session-obs-suspended', 1)

            const pending = await loadTicket(batchId, 'T-P')
            if (pending?.status !== 'pending') {
              problems.push('还没派发的票被结算成了 ' + String(pending?.status) + '——没跑过的票不能算完成')
            }
            const suspended = await loadTicket(batchId, 'T-S')
            if (suspended?.status !== 'suspended') {
              problems.push('挂起（人还没点执行）的票被结算成了 ' + String(suspended?.status)
                + '——主会话会以为活干完了')
            }

            await fire(listener, 'session-obs-control', 1)
            const control = await loadTicket(batchId, 'T-C')
            if (control?.status !== 'done') {
              problems.push('对照票（running）没被结算，观察器根本没生效，这条探针证明不了「没跑过」闸')
            }
          } finally {
            uninstall()
          }

          if (runs.length !== 1) {
            problems.push('dispatcher.run 被调了 ' + runs.length + ' 次，只该是 1 次（对照票那一次）')
          }
          if (!String(runs[0]?.text ?? '').includes('T-C')) {
            problems.push('回传给主会话的那条里没有对照票 T-C——没跑过的票被当成「任务完成」报上去了')
          }
          if (tails.length !== 1 || tails[0] !== 'session-obs-control') {
            problems.push('读历史读了 [' + tails.join(', ') + ']；没跑过的票不该被读历史')
          }
        })
      } catch (error) {
        if (problems.length === 0) problems.push('行为探针本身报错：' + String(error?.message ?? error))
      }

      if (problems.length > 0) {
        throw broken('观察器里那道「没跑过不结算」的闸不见了——挂起的票会被标成 done', problems)
      }
    },
  },

  {
    id: 'g-observer-dedupe',
    title: '同一张票同一个 reportedTurn 的第二次 turn/end 不再回传',
    covers: ['observer.js#dedupe-gate'],
    probe: async () => {
      const problems = anchorProblems(observerSource(), [
        { text: 'ticket.reportedTurn !== undefined', why: '「已经报过」这一条判据' },
        { text: 'ticket.reportedTurn === turn', why: '「报的是同一轮」这一条判据' },
        { text: 'ticket.reportedTurn = turn', why: '结算时把轮次记下来，去重才有依据' },
      ])

      try {
        await withTempHome(async () => {
          const batchId = 'GATE-dedupe'
          await seedBatch(batchId, [
            { id: 'T-1', status: 'running', sessionId: 'session-obs-dedupe' },
          ])

          const { faces, runs } = fakeFaces('第一轮的答复')
          const { listener, uninstall } = install(faces)
          try {
            if (typeof listener !== 'function') {
              problems.push('观察器没订阅 session/event，探针无从下手')
              return
            }

            // 同一个 turn/end 来了三遍——插件重载时旧监听器没卸干净就是这样。
            await fire(listener, 'session-obs-dedupe', 7)
            await fire(listener, 'session-obs-dedupe', 7)
            await fire(listener, 'session-obs-dedupe', 7)

            if (runs.length !== 1) {
              problems.push('同一个 turn 回了 ' + runs.length + ' 次，主会话会收到一串重复回报')
            }
            const afterSame = await loadTicket(batchId, 'T-1')
            if (afterSame?.reportedTurn !== 7) {
              problems.push('reportedTurn 没记成 7（现在是 ' + String(afterSame?.reportedTurn) + '），去重没有依据')
            }

            // 换了轮次就该照报：steer 会带起新的一轮，那一轮也是新的结算。
            await fire(listener, 'session-obs-dedupe', 8)
            if (runs.length !== 2) {
              problems.push('换了 turn 号之后没有回传（run 共 ' + runs.length
                + ' 次）——去重把新的一轮也吃掉了')
            }
            const afterNew = await loadTicket(batchId, 'T-1')
            if (afterNew?.reportedTurn !== 8) {
              problems.push('新的一轮跑完了，reportedTurn 还是 ' + String(afterNew?.reportedTurn)
                + '，下一轮会重复回传')
            }
          } finally {
            uninstall()
          }
        })
      } catch (error) {
        if (problems.length === 0) problems.push('行为探针本身报错：' + String(error?.message ?? error))
      }

      if (problems.length > 0) {
        throw broken('观察器里那道去重闸不见了——同一个 turn/end 会被回传多次', problems)
      }
    },
  },

  {
    id: 'g-observer-unknown-session',
    title: 'sessionId 不在台账里时，观察器直接返回：不读历史、不发消息',
    covers: ['observer.js#unknown-session-gate'],
    probe: async () => {
      const problems = anchorProblems(observerSource(), [
        { text: 'const hit = index.get(sessionId)', why: '「按子会话 id 查台账」这一步' },
        { text: 'if (hit === undefined) return', why: '「不在台账里就立刻返回」这一条判据' },
      ])

      try {
        await withTempHome(async () => {
          const batchId = 'GATE-unknown-session'
          await seedBatch(batchId, [
            { id: 'T-1', status: 'running', sessionId: 'session-child-known' },
          ])

          const { faces, runs, tails, warns } = fakeFaces()
          const { listener, uninstall } = install(faces)
          try {
            if (typeof listener !== 'function') {
              problems.push('观察器没订阅 session/event，探针无从下手')
              return
            }

            // 陌生会话：日常对话的每一轮都是这个形状，碰一下就出事故。
            await fire(listener, 'session-not-mine', 1)
            if (tails.length !== 0) {
              problems.push('陌生会话的 turn/end 去读了历史（tail 被调 ' + tails.length + ' 次）')
            }
            if (runs.length !== 0) {
              problems.push('陌生会话的 turn/end 往主会话发了消息（run 被调 ' + runs.length + ' 次）')
            }
            if (warns.length !== 0) {
              problems.push('陌生会话的 turn/end 触发了警告：' + warns.map(String).join(' / ')
                + '——它该直接返回，什么都不说')
            }
            const untouched = await loadTicket(batchId, 'T-1')
            if (untouched?.status !== 'running') {
              problems.push('陌生会话让人动了自己的票：状态变成了 ' + String(untouched?.status))
            }

            // 对照：真正的子会话到了，照样得读历史、照样得回传。
            // 没有这一步，观察器整体坏掉时「0 次」也会让探针全绿。
            await fire(listener, 'session-child-known', 1)
            if (tails.length !== 1) {
              problems.push('对照：已知子会话的 turn/end 没读历史（tail 共 ' + tails.length + ' 次）')
            }
            if (runs.length !== 1) {
              problems.push('对照：已知子会话的 turn/end 没回传（run 共 ' + runs.length + ' 次）')
            }
          } finally {
            uninstall()
          }
        })
      } catch (error) {
        if (problems.length === 0) problems.push('行为探针本身报错：' + String(error?.message ?? error))
      }

      if (problems.length > 0) {
        throw broken('观察器里那道「陌生会话直接返回」的闸不见了——它会碰你日常对话的每一轮', problems)
      }
    },
  },
]
