#!/usr/bin/env node
/**
 * 手感演示 CLI：把盘问 → 收敛 → 闸门 → 派发跑一遍，不碰真实会话。
 *
 * 目的是让你在装进 DSH 之前先摸一遍流程本身：一轮问几个、风险怎么绑、
 * 闸门在哪里拦人。派发那一步只打印将要发生什么，不建会话、不花钱。
 *
 * 交互模式下逐题回答；管道输入（或 --auto）时把 stdin 的行按顺序当作答案。
 */
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { save, load, list, newBatchId, home } from '../lib/ledger.js'
import { frontier, blocked, nextRound, openCount, convergeProblems, dispatchProblems, RISK_FIELDS } from '../lib/core.js'

const HOME = home()

const dim = (s) => '\x1b[2m' + s + '\x1b[0m'
const bold = (s) => '\x1b[1m' + s + '\x1b[0m'
const cyan = (s) => '\x1b[36m' + s + '\x1b[0m'
const yellow = (s) => '\x1b[33m' + s + '\x1b[0m'
const red = (s) => '\x1b[31m' + s + '\x1b[0m'
const green = (s) => '\x1b[32m' + s + '\x1b[0m'

/**
 * 答案来源：终端逐题问，管道按行取。
 *
 * 管道用完之后不再问，而是返回空串——空串在每一处都读作「接受推荐」，
 * 所以脚本跑到尾巴也不会因为 readline 关掉而炸。
 */
function makeAsker() {
  const interactive = stdin.isTTY === true && process.env.MM_AUTO !== '1'
  const rl = interactive ? createInterface({ input: stdin, output: stdout }) : undefined
  let ready
  if (!interactive) {
    let raw = ''
    stdin.setEncoding('utf8')
    stdin.on('data', (chunk) => { raw += chunk })
    ready = new Promise((resolve) => stdin.on('end', () => {
      const lines = raw.split('\n')
      while (lines.length > 0 && lines.at(-1).trim() === '') lines.pop()
      resolve(lines)
    }))
  }
  let cursor = 0
  return {
    async ask(prompt) {
      if (interactive) {
        try {
          return await rl.question(prompt)
        } catch {
          return ''
        }
      }
      const lines = await ready
      if (cursor >= lines.length) return ''
      const line = lines[cursor]
      cursor += 1
      console.log(prompt + line)
      return line
    },
    close() {
      rl?.close()
    },
  }
}

/** 演示用的初始设计树。真实插件里这棵树由模型边问边长。 */
function seedTree(title) {
  return {
    id: newBatchId(),
    title,
    createdAt: Date.now(),
    status: 'grilling',
    decisions: [
      { id: 'D1', kind: 'goal', title: '要解决什么问题', body: '一句话说清这次要做什么，以及不做什么。', dependsOn: [] },
      { id: 'D2', kind: 'scope', title: '范围到哪为止', body: '哪些是这次必须做的，哪些明确留给以后。', dependsOn: ['D1'] },
      { id: 'D3', kind: 'design', title: '数据结构长什么样', body: '核心实体与它们的关系；先只写会变的字段。', dependsOn: ['D1'] },
      { id: 'D4', kind: 'design', title: '接口边界放哪里', body: '调用方需要知道什么，实现藏在哪。', dependsOn: ['D3'] },
      { id: 'D5', kind: 'risk', title: '最可能失败的那条路径', body: '给出具体触发条件，不是「可能有风险」。', dependsOn: ['D2'] },
      { id: 'D6', kind: 'verify', title: '怎么算做完了', body: '可执行的验收标准，能跑出红绿的那种。', dependsOn: ['D2', 'D4'] },
    ],
    risks: [],
    tickets: [],
    spec: undefined,
  }
}

function showRound(batch, round, index) {
  console.log('')
  // 剩余数按整棵树算，不是按前沿算：前沿本来就小，用前沿算会把
  // 每一轮都写成「最后一轮」。
  const remaining = openCount(batch) - round.asked
  const tail = remaining <= 0 ? '最后一轮' : '整棵树还剩 ' + remaining + ' 个未定'
  const blockedTail = round.blockedCount > 0 ? ' · 被挡住 ' + round.blockedCount + ' 个' : ''
  console.log(bold(cyan('── 第 ' + index + ' 轮 · 本轮 ' + round.asked + ' 问 · ' + tail + blockedTail + ' ──')))
  console.log('')
  for (const [i, question] of round.questions.entries()) {
    const tag = question.synthetic === true ? yellow('[代码追加的风险探测]') : dim('[' + question.kind + ']')
    console.log(bold('❓ Q' + (i + 1)) + ' ' + tag + ' ' + bold(question.title))
    console.log('   ' + question.body)
    if (question.recommended !== undefined) console.log('   ' + cyan('➡️ ' + question.recommended))
    console.log('')
  }
}

async function answerRound(batch, round, asker) {
  for (const question of round.questions) {
    if (question.synthetic === true) {
      const trigger = await asker.ask(dim('   触发条件（回车跳过）: '))
      if (trigger.trim() !== '') {
        const impact = await asker.ask(dim('   影响: '))
        const mitigation = await asker.ask(dim('   缓解: '))
        const verification = await asker.ask(dim('   怎么验证: '))
        batch.risks.push({
          id: 'R-' + (batch.risks.length + 1),
          title: question.title,
          trigger,
          impact,
          mitigation,
          verification,
        })
        console.log(green('   ✓ 风险已登记'))
      } else {
        console.log(dim('   跳过'))
      }
      continue
    }
    const answer = await asker.ask(dim('   回答（回车 = 接受推荐）: '))
    const decision = batch.decisions.find((candidate) => candidate.id === question.id)
    decision.answer = answer.trim() === '' ? (question.recommended ?? '(接受推荐)') : answer.trim()
    decision.decidedAt = Date.now()
    console.log(green('   ✓ ' + decision.id + ' 已定'))
  }
}

async function main() {
  console.log(bold('中台手感演示') + dim('  ·  台账 ' + HOME))
  console.log(dim('盘问 → 收敛 → 批准 → 派发。派发只打印计划，不建会话、不花钱。'))
  console.log('')

  const asker = makeAsker()
  const title = (await asker.ask('这次要做什么（一句话）: ')).trim() || '演示批次'
  const batch = seedTree(title)
  await save(batch)

  let index = 1
  while (frontier(batch).length > 0 && index <= 12) {
    const round = nextRound(batch)
    showRound(batch, round, index)
    await answerRound(batch, round, asker)
    await save(batch)
    index += 1
  }

  const stillBlocked = blocked(batch)
  if (stillBlocked.length > 0) {
    console.log(yellow('仍被挡住：' + stillBlocked.map((d) => d.id).join('、')))
  }

  console.log('')
  console.log(bold('── 收敛 ──'))
  batch.spec = {
    goal: batch.decisions.find((d) => d.id === 'D1')?.answer ?? '',
    nonGoals: [],
    acceptance: [batch.decisions.find((d) => d.id === 'D6')?.answer ?? '验收标准未定'],
  }
  batch.status = 'converged'

  const problems = convergeProblems(batch)
  console.log('')
  if (problems.length > 0) {
    console.log(red(bold('闸门 1 · 收敛：拦住，' + problems.length + ' 个问题')))
    for (const problem of problems) console.log(red('   ✗ ' + problem))
    console.log('')
    console.log(dim('真实插件会把这些问题回给模型，让它继续问或补风险。'))
    await save(batch)
    asker.close()
    return
  }
  console.log(green(bold('闸门 1 · 收敛：通过')))

  console.log('')
  console.log(bold('── 闸门 2 · 批准 ──'))
  console.log(dim('这一条只对人类开放，模型进程调用会被直接拒绝。'))
  const approve = (await asker.ask('批准这份设计？(y/N) ')).trim().toLowerCase()
  if (approve !== 'y') {
    console.log(yellow('未批准，批次停在 converged'))
    await save(batch)
    asker.close()
    return
  }
  batch.status = 'approved'
  batch.approvedAt = Date.now()
  await save(batch)
  console.log(green('✓ 已批准'))

  console.log('')
  console.log(bold('── 拆工单 ──'))
  batch.tickets = [
    {
      id: 'T-1', title: '台账与状态机', brief: '把批次与决定的读写、状态迁移做出来',
      blockedBy: [], riskIds: ['R-1'], riskFree: false,
      model: { provider: 'deepseek', model: 'deepseek-chat' },
      modelReason: '纯数据结构与状态迁移，机械性强，便宜模型够用',
      status: 'pending',
    },
    {
      id: 'T-2', title: '闸门规则', brief: '收敛、批准、派发三道检查',
      blockedBy: ['T-1'], riskIds: ['R-1'], riskFree: false,
      model: { provider: 'deepseek', model: 'deepseek-reasoner' },
      modelReason: '规则要覆盖边界情况，值得用强模型',
      status: 'pending',
    },
    {
      id: 'T-3', title: '独立验收', brief: '换一个模型复核 T-1 与 T-2',
      blockedBy: ['T-1', 'T-2'], riskIds: [], riskFree: true,
      riskFreeReason: '只读复核，不改代码，风险由被验方承担',
      model: { provider: 'deepseek', model: 'deepseek-chat' },
      modelReason: '故意不用实现方同一个模型，避免同一个盲区',
      status: 'pending',
    },
  ]

  const dispatchIssues = dispatchProblems(batch)
  console.log('')
  if (dispatchIssues.length > 0) {
    console.log(red(bold('闸门 3 · 派发：拦住')))
    for (const issue of dispatchIssues) console.log(red('   ✗ ' + issue))
  } else {
    console.log(green(bold('闸门 3 · 派发：通过')))
    console.log('')
    for (const ticket of batch.tickets) {
      const ready = (ticket.blockedBy ?? []).length === 0
      console.log('  ' + (ready ? green('▶') : dim('⏸')) + ' ' + bold(ticket.id) + ' ' + ticket.title)
      console.log('    ' + dim('模型 ' + ticket.model.provider + '/' + ticket.model.model + ' — ' + ticket.modelReason))
      console.log('    ' + dim('阻塞 ' + ((ticket.blockedBy ?? []).join(', ') || '无') + '  ·  风险 ' + (ticket.riskFree ? 'riskFree' : ticket.riskIds.join(', '))))
      console.log('    ' + dim(ready ? '→ 建会话并挂起，等人点执行' : '→ 等前序工单完成'))
      console.log('')
    }
  }

  await save(batch)
  console.log(dim('批次已存：' + batch.id))
  asker.close()
}

main().catch((error) => {
  console.error(red(String(error)))
  process.exitCode = 1
})