/**
 * 浏览器 bundle 的一致性守卫。
 *
 * 浏览器侧没有构建步骤，没法 import 宿主文件，所以 lib/card-model.js 的内容
 * 被逐字内联进 lib/client.js。两份一旦漂移，卡片的行为就只存在于其中一处——
 * 那正是最难查的一类 bug。这条测试把两份钉在一起。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const model = readFileSync(join(root, 'lib', 'card-model.js'), 'utf8')
const client = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

/** 抽出 client.js 里内联的那一段（去掉包装与缩进变化）。 */
function inlinedBlock() {
  const start = client.indexOf('    const cardModel = (() => {')
  assert.notEqual(start, -1, 'client.js 里找不到内联的 cardModel')
  const bodyStart = client.indexOf('\n', start) + 1
  const end = client.indexOf('      return { ', bodyStart)
  assert.notEqual(end, -1, 'client.js 里找不到 cardModel 的 return')
  return client.slice(bodyStart, end)
}

test('client.js 内联的判断层与 lib/card-model.js 逐字一致', () => {
  // 内联时去掉了 export 关键字，其余原样。
  const expected = model
    .replace(/^export (function|const) /gm, '$1 ')
    .replace(/\n$/, '')
  assert.equal(
    inlinedBlock().replace(/\n$/, ''),
    expected,
    'lib/card-model.js 改了，lib/client.js 里的内联副本没跟着改。改完请把新内容重新内联进 client.js。',
  )
})

test('client.js 用的是 cardModel.argsOf 与 cardModel.ticketView', () => {
  assert.match(client, /cardModel\.argsOf\(phase, block\)/)
  assert.match(client, /cardModel\.ticketView\(state\.ticket\)/)
})

test('client.js 只有内联块那一份 TONE，没有第二份', () => {
  const block = inlinedBlock()
  const outside = client.replace(block, '')
  assert.equal((outside.match(/const TONE = \{/g) ?? []).length, 0, '内联块之外不该再有第二份 TONE')
  assert.equal((block.match(/const TONE = \{/g) ?? []).length, 1)
})
