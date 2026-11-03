/**
 * 派发层闸门的自检探针。
 *
 * lib/dispatch.js 的第一道闸：宿主网关不在时，createDispatcher 的每个方法
 * 都要抛「gateway-unavailable」——而不是 undefined 行为或半途 TypeError。
 *
 * 这条闸是静默的：正常部署永远走不到它，于是被人删掉也没人知道，直到
 * 哪天真没有网关，派发变成一堆看不懂的 TypeError。
 *
 * 探针做两件事（形状照抄 observer.mjs，别处对账脚本按这个形状数探针）：
 *
 * 1. **源码锚点**：那句 throw 还在。注释要先剥——core.mjs 的注释里也写着
 *    判据措辞，不剥的话「把判据注释掉」会让探针假绿。
 * 2. **行为**：真的建一个没有 gateway 的 dispatcher，spawn 一次，断言抛出的
 *    是带 gateway-unavailable 码的可读拒绝。
 *
 * 反面对照：**带** gateway 的 dispatcher 不走这道闸——spawn 一个假会话
 * 能正常返回。没有对照的话，一个「什么都拒」的实现也能让断言全绿。
 *
 * @module dsh-whale-tail/scripts/gates/dispatch
 */
import { readFileSync } from 'node:fs'

import { createDispatcher } from '../../lib/dispatch.js'

/** 派发层源码的位置。 */
const SOURCE_URL = new URL('../../lib/dispatch.js', import.meta.url)

/** 剥掉 JS 源码里的注释（抄 scripts/gates/core.mjs 的实现，理由同那里）。 */
function stripComments(source) {
  let out = ''
  let index = 0
  while (index < source.length) {
    const ch = source[index]
    const next = source[index + 1]
    if (ch === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index++
      continue
    }
    if (ch === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index++
      index += 2
      out += ' '
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      out += ch
      index++
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\') { out += source[index] + (source[index + 1] ?? ''); index += 2; continue }
        out += source[index]
        index++
      }
      out += quote
      index++
      continue
    }
    out += ch
    index++
  }
  return out
}

/** 断言小助手：不满足就记进 problems。 */
function must(condition, message, problems) {
  if (!condition) problems.push(message)
}

/** 源码锚点：判据原文必须还在。 */
function anchorProblems(source, anchors) {
  const problems = []
  for (const anchor of anchors) {
    if (!source.includes(anchor.text)) {
      problems.push('源码锚点丢了：' + anchor.why + '（找不到 ' + JSON.stringify(anchor.text) + '）')
    }
  }
  return problems
}

export const probes = [
  {
    id: 'g-dispatch-gateway',
    title: '派发层：没有宿主网关时，spawn 要给可读拒绝',
    covers: ['dispatch.js#error:createDispatcher/gateway-unavailable/', 'dispatch.js#error:'],
    probe: async () => {
      const problems = anchorProblems(stripComments(readFileSync(SOURCE_URL, 'utf8')), [
        { text: "MiddlemanError('gateway-unavailable'", why: '「没网关就抛可读拒绝」这一条判据' },
      ])

      // 行为：没网关时，spawn 必须抛带这个码的可读拒绝。
      const d = createDispatcher({ warn() {} })
      let caught
      try {
        await d.spawn({ id: 'T-1', title: 't', brief: 'b' }, { cwd: '/tmp' })
      } catch (error) {
        caught = error
      }
      must(caught !== undefined, '没有网关时 spawn 竟然成功了', problems)
      must(
        caught?.code === 'gateway-unavailable',
        '没网关时抛的是 ' + (caught?.code ?? caught?.constructor?.name) + '，不是 gateway-unavailable',
        problems,
      )

      // 反面对照：有网关时 spawn 能正常走通。
      const withGw = createDispatcher({
        warn() {},
        gateway: () => ({
          async invoke({ method }) {
            if (method === 'create') return { sessionId: 'session-check' }
            return {}
          },
        }),
        peer: () => ({ id: 'p', signal: new AbortController().signal }),
        defaultModel: () => undefined,
        defaultModelSave: async () => {},
      })
      let spawned
      try {
        spawned = await withGw.spawn({ id: 'T-1', title: 't', brief: 'b' }, { cwd: '/tmp' })
      } catch (error) {
        must(false, '有网关时 spawn 反而抛了：' + error.message, problems)
      }
      must(spawned?.sessionId === 'session-check', '有网关时 spawn 没拿到会话 id', problems)

      return problems
    },
  },
]
