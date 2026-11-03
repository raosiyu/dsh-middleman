/**
 * 台账：一个设计批次一份 JSON，落在 $DSH_HOME/whale-tail/designs/<id>.json。
 *
 * 只存状态与引用，不存对话正文：正文留在各自会话里，台账只回答
 * 「这个批次走到哪一步、每张票派给了谁」。
 *
 * @module dsh-whale-tail/ledger
 */
import { mkdir, readFile, writeFile, readdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { MiddlemanError } from './refusals.js'

/**
 * 台账根目录。
 *
 * 三道来源，按优先级：
 * 1. `WT_HOME` 环境变量——测试与演示指到临时目录用。
 * 2. `~/.dsh/whale-tail`——正常位置。
 * 3. `~/.dsh/middleman`——**改名之前的旧位置**。
 *
 * 为什么要认旧位置：这插件之前叫 dsh-middleman，台账存在
 * ~/.dsh/middleman。改名时如果不认旧路径，手上所有设计批次会在一夜
 * 之间「消失」——数据还在盘上，但插件看不见它们。那种「东西没了又
 * 不知道丢在哪」的体验，比一句明确的报错更糟。
 *
 * 所以只要新目录还没建、而旧目录有东西，就继续用旧的。**不自动搬家**：
 * 搬家要动用户的文件，出问题时更难收拾。等人自己想清楚再挪，
 * 或者就这么一直用着也没关系。
 *
 * @returns 台账根目录。
 */
export function home() {
  const override = process.env.WT_HOME
  if (typeof override === 'string' && override !== '') return override
  const fresh = join(homedir(), '.dsh', 'whale-tail')
  const legacy = join(homedir(), '.dsh', 'middleman')
  if (existsSync(fresh)) return fresh
  if (existsSync(legacy)) return legacy
  return fresh
}

/** 一个批次的落盘路径。 */
function pathOf(id) {
  return join(home(), 'designs', id + '.json')
}

/** 写入一个批次（整份覆盖，先写临时文件再改名，避免半截文件）。 */
export async function save(batch) {
  const target = pathOf(batch.id)
  await mkdir(dirname(target), { recursive: true })
  const temp = target + '.' + randomUUID() + '.tmp'
  await writeFile(temp, JSON.stringify(batch, null, 2) + '\n', 'utf8')
  await rename(temp, target)
  return batch
}

/**
 * 读一个批次；不存在时抛出可读错误，不返回 undefined。
 *
 * 抛的是带机器码的 MiddlemanError，不是裸 Error——路由层靠这个码把
 * 「批次不存在」映射成 404，而不是一律 500。之前这里抛的是普通 Error，
 * 于是 refusals.js 里那条 batch-missing → 404 的分支永远走不到。
 */
export async function load(id) {
  let raw
  try {
    raw = await readFile(pathOf(id), 'utf8')
  } catch {
    throw new MiddlemanError('batch-missing', '没有这个设计批次：' + id)
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new MiddlemanError('batch-unreadable', '这个设计批次读不出来：' + id)
  }
}

/** 列出全部批次，最新在前。坏文件跳过，不让一个读不出来的批次拖垮列表。 */
export async function list() {
  let names = []
  try {
    names = await readdir(join(home(), 'designs'))
  } catch {
    return []
  }
  const rows = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      rows.push(JSON.parse(await readFile(join(home(), 'designs', name), 'utf8')))
    } catch {
      // 跳过
    }
  }
  return rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
}

/** 生成批次 id。 */
export function newBatchId() {
  const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '')
  return 'D-' + stamp + '-' + randomUUID().slice(0, 4)
}

/** 建一个空白批次。 */
export function blankBatch(title) {
  return {
    id: newBatchId(),
    title,
    createdAt: Date.now(),
    status: 'grilling',
    decisions: [],
    // 盘问的账本：问过用户的问题与答案。派发前至少要有 3 条已回答的。
    questions: [],
    // 流程规划：分几步、产出什么、什么能并行。派发前必须写。
    plan: undefined,
    risks: [],
    tickets: [],
    spec: undefined,
  }
}
