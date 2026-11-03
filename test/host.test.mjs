/**
 * 宿主半区的装载冒烟：用假 ctx 调 apply，确认工具、路由、观察器、提示段
 * 都真的注册上了，而不是静默缺席。
 *
 * 跑法：node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject, PROMPT_TEXT } from '../lib/index.js'

/** 造一个够用的假上下文。 */
function fakeCtx() {
  const registered = { tools: [], routes: [], sections: [], effects: [], listeners: [] }
  const ctx = {
    tools: {
      register(definition) {
        registered.tools.push(definition)
        return () => {}
      },
    },
    webServer: {
      register(route) {
        registered.routes.push(route)
        return () => {}
      },
    },
    systemPrompt: {
      section(section) {
        registered.sections.push(section)
        return () => {}
      },
    },
    typertGateway: {
      invoke: async ({ method }) => (method === 'modelCatalog' ? { groups: [] } : { sessionId: 'session-smoke' }),
    },
    llm: {
      listProviders: () => [{ id: 'fake', name: 'Fake' }],
      listModels: async () => [{ id: 'm1', name: 'M1' }],
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'fake', model: 'm1' }),
      saveSelection: async () => {},
    },
    on(name, listener) {
      registered.listeners.push({ name, listener })
      return () => {}
    },
    // cordis 的 ctx.effect 立即执行回调并登记卸载，假上下文照这个语义来，
    // 否则测试会漏掉「注册根本没发生」这类问题。
    effect(fn) {
      registered.effects.push(fn)
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    logger: { warn() {} },
  }
  return { ctx, registered }
}

test('inject 声明了全部必需服务', () => {
  // 少一个都会在运行时报 "cannot get property X without inject"，
  // 所以这条测试盯住的是那份清单本身。
  assert.deepEqual(inject, [
    'tools', 'typertGateway', 'webServer', 'llm', 'systemPrompt', 'agentDefaultModel',
  ])
})

test('apply 注册了十个工具', () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx, { enabled: true, announceToAgent: true })
  assert.equal(registered.tools.length, 10)
  const names = registered.tools.map((t) => t.name).sort()
  assert.deepEqual(names, [
    'design_answer', 'design_converge', 'design_open', 'design_plan',
    'design_question', 'design_round', 'design_split',
    'dispatch_task', 'middleman_status', 'request_confirmation',
  ])
})

test('工具面里没有 approve —— 模型不能批准自己的设计', () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx, { enabled: true })
  const names = registered.tools.map((t) => t.name)
  assert.equal(names.some((name) => name.includes('approve')), false)
})

test('apply 注册了八个路由，且都在本插件前缀下', () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx, { enabled: true })
  // effect 已经在 apply 里执行过了，这里不再重复调用，否则会重复注册。
  assert.equal(registered.routes.length, 8)
  for (const route of registered.routes) {
    assert.ok(route.path.startsWith('/whale-tail/api'), route.path)
    assert.equal(typeof route.handler, 'function')
  }
})

test('修改意见那条路由存在：卡片上的按钮要能写回主会话', () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx, { enabled: true })
  const feedback = registered.routes.find((route) => route.path === '/whale-tail/api/feedback')
  assert.ok(feedback !== undefined, '必须有 /feedback：卡片上的「有修改意见」按钮打它')
  assert.equal(feedback.kind, 'exact')
})

test('执行按钮那条路由存在，且是精确匹配', () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx, { enabled: true })
  const run = registered.routes.find((route) => route.path === '/whale-tail/api/run')
  assert.ok(run !== undefined, '必须有 /run：它就是执行按钮打的那一下')
  assert.equal(run.kind, 'exact')
})

test('apply 装了一个 turn/end 观察器', () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx, { enabled: true })
  assert.equal(registered.listeners.some((l) => l.name === 'session/event'), true)
})

test('apply 注册了系统提示段', () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx, { enabled: true, announceToAgent: true })
  assert.equal(registered.sections.length, 1)
  assert.equal(registered.sections[0].text(), PROMPT_TEXT)
})

test('announceToAgent 关掉时不注入提示段', () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx, { enabled: true, announceToAgent: false })
  assert.equal(registered.sections.length, 0)
})

test('enabled: false 时什么都不注册', () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx, { enabled: false })
  assert.equal(registered.tools.length, 0)
  assert.equal(registered.routes.length, 0)
  assert.equal(registered.sections.length, 0)
})

test('缺服务时仍然装载，只是那部分缺席', () => {
  const ctx = { logger: { warn() {} }, effect: () => () => {}, on: () => () => {} }
  assert.doesNotThrow(() => apply(ctx, { enabled: true }))
})
