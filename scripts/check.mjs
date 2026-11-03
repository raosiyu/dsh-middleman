#!/usr/bin/env node
/**
 * 闸门自检：逐道验闸门，并在清单与代码漂了的时候报出来。
 *
 * ## 它解决的是什么问题
 *
 * 这个插件把「不许」写在代码里，不是提示词里。于是有个反身的问题：**谁盯着
 * 代码里的闸门？** 有人删掉一行判据（把四栏校验叉掉、把观察器里那道 waiting
 * 闸移除），测试不会喊——测试只会跑它还被允许跑的那些断言。于是一切看起来
 * 都正常，直到真机上「在等你」被记成「已完成」。
 *
 * 所以这一层做两件事：
 *
 * 1. **对账**（`reconcile`）：从源码里扫出闸门锚点，跟清单双向比。
 *    - 源码里有、清单里没登记 → 新闸门没人盯；
 *    - 清单里登记了、源码里扫不到 → **闸门被删了**（这就是要抓的那种）。
 *    清单的「身份」部分是扫出来的，所以删掉一道闸门不需要有谁记得改清单。
 * 2. **逐道跑**（`runProbes`）：每条探针既查源码判据原文，又真调一次闸门，
 *    看它拦不拦、拦完有没有留下副作用。
 *
 * ## 不碰宿主、不花钱
 *
 * 探针只用纯函数、假宿主与临时台账目录。一秒以内跑完，不需要 DSH 在跑。
 *
 * ## 用法
 *
 * ```sh
 * npm run check              # 跑全部
 * npm run check -- --only=g-observer   # 只跑某些探针
 * npm run check -- --json    # 机器可读
 * npm run check -- --list    # 只列闸门，不跑
 * ```
 *
 * @module dsh-whale-tail/scripts/check
 */
import { pathToFileURL } from 'node:url'
import { scanAnchors, indexById, describe, ROOT } from './gates/inventory.mjs'
import { GATE_OWNERS, EXPECTED_PROBES, PROBE_MODULES } from './gates/manifest.mjs'

/** 一条探针最多跑多久。超时按「破了」算——挂住的探针跟坏了是一回事。 */
const PROBE_TIMEOUT_MS = 20_000

/** 命令行参数。 */
const argv = process.argv.slice(2)
const only = argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length)
const asJson = argv.includes('--json')
const listOnly = argv.includes('--list')

/** 一格里用的对勾/叉。 */
const OK = '✓'
const BAD = '✗'

/**
 * 给一行输出定宽，让右边的耗时对齐。
 * @param text - 文本。
 * @param width - 宽度。
 * @returns {string} 补齐后的文本。
 */
function pad(text, width) {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

/**
 * 读一个探针模块。
 * @param entry - 清单里的一条 {file, exportName}。
 * @returns {Promise<Array<{id: string, title: string, covers: string[], probe: Function}>>} 探针。
 */
async function loadProbes(entry) {
  const url = new URL(entry.file, ROOT)
  let module
  try {
    module = await import(pathToFileURL(url.pathname).href)
  } catch (error) {
    throw new Error('读不到探针模块 ' + entry.file + '：' + String(error?.message ?? error))
  }
  const list = module[entry.exportName]
  if (!Array.isArray(list)) {
    throw new Error(entry.file + ' 没有导出数组 ' + entry.exportName)
  }
  for (const probe of list) {
    if (typeof probe?.id !== 'string' || probe.id === '') throw new Error(entry.file + ' 里有一条探针没有 id')
    if (typeof probe.probe !== 'function') throw new Error(entry.file + ' 里的 ' + probe.id + ' 没有 probe() 函数')
  }
  return list.map((probe) => ({ ...probe, module: entry.file }))
}

/**
 * 对账：清单与源码必须一一对上。
 *
 * 四种漂法，都会被抓：
 * - **孤儿锚点**：源码里有这道闸门，清单里没人登记 → 它没人盯。
 * - **幽灵登记**：清单里登记着，源码里扫不到 → 闸门被删了，或者判据被叉掉了。
 * - **空指针**：清单指向一条不存在的探针（打错字、探针改名）。
 * - **漏登记**：仓库里有这条探针，清单的 EXPECTED_PROBES 里没有。
 *
 * @param anchors - 扫出来的锚点。
 * @param probes - 载入的探针。
 * @returns {{ problems: string[], warnings: string[], ownerOf: Map<string, string[]> }} 对账结果。
 */
function reconcile(anchors, probes) {
  const problems = []
  const warnings = []
  const prefixes = Object.keys(GATE_OWNERS)
  const probeIds = new Set(probes.map((probe) => probe.id))

  /** 锚点 id → 盯它的探针 id。 */
  const ownerOf = new Map()

  // 1. 每个锚点都得有人盯。
  for (const anchor of anchors) {
    const matched = prefixes.filter((prefix) => anchor.id.startsWith(prefix))
    if (matched.length === 0) {
      problems.push('孤儿闸门：' + anchor.id + '（' + describe(anchor) + '）在源码里，但清单里没有哪条探针认领它'
        + '——这道闸门现在没人盯，删掉也不会有人知道')
      continue
    }
    const owners = [...new Set(matched.flatMap((prefix) => GATE_OWNERS[prefix] ?? []))]
    if (owners.length === 0) {
      problems.push('空认领：' + anchor.id + ' 命中的清单项一条探针都没写')
      continue
    }
    ownerOf.set(anchor.id, owners)
  }

  // 2. 清单里登记的，源码里必须还扫得到。
  for (const prefix of prefixes) {
    const matched = anchors.filter((anchor) => anchor.id.startsWith(prefix))
    if (matched.length === 0) {
      problems.push('登记失效：清单写的是 `' + prefix + '`，但源码里一条都对不上'
        + '——那道闸门被删了，或者判据被叉掉了（这正是这道自检要抓的事）')
    }
  }

  // 3. 清单指向的探针必须真的存在。
  for (const [prefix, owners] of Object.entries(GATE_OWNERS)) {
    for (const owner of owners) {
      if (!probeIds.has(owner)) problems.push('清单里的 `' + prefix + '` 指向不存在的探针 ' + owner)
    }
  }

  // 4. 探针与 EXPECTED_PROBES 双向对齐。
  const expected = new Set(EXPECTED_PROBES)
  for (const id of expected) {
    if (!probeIds.has(id)) {
      problems.push('清单说要有的探针 ' + id + ' 在仓库里找不到——删了探针而没删清单，等于自己把盯梢撤了')
    }
  }
  for (const probe of probes) {
    if (!expected.has(probe.id)) {
      problems.push('探针 ' + probe.id + '（' + probe.module + '）没登记进清单的 EXPECTED_PROBES'
        + '——加探针必须同时登记，否则它跑了也不算数')
    }
    // 探针声明的 covers 得对得上清单，否则「谁盯谁」两边说法不一致。
    for (const cover of probe.covers ?? []) {
      const hit = Object.entries(GATE_OWNERS).some(([prefix, owners]) =>
        owners.includes(probe.id) && (prefix.startsWith(cover.split('#')[0]) || cover.startsWith(prefix.split('#')[0])))
      if (!hit) {
        warnings.push('探针 ' + probe.id + ' 说它盯 ' + cover + '，但清单里没有对应的登记（covers 与 GATE_OWNERS 不一致）')
      }
    }
  }

  return { problems, warnings, ownerOf }
}

/**
 * 跑一条探针，带超时。
 * @param probe - 探针。
 * @returns {Promise<{ ok: boolean, ms: number, message: string }>} 结果。
 */
async function runOne(probe) {
  const started = Date.now()
  try {
    await Promise.race([
      probe.probe(),
      new Promise((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('探针超过 ' + PROBE_TIMEOUT_MS + 'ms 没返回，按破了算')), PROBE_TIMEOUT_MS)
        // 别让这个定时器吊住进程。
        timer.unref?.()
      }),
    ])
    return { ok: true, ms: Date.now() - started, message: '' }
  } catch (error) {
    return {
      ok: false,
      ms: Date.now() - started,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * 跑全部探针。
 *
 * **必须串行**：探针会改进程级环境变量（WT_HOME）与全局默认模型，
 * 并行跑会互相踩。
 *
 * @param probes - 探针。
 * @param filter - 只跑 id 含这个子串的探针。
 * @returns {Promise<Array>} 结果。
 */
async function runProbes(probes, filter) {
  const results = []
  for (const probe of probes) {
    if (typeof filter === 'string' && !probe.id.includes(filter)) continue
    const result = await runOne(probe)
    results.push({ id: probe.id, title: probe.title ?? '', covers: probe.covers ?? [], module: probe.module, ...result })
  }
  return results
}

/* ────────────────────────────── 主流程 ────────────────────────────── */

const anchors = scanAnchors()
indexById(anchors) // 锚点 id 撞车会在这里直接炸（说明扫描口径塌了）

let probes = []
const loadProblems = []
for (const entry of PROBE_MODULES) {
  try {
    probes = probes.concat(await loadProbes(entry))
  } catch (error) {
    loadProblems.push(String(error?.message ?? error))
  }
}

// 探针 id 不许重名：两条同名探针会让清单的指向变得含糊。
const seen = new Map()
for (const probe of probes) {
  if (seen.has(probe.id)) loadProblems.push('探针 id 重复：' + probe.id + '（' + seen.get(probe.id) + ' 与 ' + probe.module + '）')
  seen.set(probe.id, probe.module)
}

const { problems: reconcileProblems, warnings, ownerOf } = reconcile(anchors, probes)

if (listOnly) {
  console.log('闸门清单（' + anchors.length + ' 个锚点，' + probes.length + ' 条探针）')
  console.log('')
  for (const anchor of anchors) {
    const owners = ownerOf.get(anchor.id)
    console.log((owners === undefined ? ' 无人盯 ' : ' 盯：' + owners.join('、')) + '  ' + anchor.id)
  }
  process.exit(reconcileProblems.length === 0 && loadProblems.length === 0 ? 0 : 1)
}

const results = await runProbes(probes, only)
const broken = results.filter((result) => !result.ok)
const failed = loadProblems.length + reconcileProblems.length + broken.length

if (asJson) {
  console.log(JSON.stringify({
    anchors: anchors.length,
    probes: probes.length,
    ran: results.length,
    loadProblems,
    reconcileProblems,
    warnings,
    results,
    ok: failed === 0,
  }, null, 2))
  process.exit(failed === 0 ? 0 : 1)
}

/* ────────────────────────────── 报告 ────────────────────────────── */

const line = '─'.repeat(68)

console.log('鲸鱼尾巴 · 闸门自检')
console.log(line)
console.log('扫到 ' + anchors.length + ' 个闸门锚点，' + probes.length + ' 条探针'
  + (typeof only === 'string' ? '（只跑含 "' + only + '" 的 ' + results.length + ' 条）' : ''))
console.log('')

// 一、清单对账
console.log('一、清单与代码对账')
if (loadProblems.length === 0 && reconcileProblems.length === 0) {
  console.log('  ' + OK + ' 对上了：源码里的每一道闸门都有人盯，清单里登记的每一道都还在源码里')
} else {
  for (const problem of loadProblems) console.log('  ' + BAD + ' ' + problem)
  for (const problem of reconcileProblems) console.log('  ' + BAD + ' ' + problem)
}
for (const warning of warnings) console.log('  ! ' + warning)
console.log('')

// 二、逐道探针
console.log('二、逐条探针')
if (results.length === 0) {
  console.log('  ' + BAD + ' 一条探针都没跑（--only 是否写错了？）')
} else {
  const width = Math.min(46, Math.max(...results.map((result) => result.id.length)))
  for (const result of results) {
    const mark = result.ok ? OK : BAD
    const elapsed = String(result.ms).padStart(5) + 'ms'
    console.log('  ' + mark + ' ' + pad(result.id, width) + ' ' + elapsed
      + (result.ok ? '' : '  ' + result.message))
    // 破了就把这条探针盯的闸门一并点名，人不用再去翻清单。
    if (!result.ok && result.covers.length > 0) {
      console.log('      盯的是：' + result.covers.join('、'))
    }
  }
}
console.log('')

// 三、结论
console.log(line)
if (failed === 0) {
  const total = results.reduce((sum, result) => sum + result.ms, 0)
  console.log('结论：全绿。' + results.length + ' 条探针全部通过，覆盖 ' + anchors.length + ' 个闸门锚点，用时 ' + total + 'ms。')
  process.exit(0)
}
console.log('结论：' + BAD + ' ' + failed + ' 处不对。')
if (broken.length > 0) {
  console.log('  破了的探针：' + broken.map((result) => result.id).join('、'))
}
if (reconcileProblems.length > 0) {
  console.log('  清单与代码漂了：见上面「一、清单与代码对账」——那些行的意思是'
    + '「这道闸门在源码里没了」或「这道闸门没人盯」，两种都得当场处理。')
}
process.exit(1)
