/**
 * 派发与回传的接线回归：默认模型恢复（R-1 的邻居）、挂起不发消息、
 * turn/end 分类（R-2）、回报文本。
 *
 * 跑法：node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDispatcher, lastAssistantText, summarize } from '../lib/dispatch.js'
import { classifyTurnEnd } from '../lib/core.js'
import { reportText } from '../lib/observer.js'

/** 造一个记录调用的假网关。 */
function fakeGateway(overrides = {}) {
  const calls = []
  const invoke = async ({ namespace, method, args }) => {
    calls.push({ namespace, method, args })
    if (method === 'create') return { sessionId: 'session-fake-1' }
    if (method === 'selectModel') {
      return { selected: { provider: args.request.provider, model: args.request.model } }
    }
    if (method === 'modelCatalog') return { groups: [] }
    if (method === 'page') return { events: [] }
    return {}
  }
  return { calls, gateway: { invoke }, ...overrides }
}

test('派发顺序是 create → rename → selectModel，且不发第一条消息', async () => {
  const { calls, gateway } = fakeGateway()
  const dispatcher = createDispatcher({ gateway: () => gateway, peer: () => ({}) })
  const result = await dispatcher.spawn({ id: 'T-1', title: '测试工单', brief: 'b', model: { provider: 'p', model: 'm' } })
  assert.equal(result.sessionId, 'session-fake-1')
  assert.deepEqual(calls.map((c) => c.method), ['create', 'rename', 'selectModel'])
  assert.equal(calls.some((c) => c.method === 'prompt'), false, '挂起态不能发 prompt')
})

test('派发前读到的默认模型，派完要恢复（R-1 邻居）', async () => {
  const { gateway } = fakeGateway()
  const saved = []
  let current = { provider: 'deepseek', model: 'deepseek-chat' }
  const dispatcher = createDispatcher({
    gateway: () => gateway,
    peer: () => ({}),
    defaultModel: () => current,
    defaultModelSave: async (selection) => {
      saved.push(selection)
      current = selection
    },
  })
  await dispatcher.spawn({ id: 'T-1', title: 't', brief: 'b', model: { provider: 'p', model: 'm' } })
  assert.deepEqual(saved, [{ provider: 'deepseek', model: 'deepseek-chat' }], '应当把原默认写回去')
  assert.deepEqual(current, { provider: 'deepseek', model: 'deepseek-chat' })
})

test('模型钉不上时也要恢复默认模型', async () => {
  const calls = []
  const gateway = {
    invoke: async ({ method }) => {
      calls.push(method)
      if (method === 'create') return { sessionId: 'session-x' }
      if (method === 'selectModel') throw new Error('model-unavailable')
      return {}
    },
  }
  const saved = []
  const dispatcher = createDispatcher({
    gateway: () => gateway,
    peer: () => ({}),
    defaultModel: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    defaultModelSave: async (selection) => { saved.push(selection) },
  })
  await assert.rejects(
    () => dispatcher.spawn({ id: 'T-1', title: 't', brief: 'b', model: { provider: 'p', model: 'm' } }),
    (error) => error.code === 'model-pin-failed',
  )
  assert.equal(saved.length, 1, '失败路径也要恢复默认模型')
})

test('没有网关时给出可读拒绝', async () => {
  const dispatcher = createDispatcher({ gateway: () => undefined, peer: () => ({}) })
  await assert.rejects(
    () => dispatcher.spawn({ id: 'T-1', title: 't', brief: 'b' }),
    (error) => error.code === 'gateway-unavailable' || error.code === 'session-create-failed',
  )
})

test('执行就是给挂起的会话发一条 queue 消息', async () => {
  const { calls, gateway } = fakeGateway()
  const dispatcher = createDispatcher({ gateway: () => gateway, peer: () => ({}) })
  await dispatcher.run('session-fake-1', '开始干活')
  const prompt = calls.find((c) => c.method === 'prompt')
  assert.equal(prompt.args.request.mode, 'queue')
  assert.equal(prompt.args.request.content[0].text, '开始干活')
})

test('追加指令走 steer', async () => {
  const { calls, gateway } = fakeGateway()
  const dispatcher = createDispatcher({ gateway: () => gateway, peer: () => ({}) })
  await dispatcher.steer('session-fake-1', '换个方向')
  assert.equal(calls.find((c) => c.method === 'prompt').args.request.mode, 'steer')
})

test('从历史里取最后一轮助手答复', () => {
  const events = [
    { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第一轮' }] } } } },
    { event: { type: 'tool/call', data: { name: 'bash', arguments: '{}' } } },
    { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '最后一轮' }] } } } },
  ]
  assert.equal(lastAssistantText(events), '第一轮\n最后一轮')
})

test('摘要从事件里算，不靠子会话自觉写', () => {
  const events = [
    { event: { type: 'tool/call', data: { name: 'edit', arguments: JSON.stringify({ file_path: 'src/a.ts' }) } } },
    { event: { type: 'tool/call', data: { name: 'write', arguments: JSON.stringify({ file_path: 'src/b.ts' }) } } },
    { event: { type: 'tool/call', data: { name: 'bash', arguments: JSON.stringify({ command: 'npm test\n更多' }) } } },
  ]
  const summary = summarize(events)
  assert.deepEqual(summary.files, ['src/a.ts', 'src/b.ts'])
  assert.deepEqual(summary.commands, ['npm test'])
})

test('回报文本带状态、文件、风险与原文', () => {
  const batch = {
    id: 'D-1',
    title: '演示',
    risks: [{ id: 'R-1', title: '截断', trigger: 't', impact: 'i', mitigation: 'm', verification: '跑单测' }],
  }
  const ticket = { id: 'T-1', title: '实现', riskIds: ['R-1'] }
  const text = reportText(batch, ticket, classifyTurnEnd({ kind: 'max-tokens' }), '做完了', { files: ['a.ts'], commands: ['npm test'] })
  assert.ok(text.includes('状态: partial'))
  assert.ok(text.includes('a.ts'))
  assert.ok(text.includes('R-1'))
  assert.ok(text.includes('跑单测'))
  assert.ok(text.includes('做完了'))
})

test('派发返回的模型保留推理强度——宿主回包不带它', async () => {
  // 真事故：spawn 钉模型时传了 reasoningEffort，但宿主回包的 selected
  // 不带这个字段（fakeGateway 就是照宿主的样子造的）。
  // dispatch_task 拿回包整个覆盖 ticket.model，用户设的强度就丢了，
  // 卡片上「推理强度」那行跟着空掉。
  //
  // 判据：强度以**我们钉进去的那个**为准。
  const { calls, gateway } = fakeGateway()
  const dispatcher = createDispatcher({ gateway: () => gateway, peer: () => ({}) })

  const spawned = await dispatcher.spawn({
    id: 'T-1', title: '票', brief: '干活',
    model: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
  })

  assert.equal(spawned.model.reasoningEffort, 'high', '推理强度在派发后丢了')

  // 钉模型时确实传了它。
  const select = calls.find((c) => c.method === 'selectModel')
  assert.equal(select.args.request.reasoningEffort, 'high')
})

test('宿主回包带的强度会被采纳（用户没写但宿主认了）', async () => {
  // 宿主可能自己挑一个强度并回来说明——用户没写时，那个值就是真相。
  const gateway = {
    invoke: async ({ method }) => {
      if (method === 'create') return { sessionId: 'session-x' }
      if (method === 'selectModel') {
        return { selected: { provider: 'p', model: 'm', reasoningEffort: 'medium' } }
      }
      return {}
    },
  }
  const dispatcher = createDispatcher({ gateway: () => gateway, peer: () => ({}) })

  const spawned = await dispatcher.spawn({
    id: 'T-1', title: '票', brief: '干活',
    model: { provider: 'p', model: 'm' },
  })

  assert.equal(spawned.model.reasoningEffort, 'medium')
})
