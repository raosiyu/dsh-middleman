/**
 * 纯规则层：设计树、前沿、风险、三道闸门。
 *
 * 这一层不碰宿主、不碰文件系统、不碰网络，因此可以单测。所有「不许」
 * 都落在这里，而不是提示词里——提示词会被模型合理化掉。
 *
 * @module dsh-middleman/core
 */

/** 风险四栏：字段名与中文名。 */
export const RISK_FIELDS = [
  ['trigger', '触发条件'],
  ['impact', '影响'],
  ['mitigation', '缓解'],
  ['verification', '怎么验证'],
]

/** 一栏的最短有效长度；低于它的多半是「无」「n/a」这类敷衍。 */
const MIN_FIELD = 4

/** 一个决定是否已经闭合。 */
export function isClosed(decision) {
  return decision.answer !== undefined || decision.deferred !== undefined
}

/** 依赖是否都满足。 */
function depsSatisfied(batch, decision) {
  return (decision.dependsOn ?? []).every((id) => {
    const parent = batch.decisions.find((candidate) => candidate.id === id)
    return parent !== undefined && isClosed(parent)
  })
}

/** 前沿：未闭合且前置条件已满足的决定。 */
export function frontier(batch) {
  return batch.decisions.filter((decision) => !isClosed(decision) && depsSatisfied(batch, decision))
}

/** 被挡住的决定：未闭合，但至少一个前置条件还没定。 */
export function blocked(batch) {
  return batch.decisions.filter((decision) => !isClosed(decision) && !depsSatisfied(batch, decision))
}

/** 还没闭合的决定总数。 */
export function openCount(batch) {
  return batch.decisions.filter((decision) => !isClosed(decision)).length
}

/** 依赖边校验：指向不存在的决定、或依赖自己。 */
export function dependencyProblems(batch) {
  const ids = new Set(batch.decisions.map((decision) => decision.id))
  const problems = []
  for (const decision of batch.decisions) {
    for (const dep of decision.dependsOn ?? []) {
      if (dep === decision.id) problems.push(decision.id + ' 依赖了它自己')
      else if (!ids.has(dep)) problems.push(decision.id + ' 依赖了不存在的 ' + dep)
    }
  }
  return problems
}

/**
 * 取一轮要问的问题。
 *
 * 一条由代码保证的规则：**只要一条风险都还没登记，就追加一条风险探测问**。
 * 登记过之后不再追问，否则同一句问题会在每一轮重复，把盘问变成噪音。
 */
export function nextRound(batch, size = 4) {
  const open = frontier(batch)
  const picked = open.slice(0, size)
  const hasRiskProbe = picked.some((decision) => decision.kind === 'risk')
  const needsProbe = !hasRiskProbe && batch.risks.length === 0
  let probe
  if (needsProbe) {
    const fromFrontier = open.find((decision) => decision.kind === 'risk')
    if (fromFrontier !== undefined && !picked.includes(fromFrontier)) {
      picked.push(fromFrontier)
    } else if (fromFrontier === undefined) {
      probe = {
        id: 'PROBE',
        title: '风险探测',
        body: '这个方案在什么情况下会失败？给一个具体的触发条件，不要只说「可能有风险」。',
        recommended: '先写下最可能失败的那条路径，再决定要不要为它加一道检查。',
        synthetic: true,
      }
    }
  }
  return {
    questions: probe === undefined ? picked : [...picked, probe],
    asked: picked.filter((decision) => decision.synthetic !== true).length,
    remaining: open.length - picked.filter((decision) => decision.synthetic !== true).length,
    blockedCount: blocked(batch).length,
  }
}

/** 找出一条风险缺了哪几栏。 */
export function riskGaps(risk) {
  const gaps = []
  for (const [field, label] of RISK_FIELDS) {
    const value = risk[field]
    if (typeof value !== 'string' || value.trim().length < MIN_FIELD) gaps.push(label)
  }
  return gaps
}

/**
 * 验证方式里承诺的单测，是不是真的存在。
 *
 * 为什么要查：验证方式这一栏是模型自己写的，写「单测：…」很容易——写了不等于
 * 有。真出过：一条风险的验证方式写着「单测：不传 batchId 断言抛错且不建会话」，
 * 仓库里根本没有这条测试，缓解措施只是写着，没被任何东西盯住。
 *
 * 判据分两种写法：
 * - 写了完整文件名（如 test/never-written.test.mjs）：那个文件必须存在，
 *   少一个都不行——承诺了不存在的文件，就是假承诺。
 * - 只写主干名（如 risk-r1 里断言…）：那个主干得对得上某个测试文件。
 * - 什么都没写：拒绝，并让模型改写成「人工核对：…」。
 *
 * 不含「单测」二字的不管——那可能是「这次跑一遍看看」这种一次性人工验证，
 * 本来就没法自动核。
 *
 * @param risk - 一条风险。
 * @param testFiles - 仓库里现有的测试文件名集合。
 * @returns {string} 问题描述；没问题时是空串。
 */
export function verificationTestGap(risk, testFiles) {
  const verification = typeof risk?.verification === 'string' ? risk.verification : ''
  if (!verification.includes('单测')) return ''
  const files = testFiles instanceof Set ? testFiles : new Set(testFiles ?? [])

  /** 测试文件去掉 .test.mjs 之类的后缀后剩下的主干。 */
  const stems = new Set([...files].map((file) => file.replace(/\.(?:test|spec)\.(?:mjs|js|ts)$/, '')))

  // 写法一：写了完整文件名——逐个查，少一个都不行。
  const named = verification.match(/[\w.-]+\.(?:test\.)?mjs/g) ?? []
  if (named.length > 0) {
    const missing = named.filter((name) => {
      if (files.has(name)) return false
      return ![...files].some((file) => file === name || file.startsWith(name.replace(/\.mjs$/, '')))
    })
    if (missing.length === 0) return ''
    return (risk?.id ?? '这条风险') + ' 的验证方式说要有 ' + missing.join('、')
      + '，但仓库里没有这条测试；写完测试再来登记，或把验证方式改成「人工核对：…」'
  }

  // 写法二：只写主干名——那个主干得对得上某个测试文件。
  const rest = verification.replace(/[\w.-]+\.(?:test\.)?mjs/g, ' ')
  const candidates = rest.match(/[\w][\w-]{2,}/g) ?? []
  if (candidates.some((token) => stems.has(token))) return ''

  return (risk?.id ?? '这条风险') + ' 的验证方式承诺了单测，却没说是哪条测试；'
    + '要么写清文件名（如 risk-r1.test.mjs），要么改成「人工核对：…」'
}

/**
 * 校验整本风险台账。
 *
 * @param risks - 风险列表。
 * @param testFiles - 仓库里现有的测试文件名集合（可选，缺省不查单测承诺）。
 * @returns {string[]} 问题列表。
 */
export function riskProblems(risks, testFiles) {
  const problems = []
  if (risks.length === 0) {
    problems.push('一条风险都没登记；确实没有风险的话，在批次上写 riskFree 并说明理由')
  }
  for (const risk of risks) {
    const gaps = riskGaps(risk)
    if (gaps.length > 0) problems.push(risk.id + ' 缺：' + gaps.join('、'))
    if (testFiles !== undefined) {
      const gap = verificationTestGap(risk, testFiles)
      if (gap !== '') problems.push(gap)
    }
  }
  return problems
}

/** 收敛：设计树走完、规格有验收标准、风险四栏齐全。 */
export function convergeProblems(batch) {
  const problems = []
  const open = frontier(batch)
  if (open.length > 0) {
    problems.push('前沿上还有 ' + open.length + ' 个决定没定：' + open.map((d) => d.id).join('、'))
  }
  if (batch.spec === undefined || batch.spec === null) {
    problems.push('还没有规格（goal / nonGoals / acceptance）')
  } else {
    if (typeof batch.spec.goal !== 'string' || batch.spec.goal.trim() === '') problems.push('规格缺目标')
    if (!Array.isArray(batch.spec.acceptance) || batch.spec.acceptance.length === 0) {
      problems.push('规格至少要有一条验收标准')
    }
  }
  problems.push(...riskProblems(batch.risks))
  problems.push(...dependencyProblems(batch))
  return problems
}

/**
 * 批准：只能由人做。
 * @param batch - 设计批次。
 * @param byModel - 这次调用是否来自模型进程。
 */
export function approveProblems(batch, byModel) {
  const problems = []
  if (batch.status !== 'converged') {
    problems.push('只有收敛后的批次才能批准，当前状态：' + batch.status)
  }
  if (byModel === true) {
    problems.push('批准不对模型开放：设计批准必须由人点按钮')
  }
  return problems
}

/**
 * 设计阶段的准入条件。
 *
 * 这一段是插件跟 ask-matt 技能组合的接口：主会话在派发之前，必须先走完
 * 「盘问 → 收敛」这条路，并且留下三样可查的东西：
 *
 * 1. **问过的问题**（questions）：问了几轮、每轮问了什么。只写代码不提问，
 *    那是绕过盘问，不是完成盘问。
 * 2. **流程规划**（plan）：这件事分几步、每步的产出是什么、什么能并行。
 * 3. **风险清单**（risks）：四栏齐全的风险，以及每条风险的验证方式。
 *
 * 少一样就派发不了。这条检查写在代码里，不写在提示词里——提示词会被模型
 * 合理化掉，代码不会。
 *
 * @param batch - 设计批次。
 * @returns 问题描述数组，空数组表示设计阶段已达标。
 */
export function designGateProblems(batch) {
  const problems = []
  const questions = Array.isArray(batch.questions) ? batch.questions : []
  const answered = questions.filter((entry) => typeof entry?.answer === 'string' && entry.answer.trim() !== '')
  if (answered.length < MIN_ANSWERED_QUESTIONS) {
    problems.push(
      '盘问没做够：至少要有 ' + MIN_ANSWERED_QUESTIONS + ' 个已回答的问题，现在只有 ' + answered.length
      + ' 个。先问清楚，别急着派发',
    )
  }
  const plan = batch.plan
  if (plan === undefined || plan === null) {
    problems.push('还没有流程规划（plan）：这次分几步、每步产出什么、什么能并行')
  } else {
    if (typeof plan.steps !== 'string' || plan.steps.trim() === '') {
      problems.push('流程规划缺 steps：这件事分几步')
    }
    if (typeof plan.output !== 'string' || plan.output.trim() === '') {
      problems.push('流程规划缺 output：做完之后留下什么')
    }
  }
  if (batch.risks.length === 0) {
    problems.push('风险清单是空的：至少登记一条风险，四栏齐全')
  }
  return problems
}

/**
 * 盘问至少要问够几个问题才算走过一遍。
 *
 * 三个是下限：一个问目标，一个问范围，一个问失败的样子。低于这个数，
 * 说明设计阶段是走个形式。
 */
export const MIN_ANSWERED_QUESTIONS = 3

/**
 * 派发：批准过、每张票都挂了风险、依赖边合法、模型与理由齐全。
 *
 * @param batch - 批次。
 * @param testFiles - 仓库里现有的测试文件名集合（可选）。给了才查「承诺的单测在不在」。
 * @returns {string[]} 问题列表。
 */
export function dispatchProblems(batch, testFiles) {
  const problems = []
  if (batch.status !== 'approved') {
    problems.push('批次还没批准，当前状态：' + batch.status)
  }
  problems.push(...designGateProblems(batch))
  if (!Array.isArray(batch.tickets) || batch.tickets.length === 0) {
    problems.push('还没有工单')
  }
  const ids = new Set((batch.tickets ?? []).map((ticket) => ticket.id))
  const riskIds = new Set((batch.risks ?? []).map((risk) => risk.id))
  for (const ticket of batch.tickets ?? []) {
    if (!ticket.riskFree) {
      if (!Array.isArray(ticket.riskIds) || ticket.riskIds.length === 0) {
        problems.push(ticket.id + ' 没挂风险；确实无关就写 riskFree 并说明理由')
      } else {
        for (const id of ticket.riskIds) {
          if (!riskIds.has(id)) problems.push(ticket.id + ' 引用了不存在的风险 ' + id)
        }
      }
    } else if (typeof ticket.riskFreeReason !== 'string' || ticket.riskFreeReason.trim() === '') {
      problems.push(ticket.id + ' 标了 riskFree 但没写理由')
    }
    for (const dep of ticket.blockedBy ?? []) {
      if (!ids.has(dep)) problems.push(ticket.id + ' 被不存在的工单阻塞：' + dep)
    }
    if (typeof ticket.modelReason !== 'string' || ticket.modelReason.trim() === '') {
      problems.push(ticket.id + ' 没写 modelReason：模型为什么选这个')
    }
    if (ticket.model === undefined || ticket.model === null) problems.push(ticket.id + ' 没定模型')
  }
  // 登记时放过、后来没写的那条单测，在这里再拦一次：
  // 风险的验证方式承诺了单测，就得真的有那条测试，派发前是最后的关口。
  if (testFiles !== undefined) {
    for (const risk of batch.risks ?? []) {
      const gap = verificationTestGap(risk, testFiles)
      if (gap !== '') problems.push(gap)
    }
  }
  const cycle = findCycle(batch.tickets ?? [])
  if (cycle !== undefined) problems.push('工单阻塞边成环：' + cycle.join(' -> '))
  return problems
}

/** 找一条环；没有环返回 undefined。 */
function findCycle(tickets) {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]))
  const state = new Map()
  const stack = []
  const visit = (id) => {
    const mark = state.get(id)
    if (mark === 'done') return undefined
    if (mark === 'open') {
      const at = stack.indexOf(id)
      return [...stack.slice(at), id]
    }
    state.set(id, 'open')
    stack.push(id)
    for (const dep of byId.get(id)?.blockedBy ?? []) {
      const found = visit(dep)
      if (found !== undefined) return found
    }
    stack.pop()
    state.set(id, 'done')
    return undefined
  }
  for (const ticket of tickets) {
    const found = visit(ticket.id)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * 就绪的工单：前置都已完成，且自己还没开始。
 * @param batch - 设计批次。
 * @returns 现在可以派发的工单。
 */
export function readyTickets(batch) {
  const done = new Set((batch.tickets ?? []).filter((t) => t.status === 'done').map((t) => t.id))
  return (batch.tickets ?? []).filter((ticket) =>
    (ticket.status === undefined || ticket.status === 'pending')
    && (ticket.blockedBy ?? []).every((dep) => done.has(dep)))
}

/**
 * turn/end 的 reason 分类。
 *
 * 只有 completed 算成功。max-tokens 与 interrupted 记 partial 而不是 failed：
 * 长任务被截断很常见，一律标失败会让人开始忽略失败通知。
 * @param reason - turn/end 的 reason 对象。
 * @returns 结算结果。
 */
export function classifyTurnEnd(reason) {
  const kind = typeof reason === 'object' && reason !== null ? reason.kind : reason
  if (kind === 'completed') return { status: 'done', note: '' }
  if (kind === 'max-tokens') {
    return { status: 'partial', note: '输出撞到 max-tokens，产出被截断' }
  }
  if (kind === 'interrupted') {
    return { status: 'partial', note: '被中断，产出可能不完整' }
  }
  if (kind === 'blocked') return { status: 'failed', note: 'turn 被阻塞' }
  if (kind === 'aborted') return { status: 'failed', note: 'turn 被中止' }
  if (kind === 'error') {
    // 把适配器给的错误码带出来：欠费（ACCOUNT_QUOTA）、限流、真 bug
    // 在台账里必须能区分，否则「失败」这个词什么都说明不了。
    const failure = reason?.error
    const code = typeof failure?.code === 'string' ? failure.code : undefined
    const message = typeof failure?.message === 'string' ? failure.message : undefined
    const detail = [code, message].filter((part) => typeof part === 'string' && part !== '').join(': ')
    return { status: 'failed', note: detail === '' ? 'turn 以错误结束' : 'turn 以错误结束 — ' + detail }
  }
  return { status: 'failed', note: 'turn 未完成：' + String(kind) }
}
