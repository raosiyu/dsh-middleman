#!/usr/bin/env node
/**
 * 把 lib/card-model.js 的内容内联进 lib/client.js。
 *
 * 浏览器侧没有构建步骤，没法 import 一个宿主文件，所以判断层得在 bundle 里
 * 有一份副本。手抄两份必然漂——所以这份脚本是唯一的写入口：
 *
 *   node scripts/inline-card-model.mjs
 *
 * 跑完 test/client-bundle.test.mjs 应当仍然全绿；那份测试守的是「副本与
 * 源文件逐字一致」，不是「副本内容正确」——后者由 card-model.test.mjs 管。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const modelPath = join(root, 'lib', 'card-model.js')
const clientPath = join(root, 'lib', 'client.js')

const model = readFileSync(modelPath, 'utf8')
  // 内联时去掉 export 关键字，其余原样。
  .replace(/^export (function|const) /gm, '$1 ')
  .replace(/\n+$/, '')

const names = [...model.matchAll(/^(?:function|const) (\w+)/gm)].map((m) => m[1])
if (names.length === 0) {
  console.error('card-model.js 里没找到顶层声明，内联会得到空对象')
  process.exit(1)
}

const header = [
  '    // ── 卡片的判断层 ───────────────────────────────────────────────',
  '    // 由 scripts/inline-card-model.mjs 从 lib/card-model.js 生成，别手改。',
  '    // 两份的逐字一致由 test/client-bundle.test.mjs 守住。',
  '    const cardModel = (() => {',
].join('\n')

const footer = [
  '      return { ' + names.join(', ') + ' }',
  '    })()',
].join('\n')

const client = readFileSync(clientPath, 'utf8')
const start = client.indexOf('    // ── 卡片的判断层')
const end = client.indexOf('    /** 打一次本插件 API。 */')
if (start < 0 || end < 0 || end < start) {
  console.error('client.js 里找不到内联块的位置')
  process.exit(1)
}

const next = client.slice(0, start) + header + '\n' + model + '\n' + footer + '\n\n' + client.slice(end)
writeFileSync(clientPath, next, 'utf8')
console.log('内联完成：' + names.join(', '))
