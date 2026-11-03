/**
 * 观察器的回传与去重。
 *
 * 两件事以前只靠手工看：
 * - 同一个 turn/end 只回传一次（回报里写的验证方式：「只收到一条回报」）
 * - 回传里带着子会话的真实答复与跑过的命令
 *
 * 去重这一条尤其要盯：插件每重载一次就 apply 一次，旧 fiber 的卸载
 * 不一定来得及跑完，同一个 turn/end 于是被推 N 次，主会话收到一串重复
 * 回报——那不是多了一条消息，是同一件事被说了一遍。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'mm-observer-'))
process.env.MM_HOME = home

const { installObserver } = await import('../lib/observer.js')
const { blankBatch, save } = await import('../lib/ledger.js')

/**
 * 造一个只记监听器的假 ctx。
 * @returns {{ listeners: Array }}
 */
function fakeCtx() {
  const listeners = []
  return {
    listeners,
    on(_name, listener) {
      listeners.push(listener)
      return () => {
        const at = listeners.indexOf(listener)
        if (at >= 0) listeners.splice(at, 1)
      }
    },
  }
}

/**
 * 造一个只记录 run() 调用的假派发面。
 * @returns {{ faces: object, runs: Array }}
 */
function fakeFaces(tailRecords) {
  const runs = []
  return {
    runs,
    faces: {
      dispatcher: {
        async tail() {
          return tailRecords ?? []
        },
        async run(_sessionId, text) {
          runs.push(text)
        },
      },
      warn() {},
    },
  }
}

/**
 * 造一个批次，里面有一张已派发的票。
 *
 * reportedTurn 故意不预置：观察器第一次看到这张票时还没报过，
 * 所以应该照报。
 */
async function seedBatch(childSessionId) {
  const batch = blankBatch('观察器验证')
  batch.parentSessionId = 'session-parent'
  batch.tickets = [{
    id: 'T-1',
    title: '验证票',
    brief: '干活',
    blockedBy: [],
    riskIds: [],
    riskFree: false,
    riskFreeReason: undefined,
    model: { provider: 'p', model: 'm' },
    modelReason: '快',
    source: undefined,
    payload: undefined,
    effort: undefined,
    notes: undefined,
    status: 'running',
    childSessionId,
  }]
  await save(batch)
  return batch
}

/** 一条 tail 记录：一个助手消息带文字。形状跟宿主回包一致。 */
function assistantTail(text) {
  return [{
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
  }]
}

/** 一条 tail 记录：一次 bash 调用。 */
function bashTail(command) {
  return [{
    type: 'tool/call',
    data: { name: 'bash', arguments: JSON.stringify({ command }) },
  }]
}

test('同一个 turn/end 只回传一次', async () => {
  await seedBatch('session-child-dedupe')
  const ctx = fakeCtx()
  const { faces, runs } = fakeFaces(assistantTail('子会话的答复'))
  installObserver(ctx, faces)

  const listener = ctx.listeners[0]
  const event = { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } }
  const session = { id: 'session-child-dedupe' }

  await listener(session, event)
  await listener(session, event)
  await listener(session, event)

  assert.equal(runs.length, 1, '同一个 turn 回了 ' + runs.length + ' 次，主会话会收到一串重复回报')
  assert.match(runs[0], /子会话的答复/)
})

test('换了 turn 号就再回传一次——那是新的一轮，不该被旧的去重吃掉', async () => {
  await seedBatch('session-child-newturn')
  const ctx = fakeCtx()
  const { faces, runs } = fakeFaces(assistantTail('第一轮'))
  installObserver(ctx, faces)

  const listener = ctx.listeners[0]
  const session = { id: 'session-child-newturn' }

  await listener(session, { type: 'turn/end', data: { turn: 8, reason: { kind: 'completed' } } })
  assert.equal(runs.length, 1, '新的 turn 应当照常回传')

  await listener(session, { type: 'turn/end', data: { turn: 9, reason: { kind: 'completed' } } })
  assert.equal(runs.length, 2, '又一轮 turn 又该回一次')
})

test('台账里没有的子会话，不回传——不该碰你日常对话的每一轮', async () => {
  await seedBatch('session-child-known')
  const ctx = fakeCtx()
  const { faces, runs } = fakeFaces(assistantTail('x'))
  installObserver(ctx, faces)

  const listener = ctx.listeners[0]
  await listener({ id: 'session-not-mine' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(runs.length, 0, '陌生会话的 turn/end 不该触发回传')
})

test('不是 turn/end 的事件不触发回传', async () => {
  await seedBatch('session-child-other')
  const ctx = fakeCtx()
  const { faces, runs } = fakeFaces(assistantTail('x'))
  installObserver(ctx, faces)

  const listener = ctx.listeners[0]
  await listener({ id: 'session-child-other' }, { type: 'message', data: {} })
  assert.equal(runs.length, 0)
})

test('回传里带得上子会话的答复与跑过的命令', async () => {
  await seedBatch('session-child-body')
  const ctx = fakeCtx()
  const { faces, runs } = fakeFaces([
    ...assistantTail('最终答复：MM-E2E-FINAL'),
    ...bashTail('echo MM-E2E-FINAL'),
  ])
  installObserver(ctx, faces)

  await ctx.listeners[0](
    { id: 'session-child-body' },
    { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } },
  )

  assert.equal(runs.length, 1)
  assert.match(runs[0], /MM-E2E-FINAL/, '回传里没有子会话的实际答复')
  assert.match(runs[0], /跑过的命令/, '回传里没有命令清单')
  assert.match(runs[0], /状态: done/)
})

test('读历史失败时，回传照样到主会话，只是正文为空', async () => {
  await seedBatch('session-child-tailfail')
  const ctx = fakeCtx()
  const { faces, runs } = fakeFaces(null)
  faces.dispatcher.tail = async () => { throw new Error('游标越界') }
  installObserver(ctx, faces)

  await ctx.listeners[0](
    { id: 'session-child-tailfail' },
    { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } },
  )

  assert.equal(runs.length, 1, '读历史失败不该把整个回传吞掉')
  assert.match(runs[0], /\(没有文字答复\)/, '读不到正文时要说清楚是空的')
})

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})
