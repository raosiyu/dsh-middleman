/**
 * 浏览器 bundle 的运行时守卫。
 *
 * 为什么要有这条：client-bundle.test.mjs 只做文本比对，它拦得住「两份漂移」，
 * 拦不住「引用了一个不存在的东西」。真出过这么一次：badge() 里写的是裸的
 * TONE，而 TONE 住在 cardModel 的闭包里，浏览器一渲染就抛
 * ReferenceError: TONE is not defined，整张派发卡片直接空白——
 * 而文本比对全绿，因为两份确实一致。
 *
 * 所以这里不比对文本，直接把 bundle 跑起来：塞一个假的 window.__ModuleLoader__
 * 和一个极简 React 桩，把 factory 拿出来，apply 到一个假的 ctx 上，
 * 再把注册下来的组件真的渲染一遍。运行时报错就是失败。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

/**
 * 一个极简 React 桩。
 *
 * 只够渲染「不依赖真实调度」这条路径：createElement 造出树，
 * 一个 children 用函数包起来的渲染器把它走一遍，hooks 按调用顺序返回初值。
 *
 * 刻意不实现真实 React 的调度与重渲染：DispatchCard 与 TicketRow
 * 都用 hooks，真 React 不在依赖里。这里要守的是「渲染时会不会抛
 * ReferenceError」，不是「交互与状态更新对不对」——后者由浏览器里的
 * 手工验证与 card-model 的纯函数单测负责。
 *
 * useState 可以被播种（seed）：组件内部拿到的状态因此可以指定，
 * 好让渲染真正走到渲染期的深层分支——比如 badge()。
 */
function makeReactStub() {
  const createElement = (type, props, ...children) => {
    const flat = []
    const push = (child) => {
      if (Array.isArray(child)) child.forEach(push)
      else if (child !== null && child !== undefined && child !== false) flat.push(child)
    }
    children.forEach(push)
    return { type, props: props ?? {}, children: flat }
  }

  // hooks 按调用顺序返回初值：一个组件实例内从 0 开始计数。
  let hookIndex = 0
  const seeded = new Map()

  return {
    createElement,
    useState: (initial) => {
      hookIndex += 1
      const value = seeded.has(hookIndex)
        ? seeded.get(hookIndex)
        : (typeof initial === 'function' ? initial() : initial)
      return [value, () => {}]
    },
    useEffect: () => { hookIndex += 1 },
    useCallback: (fn) => { hookIndex += 1; return fn },
    useMemo: (fn) => { hookIndex += 1; return fn() },
    useRef: (initial) => { hookIndex += 1; return { current: initial } },
    __resetHooks: () => { hookIndex = 0 },
    __seed: (index, value) => { seeded.set(index, value) },
    __clearSeed: () => { seeded.clear() },
  }
}

/**
 * 把 bundle 加载起来，拿到 apply 与注册的组件。
 *
 * @param fetchStub - 可选的 fetch 桩。
 * @returns {{ registrations: Map<string, Object>, React: Object }}
 */
function loadBundle(fetchStub) {
  const registrations = new Map()
  const injected = new Map()
  const React = makeReactStub()

  const fakeWindow = {
    __ModuleLoader__: {
      load(spec) {
        assert.equal(spec.id, 'dsh-whale-tail')
        const module = spec.factory(() => React)

        const ctx = {
          slots: {
            inject(slotName, register) {
              const entry = register()
              injected.set(slotName, entry)
              registrations.set(slotName, entry)
              return () => {}
            },
            register(entry, component) {
              return { ...entry, component }
            },
          },
        }

        module.apply(ctx)
        return module
      },
    },
  }

  const fallbackFetch = async () => ({
    json: async () => ({ ok: false, error: 'offline' }),
  })

  // bundle 直接摸 window，用间接 eval 在带 window 的作用域里跑。
  const runner = new Function('window', 'fetch', `${source}\n;return window;`)
  runner(fakeWindow, fetchStub ?? fallbackFetch)

  return { registrations, injected, React }
}

/** 一张够用的工单：模型、字段、提示都在。 */
const SAMPLE_TICKET = {
  id: 'T-1',
  title: '闸门验证票',
  status: 'suspended',
  source: '.scratch/demo/T-1.md',
  payload: '跑一遍闸门校验',
  model: { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'medium' },
  effort: 'medium',
  modelReason: '快',
  notes: { before: '先读 README', order: '先做这个', parallel: '可以和 T-2 并行' },
  childSessionId: 'session-child-1',
}

/**
 * 把 React 桩造出来的树走一遍，触发所有渲染期的求值。
 *
 * 函数组件要被真的调用一次，否则组件体内的求值根本不会发生——
 * 那正是越界引用（ReferenceError）藏身的地方。
 *
 * @param node - 树节点。
 * @param React - React 桩，用于在每个组件实例前重置 hook 计数。
 */
function render(node, React) {
  if (node === null || node === undefined || typeof node === 'string') return
  if (Array.isArray(node)) {
    node.forEach((child) => render(child, React))
    return
  }
  if (typeof node !== 'object') return

  if (typeof node.type === 'function') {
    React.__resetHooks()
    const rendered = node.type(node.props)
    render(rendered, React)
    return
  }
  render(node.children, React)
}

test('bundle 能加载并注册三个槽位', () => {
  const { registrations } = loadBundle()
  assert.ok(registrations.has('sidebar.panellist'), '没注册侧边栏行')
  assert.ok(registrations.has('tool.call.toolview'), '没注册对话流里的派发卡片')
  assert.ok(registrations.has('main'), '没注册主栏页面')
})

test('tool.call.toolview 注册在 dispatch_task 这个键上', () => {
  const { registrations } = loadBundle()
  const entry = registrations.get('tool.call.toolview')
  assert.equal(entry.key, 'dispatch_task')
  assert.equal(entry.name, 'tool.call.toolview')
})

test('渲染派发卡片不会抛 ReferenceError（守卫 TONE 这类越界引用）', () => {
  // fetch 桩：把工单喂回去，让卡片真的走到渲染主体（那里才有 badge()）。
  const fetchStub = async (url) => ({
    json: async () => ({
      ok: true,
      batch: { id: 'D-1', title: '演示批次', status: 'approved', tickets: [SAMPLE_TICKET] },
    }),
  })

  const { registrations, React } = loadBundle(fetchStub)
  const component = registrations.get('tool.call.toolview').component

  // 三个阶段都走一遍：参数来源不同，任何一个阶段写错都会在这里炸。
  const block = {
    argsRaw: JSON.stringify({ batchId: 'D-1', ticketId: 'T-1' }),
    call: { argsRaw: JSON.stringify({ batchId: 'D-1', ticketId: 'T-1' }) },
  }

  assert.doesNotThrow(() => {
    render(component({ phase: 'preparing', block: {} }), React)
    render(component({ phase: 'start', block }), React)
    render(component({ phase: 'result', block }), React)
  })
})

test('派发卡片在拿到工单后会渲染出 badge 与表格', () => {
  // fetch 桩：把工单喂回去，让卡片真的走到渲染主体（那里才有 badge()）。
  const fetchStub = async () => ({
    json: async () => ({
      ok: true,
      batch: { id: 'D-1', title: '演示批次', status: 'approved', tickets: [SAMPLE_TICKET] },
    }),
  })

  const { registrations, React } = loadBundle(fetchStub)
  const component = registrations.get('tool.call.toolview').component

  // 播种 useState：DispatchCard 的第一个 hook 是 state，
  // 把它设成「已加载并带着工单」，这样渲染不会停在 loading 分支。
  React.__seed(1, { loading: false, ticket: SAMPLE_TICKET })

  const tree = component({
    phase: 'result',
    block: { call: { argsRaw: JSON.stringify({ batchId: 'D-1', ticketId: 'T-1' }) } },
  })

  const texts = []
  const collect = (node) => {
    if (node === null || node === undefined) return
    if (typeof node === 'string') { texts.push(node); return }
    if (Array.isArray(node)) { node.forEach(collect); return }
    if (typeof node !== 'object') return
    // 函数组件要真的调用一次，里面的文案才在树上。
    if (typeof node.type === 'function') {
      React.__resetHooks()
      collect(node.type(node.props))
      return
    }
    collect(node.children)
  }
  collect(tree)

  // 提示块的文案是「开始前：xxx」这样拼的，所以按包含判断，不按整串相等。
  const hasText = (fragment) => texts.some((text) => text.includes(fragment))

  // badge 的状态文案
  assert.ok(hasText('suspended'), '卡片上没渲染出状态徽标')
  // 表格的四行
  assert.ok(hasText('工单文件'), '卡片上没渲染出「工单文件」这一行')
  assert.ok(hasText('要发送的内容'), '卡片上没渲染出「要发送的内容」这一行')
  assert.ok(hasText('模型'), '卡片上没渲染出「模型」这一行')
  assert.ok(hasText('推理强度'), '卡片上没渲染出「推理强度」这一行')
  // 提示块
  assert.ok(hasText('开始前'), '卡片上没渲染出提示块的「开始前」')
  assert.ok(hasText('顺序'), '卡片上没渲染出提示块的「顺序」')
  assert.ok(hasText('可以同时做的'), '卡片上没渲染出提示块的「可以同时做的」')
  // 按钮
  assert.ok(hasText('执行'), '卡片上没渲染出「执行」按钮')
  assert.ok(hasText('有修改意见'), '卡片上没渲染出「有修改意见」按钮')

  React.__clearSeed()
})

test('渲染中台页与批次卡片不会抛 ReferenceError', () => {
  const fetchStub = async () => ({
    json: async () => ({
      ok: true,
      batches: [{ id: 'D-1', title: '演示批次', status: 'approved' }],
      batch: { id: 'D-1', title: '演示批次', status: 'approved', tickets: [SAMPLE_TICKET] },
    }),
  })

  const { registrations, React } = loadBundle(fetchStub)
  const page = registrations.get('main').component
  assert.doesNotThrow(() => render(page({}), React))
})

test('卡片上渲染出换模型的下拉，并列出目录里的模型', () => {
  // 「用户可以调整模型」那条需求的 UI 落点。
  //
  // 目录从 /models 拿：卡片自己会去读，所以 fetch 桩要认这条路径。
  const fetchStub = async (url) => {
    if (String(url).includes('/models')) {
      return {
        json: async () => ({
          ok: true,
          catalog: {
            groups: [
              { id: 'workbuddy', name: 'WorkBuddy', models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' }] },
              { id: 'deepseek-account', name: 'DS', models: [{ id: 'deepseek-flash', name: 'Flash' }] },
            ],
          },
        }),
      }
    }
    return {
      json: async () => ({
        ok: true,
        batch: { id: 'D-1', title: '演示批次', status: 'approved', tickets: [SAMPLE_TICKET] },
      }),
    }
  }

  const { registrations, React } = loadBundle(fetchStub)
  const component = registrations.get('tool.call.toolview').component

  // DispatchCard 的 hook 顺序：1=state（工单），2=目录。
  React.__seed(1, { loading: false, ticket: SAMPLE_TICKET })
  React.__seed(2, {
    groups: [
      { id: 'workbuddy', name: 'WorkBuddy', models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' }] },
      { id: 'deepseek-account', name: 'DS', models: [{ id: 'deepseek-flash', name: 'Flash' }] },
    ],
  })

  const tree = component({
    phase: 'result',
    block: { call: { argsRaw: JSON.stringify({ batchId: 'D-1', ticketId: 'T-1' }) } },
  })

  const texts = []
  let selects = 0
  const collect = (node) => {
    if (node === null || node === undefined) return
    if (typeof node === 'string') { texts.push(node); return }
    if (Array.isArray(node)) { node.forEach(collect); return }
    if (typeof node !== 'object') return
    if (node.type === 'select') selects += 1
    if (typeof node.type === 'function') {
      React.__resetHooks()
      collect(node.type(node.props))
      return
    }
    collect(node.children)
  }
  collect(tree)

  assert.equal(selects, 1, '卡片上没有换模型的下拉')
  const hasText = (fragment) => texts.some((text) => text.includes(fragment))
  assert.ok(hasText('换个模型'), '下拉没有提示文案')
  assert.ok(hasText('workbuddy · DeepSeek-V4.1-Flash'), '下拉里没有目录中的模型')
  assert.ok(hasText('deepseek-account · Flash'), '下拉里没有第二个 provider 的模型')

  React.__clearSeed()
})

test('拿不到模型目录时卡片照常渲染，只是不给下拉', () => {
  // 目录是可选的：拿不到不该让整张卡挂掉。
  const fetchStub = async (url) => {
    if (String(url).includes('/models')) {
      return { json: async () => ({ ok: false, error: 'catalog-unavailable' }) }
    }
    return {
      json: async () => ({
        ok: true,
        batch: { id: 'D-1', title: '演示批次', status: 'approved', tickets: [SAMPLE_TICKET] },
      }),
    }
  }

  const { registrations, React } = loadBundle(fetchStub)
  const component = registrations.get('tool.call.toolview').component

  React.__seed(1, { loading: false, ticket: SAMPLE_TICKET })
  React.__seed(2, null)

  const tree = component({
    phase: 'result',
    block: { call: { argsRaw: JSON.stringify({ batchId: 'D-1', ticketId: 'T-1' }) } },
  })

  let selects = 0
  const collect = (node) => {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) { node.forEach(collect); return }
    if (typeof node !== 'object') return
    if (node.type === 'select') selects += 1
    if (typeof node.type === 'function') {
      React.__resetHooks()
      collect(node.type(node.props))
      return
    }
    collect(node.children)
  }
  collect(tree)

  assert.equal(selects, 0, '没有目录却给了个空下拉')

  React.__clearSeed()
})
