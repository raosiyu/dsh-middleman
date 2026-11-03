/**
 * 派发卡片的可视验证台。
 *
 * 为什么需要它：真对话流里的卡片被「对话流虚拟化 + 我这一轮自己还在往里
 * 追加内容」两件事夹住，截图永远截不到——卡片在 DOM 里，但不在视口里，
 * 而且它随时会被回收重建。
 *
 * 所以这里换一条路：把**仓库里那一份** lib/client.js 原封不动装进页面，
 * 喂**真实账本里的工单**，用真 React 真 DOM 渲染。渲染的是同一份代码、
 * 同一份数据，只是不受对话流虚拟化影响——于是截图是确定的。
 *
 * 流程：
 *   1. esbuild 把 scripts/harness-entry.jsx 打成单文件（含 React）；
 *   2. 起一个本地服务器：页面 + /dsh-middleman/api/* 代理到真插件；
 *   3. 用 CDP 打开页面、等卡片渲染完、截图。
 *
 * 依赖（React 与 esbuild 只在验证时用，不进插件运行时）：
 *   mkdir -p /tmp/mm-harness && cd /tmp/mm-harness && npm init -y && npm i react react-dom esbuild
 * 环境变量 MM_HARNESS_MODULES 可以指到别处。
 *
 * 用法：node scripts/visual-harness.mjs <batchId> <ticketId> <outDir>
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [, , batchId, ticketId, outDir] = process.argv
const APP = process.env.APP_URL ?? 'http://127.0.0.1:49624'
const PORT = Number(process.env.CDP_PORT ?? 55643)
const MODULES = process.env.MM_HARNESS_MODULES ?? '/tmp/mm-harness/node_modules'

if (!batchId || !ticketId || !outDir) {
  console.error('用法：node scripts/visual-harness.mjs <batchId> <ticketId> <outDir>')
  process.exit(1)
}

await mkdir(outDir, { recursive: true })

// 1. 打包：页面里带真 React + 真 client.js。
// 只有 lib/client.js 按文本原样装进去（它不是普通 ESM，是副作用脚本）；
// 其余 .js 走正常解析。
const textPlugin = {
  name: 'raw-client',
  setup(build) {
    build.onLoad({ filter: /lib\/client\.js$/ }, async (args) => ({
      contents: await readFile(args.path, 'utf8'),
      loader: 'text',
    }))
  },
}

const { build } = await import(pathToFileURL(join(MODULES, 'esbuild/lib/main.js')).href)

const result = await build({
  entryPoints: [new URL('./harness-entry.jsx', import.meta.url).pathname],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  write: false,
  plugins: [textPlugin],
  define: { 'process.env.NODE_ENV': '"production"' },
  nodePaths: [MODULES],
})
const bundle = result.outputFiles[0].text

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>派发卡片可视验证台</title>
<style>
  body {
    margin: 0; padding: 28px 32px;
    background: #ffffff; color: #111827;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", Arial, sans-serif;
  }
  .label {
    font-size: 11px; letter-spacing: .1em; text-transform: uppercase;
    color: #6b7280; margin: 0 0 10px;
  }
  .stage {
    max-width: 720px; border: 1px dashed #d1d5db; border-radius: 12px;
    padding: 20px; background: #fcfcfd;
  }
</style>
</head>
<body>
  <div id="root"></div>
  <script>${bundle}</script>
</body>
</html>
`

// 2. 起服务器：静态页 + 把插件的 API 原样代理过去。
const server = createServer(async (req, res) => {
  if (req.url?.startsWith('/dsh-middleman/api/')) {
    try {
      const upstream = await fetch(APP + req.url, {
        method: req.method,
        headers: { 'content-type': 'application/json' },
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req),
      })
      const text = await upstream.text()
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
      res.end(text)
    } catch (err) {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }))
    }
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(html)
})

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk })
    req.on('end', () => resolve(data))
  })
}

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const harnessPort = server.address().port
const harnessUrl = `http://127.0.0.1:${harnessPort}/?batchId=${encodeURIComponent(batchId)}&ticketId=${encodeURIComponent(ticketId)}`
console.error('验证台', harnessUrl)

// 3. 截图：开新标签页、等 data-card-ready、量框、截图。
const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()
const browser = new WebSocket(version.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
browser.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
  }
})
await new Promise((resolve, reject) => {
  browser.addEventListener('open', resolve, { once: true })
  browser.addEventListener('error', reject, { once: true })
})
const bsend = (method, params = {}, timeoutMs = 20000) => new Promise((resolve, reject) => {
  const id = ++seq
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP 超时：' + method)) }, timeoutMs)
  pending.set(id, {
    resolve: (v) => { clearTimeout(timer); resolve(v) },
    reject: (e) => { clearTimeout(timer); reject(e) },
  })
  browser.send(JSON.stringify({ id, method, params }))
})

const created = await bsend('Target.createTarget', { url: 'about:blank' }, 20000)
const tabId = created.targetId
const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const target = tabs.find((t) => t.id === tabId)

const page = new WebSocket(target.webSocketDebuggerUrl)
let pageSeq = 0
const pagePending = new Map()
page.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id !== undefined && pagePending.has(msg.id)) {
    const { resolve, reject } = pagePending.get(msg.id)
    pagePending.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
  }
})
await new Promise((resolve, reject) => {
  page.addEventListener('open', resolve, { once: true })
  page.addEventListener('error', reject, { once: true })
})
const psend = (method, params = {}, timeoutMs = 20000) => new Promise((resolve, reject) => {
  const id = ++pageSeq
  const timer = setTimeout(() => { pagePending.delete(id); reject(new Error('CDP 超时：' + method)) }, timeoutMs)
  pagePending.set(id, {
    resolve: (v) => { clearTimeout(timer); resolve(v) },
    reject: (e) => { clearTimeout(timer); reject(e) },
  })
  page.send(JSON.stringify({ id, method, params }))
})

try {
  await psend('Emulation.setDeviceMetricsOverride', {
    width: 900, height: 900, deviceScaleFactor: 2, mobile: false,
  }, 15000)
  await psend('Page.navigate', { url: harnessUrl }, 20000)

  // 等卡片渲染完：轮询 body 上的标记。
  let ready = false
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 300))
    const r = await psend('Runtime.evaluate', {
      expression: 'JSON.stringify({ ready: document.body.dataset.cardReady, error: document.body.dataset.cardError, len: document.body.innerText.length })',
      returnByValue: true,
    }, 8000)
    const s = JSON.parse(r.result.value)
    if (s.error !== undefined) {
      console.error('页面报错：', s.error)
      process.exit(3)
    }
    if (s.ready === '1') { ready = true; break }
  }
  if (!ready) {
    console.error('卡片没渲染出来')
    process.exit(4)
  }

  const measured = await psend('Runtime.evaluate', {
    expression: `(() => {
      const shell = document.querySelector('.stage')
      const r = shell.getBoundingClientRect()
      return JSON.stringify({
        x: Math.round(r.x) - 4, y: Math.round(r.y) - 4,
        width: Math.round(r.width) + 8, height: Math.round(r.height) + 8,
      })
    })()`,
    returnByValue: true,
  }, 10000)
  const clip = JSON.parse(measured.result.value)
  console.error('外框', JSON.stringify(clip))

  const shot = await psend('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { ...clip, scale: 2 },
  }, 20000)

  const outFile = join(outDir, 'dispatch-card.png')
  await writeFile(outFile, Buffer.from(shot.data, 'base64'))
  console.error('已写入', outFile)

  // 顺手把卡片上的文字抓下来，验证它确实渲染出了四行 + 提示块 + 按钮。
  const text = await psend('Runtime.evaluate', {
    expression: 'document.querySelector(".stage").innerText',
    returnByValue: true,
  }, 10000)
  await writeFile(join(outDir, 'dispatch-card.txt'), text.result.value)
  console.error('文字：\n' + text.result.value)

  await bsend('Target.closeTarget', { targetId: tabId })
} finally {
  page.close()
  browser.close()
  server.close()
}
