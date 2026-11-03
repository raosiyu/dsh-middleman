/**
 * 派发卡片的回归测试。
 *
 * 这张卡挂在对话流里，出错的表现是「一片空白」——在浏览器里很难一眼看出
 * 是没渲染还是没数据。所以把判断层拆成纯函数在这里盯住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { argsRawOf, argsOf, ticketView, modelOptions, TONE } from '../lib/card-model.js'

test('preparing 阶段没有参数可读', () => {
  assert.equal(argsRawOf('preparing', { name: 'dispatch_task' }), undefined)
  assert.deepEqual(argsOf('preparing', { name: 'dispatch_task' }), {})
})

test('start 阶段从 block.argsRaw 读参数', () => {
  const block = { argsRaw: JSON.stringify({ batchId: 'D-1', ticketId: 'T-1' }) }
  assert.equal(argsRawOf('start', block), block.argsRaw)
  assert.deepEqual(argsOf('start', block), { batchId: 'D-1', ticketId: 'T-1' })
})

test('result 阶段从 block.call.argsRaw 读参数', () => {
  const block = { call: { name: 'dispatch_task', argsRaw: JSON.stringify({ batchId: 'D-2', ticketId: 'T-2' }) } }
  assert.equal(argsRawOf('result', block), block.call.argsRaw)
  assert.deepEqual(argsOf('result', block), { batchId: 'D-2', ticketId: 'T-2' })
})

test('result 阶段不能去读 block.argsRaw（那里是空的）', () => {
  // 这就是最初那版卡片的 bug：写成 block.call?.argsRaw ?? block.argsRaw，
  // 在 start 阶段取到 undefined，在 result 阶段恰好能用——但如果反过来
  // 写成 block.argsRaw，result 阶段就永远拿不到参数。
  const resultBlock = { call: { argsRaw: '{"batchId":"D-3","ticketId":"T-3"}' } }
  assert.equal(resultBlock.argsRaw, undefined, 'result 阶段的 block 上没有 argsRaw')
  assert.deepEqual(argsOf('result', resultBlock), { batchId: 'D-3', ticketId: 'T-3' })
})

test('参数不是合法 JSON 时不当场崩，返回空', () => {
  assert.deepEqual(argsOf('start', { argsRaw: 'not json' }), {})
  assert.deepEqual(argsOf('result', { call: { argsRaw: '[1,2]' } }), {})
})

test('参数里缺 batchId 或 ticketId 时只给有的那个', () => {
  assert.deepEqual(argsOf('start', { argsRaw: '{"ticketId":"T-9"}' }), { ticketId: 'T-9' })
  assert.deepEqual(argsOf('start', { argsRaw: '{"batchId":"D-9"}' }), { batchId: 'D-9' })
})

test('卡片行：工单文件、要发送的内容、模型、推理强度', () => {
  const view = ticketView({
    id: 'T-1', title: '实现', status: 'suspended',
    source: '.scratch/x.md', payload: 'bash pwd', brief: 'fallback',
    model: { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
    effort: '中（medium）',
  })
  assert.deepEqual(view.fields, [
    ['工单文件', '.scratch/x.md'],
    ['要发送的内容', 'bash pwd'],
    ['模型', 'workbuddy/deepseek-v4.1-flash'],
    ['推理强度', '中（medium）'],
  ])
})

test('payload 缺了退回 brief', () => {
  const view = ticketView({ id: 'T-1', title: 'x', status: 'pending', brief: '备用正文' })
  const content = view.fields.find(([label]) => label === '要发送的内容')
  assert.deepEqual(content, ['要发送的内容', '备用正文'])
})

test('提示条：开始前 / 顺序 / 可以同时做的，缺的不占位', () => {
  const view = ticketView({
    id: 'T-1', title: 'x', status: 'pending',
    notes: { before: '先看 README', order: '05 再 04' },
  })
  assert.deepEqual(view.hints, [['开始前', '先看 README'], ['顺序', '05 再 04']])
})

test('已派发且没在跑 → 出现「执行」按钮', () => {
  const view = ticketView({ id: 'T-1', title: 'x', status: 'suspended', childSessionId: 'session-1' })
  assert.equal(view.buttons[0].kind, 'run')
  assert.equal(view.buttons[0].label, '执行')
})

test('正在跑 → 不给执行按钮', () => {
  const view = ticketView({ id: 'T-1', title: 'x', status: 'running', childSessionId: 'session-1' })
  assert.equal(view.buttons[0].kind, 'wait')
  assert.equal(view.buttons[0].label, '正在运行…')
})

test('还没派发 → 不给执行按钮，等前序工单', () => {
  const view = ticketView({ id: 'T-1', title: 'x', status: 'pending' })
  assert.equal(view.buttons[0].kind, 'wait')
  assert.equal(view.buttons[0].label, '等前序工单完成')
})

test('每个状态都有「有修改意见」按钮', () => {
  for (const status of ['pending', 'suspended', 'running', 'done', 'failed']) {
    const view = ticketView({ id: 'T-1', title: 'x', status })
    assert.equal(view.buttons.at(-1).label, '有修改意见', status)
  }
})

test('工单缺失时给出 missing 而不是崩', () => {
  const view = ticketView(undefined)
  assert.equal(view.kind, 'missing')
  assert.deepEqual(view.fields, [])
})

test('模型没定时写「未定模型」', () => {
  const view = ticketView({ id: 'T-1', title: 'x', status: 'pending' })
  const model = view.fields.find(([label]) => label === '模型')
  assert.deepEqual(model, ['模型', '未定模型'])
})

test('每个已知状态都有颜色', () => {
  for (const status of ['done', 'running', 'partial', 'failed', 'suspended', 'pending']) {
    assert.match(TONE[status], /^#[0-9a-f]{6}$/i, status)
  }
})

test('推理强度显示的是子会话真正会用的那个值，不是另一个近似字段', () => {
  // 真事故：卡片上写 low，子会话其实跑 high。
  //
  // 派发时钉模型传的是 ticket.model.reasoningEffort（lib/dispatch.js 里
  // session.selectModel 收的就是它），所以卡片必须以它为准。
  // ticket.effort 只是冗余字段，两个值各自写进去时就会打架。
  const view = ticketView({
    id: 'T-1', title: 'x', status: 'suspended',
    model: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
    effort: 'low',
  })
  const effort = view.fields.find(([label]) => label === '推理强度')
  assert.deepEqual(effort, ['推理强度', 'high'])
})

test('model 里没写推理强度时才退回 effort', () => {
  const view = ticketView({
    id: 'T-1', title: 'x', status: 'pending',
    model: { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
    effort: 'medium',
  })
  const effort = view.fields.find(([label]) => label === '推理强度')
  assert.deepEqual(effort, ['推理强度', 'medium'])
})

test('两个都没有时这一行不出现，不填占位话', () => {
  const view = ticketView({
    id: 'T-1', title: 'x', status: 'pending',
    model: { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
  })
  assert.equal(view.fields.find(([label]) => label === '推理强度'), undefined)
})

test('模型目录摊平成可选项，每项带着 provider 与 model', () => {
  const options = modelOptions({
    groups: [
      { id: 'workbuddy', name: 'WorkBuddy', models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' }] },
      { id: 'deepseek-account', name: 'DS', models: [{ id: 'deepseek-flash', name: 'Flash' }] },
    ],
  })

  assert.equal(options.length, 2)
  assert.deepEqual(options[0], {
    value: 'workbuddy/deepseek-v4.1-flash',
    provider: 'workbuddy',
    model: 'deepseek-v4.1-flash',
    label: 'workbuddy · DeepSeek-V4.1-Flash',
  })
  assert.equal(options[1].value, 'deepseek-account/deepseek-flash')
})

test('目录拿不到时摊成空数组，不抛错', () => {
  assert.deepEqual(modelOptions(undefined), [])
  assert.deepEqual(modelOptions(null), [])
  assert.deepEqual(modelOptions({}), [])
  assert.deepEqual(modelOptions({ groups: 'not-an-array' }), [])
})

test('目录里有缺字段的项就跳过那项，不让整张表废掉', () => {
  const options = modelOptions({
    groups: [
      { id: 'ok', models: [{ id: 'm1' }] },
      { models: [{ id: 'm2' }] },          // 没有 provider
      { id: 'also-ok', models: [null, { name: 'no-id' }] },
      null,
    ],
  })
  assert.deepEqual(options.map((o) => o.value), ['ok/m1'])
})

test('模型没有 name 时用 id 当标签', () => {
  const options = modelOptions({ groups: [{ id: 'p', models: [{ id: 'm' }] }] })
  assert.equal(options[0].label, 'p · m')
})
