/**
 * 派发卡片的可视验证台（页面入口）。
 *
 * 为什么需要它：真对话流里的卡片被「对话流虚拟化 + 我这一轮自己还在往里
 * 追加内容」两件事夹住，截图永远截不到——卡片在 DOM 里，但不在视口里，
 * 而且它随时会被回收重建。
 *
 * 所以这里换一条路：把**仓库里那一份** lib/client.js 原封不动装进页面，
 * 喂**真实账本里的工单**，用真 React 真 DOM 渲染。渲染的是同一份代码、
 * 同一份数据，只是不受对话流虚拟化影响——于是截图是确定的。
 *
 * 页面由 scripts/visual-harness.mjs 用 esbuild 打包后生成。
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import clientSource from '../lib/client.js?raw'

const h = React.createElement

// client.js 按 DSH 的客户端模块协议注册自己：window.__ModuleLoader__.load。
// 这里给它一个真协议形状的桩，把工厂拿下来，工厂要 React 就给 React。
let registered = null

window.__ModuleLoader__ = {
  load(spec) {
    const module = spec.factory((name) => {
      if (name === 'react') return React
      throw new Error('验证台不支持的依赖：' + name)
    })

    const ctx = {
      slots: {
        inject(slotName, register) {
          const entry = register()
          if (slotName === 'tool.call.toolview') registered = entry
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
}

// client.js 是副作用脚本：执行到这里它已经注册好了。
// eslint-disable-next-line no-new-func
new Function(clientSource)()

const batchId = new URLSearchParams(location.search).get('batchId')
const ticketId = new URLSearchParams(location.search).get('ticketId')

async function boot() {
  const root = createRoot(document.getElementById('root'))

  // 卡片自己会去 /dsh-middleman/api/state?batchId=… 拿工单，
  // 验证台的服务器把这条请求代理到真插件，数据是真的。
  const res = await fetch('/dsh-middleman/api/state?batchId=' + encodeURIComponent(batchId))
  const state = await res.json()
  const ticket = (state.batch?.tickets ?? []).find((t) => t.id === ticketId)
  if (ticket === undefined) {
    root.render(h('div', { className: 'label' }, '批次里没有工单 ' + ticketId))
    return
  }

  const Card = registered.component
  root.render(h('div', { className: 'stage' }, [
    h('p', { key: 'label', className: 'label' }, '对话流里的派发卡片（tool.call.toolview → dispatch_task）'),
    h(Card, {
      key: 'card',
      phase: 'result',
      block: { call: { argsRaw: JSON.stringify({ batchId, ticketId }) } },
    }),
  ]))

  // 卡片是异步拿数据的；给宿主一个明确信号，好让截图脚本等它。
  await new Promise((r) => setTimeout(r, 800))
  document.body.dataset.cardReady = '1'
}

boot().catch((err) => {
  document.getElementById('root').innerHTML =
    '<pre style="color:#dc2626;white-space:pre-wrap">' + String(err?.stack ?? err) + '</pre>'
  document.body.dataset.cardError = String(err?.message ?? err)
})
