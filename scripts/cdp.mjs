// 一次性 CDP 助手：连到指定的 DSH 浏览器标签页。
// 用法：node scripts/cdp.mjs <tabId> <jsFile>
import { readFile } from 'node:fs/promises'

const PORT = process.env.CDP_PORT ?? '55643'
const [, , tabId, jsFile] = process.argv

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const target = targets.find((t) => t.id === tabId)
if (!target) {
  console.error('找不到标签页', tabId, targets.map((t) => t.id))
  process.exit(1)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
  }
})

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})

const send = (method, params = {}, timeoutMs = 20000) => new Promise((resolve, reject) => {
  const id = ++seq
  const timer = setTimeout(() => {
    pending.delete(id)
    reject(new Error(`CDP 超时：${method}`))
  }, timeoutMs)
  pending.set(id, {
    resolve: (v) => { clearTimeout(timer); resolve(v) },
    reject: (e) => { clearTimeout(timer); reject(e) },
  })
  ws.send(JSON.stringify({ id, method, params }))
})

const code = await readFile(jsFile, 'utf8')
const result = await send('Runtime.evaluate', {
  expression: code,
  awaitPromise: true,
  returnByValue: true,
  userGesture: true,
})

if (result.exceptionDetails) {
  console.error('页面里抛异常：', JSON.stringify(result.exceptionDetails, null, 2))
  process.exit(2)
}
console.log(typeof result.result.value === 'string'
  ? result.result.value
  : JSON.stringify(result.result.value, null, 2))

ws.close()
