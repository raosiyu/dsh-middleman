/**
 * 观察器的重复安装守卫。
 *
 * 这个 bug 是实跑撞出来的：插件反复重载，旧的监听器没卸干净，同一个
 * turn/end 被推了 N 次，主会话收到一串重复回报。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installObserver } from '../lib/observer.js'

/** 造一个只记录监听器的假 ctx。 */
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

test('同一个 ctx 上再装一次观察器，旧的那个被卸掉', () => {
  const ctx = fakeCtx()
  const first = installObserver(ctx, { dispatcher: {}, warn() {} })
  assert.equal(ctx.listeners.length, 1)

  const second = installObserver(ctx, { dispatcher: {}, warn() {} })
  assert.equal(ctx.listeners.length, 1, '不该有两个监听器并存')
  assert.notEqual(first, second)
})

test('卸载之后监听器真的没了', () => {
  const ctx = fakeCtx()
  const uninstall = installObserver(ctx, { dispatcher: {}, warn() {} })
  assert.equal(ctx.listeners.length, 1)
  uninstall()
  assert.equal(ctx.listeners.length, 0)
})

test('不同的 ctx 各自装，互不干扰', () => {
  const a = fakeCtx()
  const b = fakeCtx()
  installObserver(a, { dispatcher: {}, warn() {} })
  installObserver(b, { dispatcher: {}, warn() {} })
  assert.equal(a.listeners.length, 1)
  assert.equal(b.listeners.length, 1)
})
