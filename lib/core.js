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

/**
 * 敷衍语黑名单：长度够了但依然没内容的写法。
 *
 * 为什么长度不够：MIN_FIELD = 4 拦得住「无」「没有」，可英文的
 * none / null / n.a. 正好 4 个字符，从长度上完全合格——但它们跟「无」
 * 是一回事。
 */
const FILLER_WORDS = new Set([
  'none', 'null', 'nil', 'nan', 'n/a', 'n.a', 'na', 'tbd', 'todo',
  'unknown', 'nothing', 'empty', 'xxx', '???', '---', 'xxx.',
])

/** 一栏是不是敷衍语。 */
function isFiller(value) {
  const normalized = value.trim().toLowerCase().replace(/[.\s]+$/, '')
  return FILLER_WORDS.has(normalized)
}

/** 一个决定是否已经闭合。 */
export function isClosed(decision) {
  // 空答案等于没回答。判据跟 designGateProblems 里数答案时一样：
  // 都要 trim 后非空，否则账本里 answer: '' 的决定会被算成已定，
  // 收敛闸门就把没问完的设计放过去了。
  const answered = typeof decision?.answer === 'string' && decision.answer.trim() !== ''
  const deferred = decision?.deferred !== undefined && decision?.deferred !== null
  return answered || deferred
}

/** 依赖是否都满足。 */
function depsSatisfied(batch, decision) {
  return (decision.dependsOn ?? []).every((id) => {
    const parent = (batch.decisions ?? []).find((candidate) => candidate.id === id)
    return parent !== undefined && isClosed(parent)
  })
}

/** 前沿：未闭合且前置条件已满足的决定。 */
export function frontier(batch) {
  return (batch.decisions ?? []).filter((decision) => !isClosed(decision) && depsSatisfied(batch, decision))
}

/** 被挡住的决定：未闭合，但至少一个前置条件还没定。 */
export function blocked(batch) {
  return (batch.decisions ?? []).filter((decision) => !isClosed(decision) && !depsSatisfied(batch, decision))
}

/** 还没闭合的决定总数。 */
export function openCount(batch) {
  return (batch.decisions ?? []).filter((decision) => !isClosed(decision)).length
}

/**
 * 在一组「节点 + 依赖」里找出一条环。
 *
 * 按**下标**建图，不按 id——id 重复时按 id 建图会让后者覆盖前者，
 * 被覆盖那张票的边就此消失，真实成环就检不出来了。
 *
 * @param nodes - 节点数组，每项 {id, deps: string[]}。
 * @returns 环上的 id 序列；没有环返回 undefined。
 */
function findCycleIn(nodes) {
  const state = new Map()
  const stack = []
  const visit = (index) => {
    const mark = state.get(index)
    if (mark === 'done') return undefined
    if (mark === 'open') {
      const at = stack.indexOf(index)
      return [...stack.slice(at), index]
    }
    state.set(index, 'open')
    stack.push(index)
    for (const dep of nodes[index].deps ?? []) {
      const target = nodes.findIndex((node) => node.id === dep)
      if (target < 0) continue
      const found = visit(target)
      if (found !== undefined) return found
    }
    stack.pop()
    state.set(index, 'done')
    return undefined
  }
  for (let index = 0; index < nodes.length; index++) {
    const found = visit(index)
    if (found !== undefined) return found.map((i) => nodes[i].id)
  }
  return undefined
}

/** 依赖边校验：指向不存在的决定、依赖自己、成环。 */
export function dependencyProblems(batch) {
  const decisions = Array.isArray(batch?.decisions) ? batch.decisions : []
  const ids = new Set(decisions.map((decision) => decision.id))
  const problems = []
  for (const decision of decisions) {
    for (const dep of decision.dependsOn ?? []) {
      if (dep === decision.id) problems.push(decision.id + ' 依赖了它自己')
      else if (!ids.has(dep)) problems.push(decision.id + ' 依赖了不存在的 ' + dep)
    }
  }
  // 成环：环里的决定互相阻塞，前沿永远是空的——于是「前沿清空」这个
  // 判据会把一棵永远走不完的树当成走完了。必须单独查环。
  const cycle = findCycleIn(decisions.map((decision) => ({ id: decision.id, deps: decision.dependsOn ?? [] })))
  if (cycle !== undefined) {
    problems.push('决定依赖成环：' + cycle.join(' -> ') + '（环里的决定互相阻塞，永远定不下来）')
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
  const limit = Number.isInteger(size) && size > 0 ? size : 0
  const picked = open.slice(0, limit)
  const hasRiskProbe = picked.some((decision) => decision.kind === 'risk')
  const needsProbe = !hasRiskProbe && (Array.isArray(batch.risks) ? batch.risks : []).length === 0
  let probe
  if (needsProbe && limit > 0) {
    const fromFrontier = open.find((decision) => decision.kind === 'risk')
    if (fromFrontier !== undefined && !picked.includes(fromFrontier)) {
      // 探测问也受 size 约束——「一轮最多几问」是写进提示段的规矩，
      // 这里不加约束的话 size=2 会问出 3 个。
      if (picked.length < limit) picked.push(fromFrontier)
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
  const asked = picked.filter((decision) => decision.synthetic !== true).length
  return {
    questions: probe === undefined ? picked : [...picked, probe],
    asked,
    // remaining 是**整棵树**还剩多少，不是前沿上剩多少。
    //
    // 原来按前沿算，于是被挡住的那几个不计入——界面上一路显示「还剩 0 个」，
    // 可实际上还有好几个没定。两个数互相打架（这里与 openCount）。
    remaining: Math.max(0, openCount(batch) - asked),
    blockedCount: blocked(batch).length,
  }
}

/** 找出一条风险缺了哪几栏。 */
export function riskGaps(risk) {
  const gaps = []
  for (const [field, label] of RISK_FIELDS) {
    const value = risk?.[field]
    if (typeof value !== 'string') { gaps.push(label); continue }
    const trimmed = value.trim()
    if (trimmed.length < MIN_FIELD || isFiller(trimmed)) gaps.push(label)
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
  const files = testFiles instanceof Set ? testFiles : new Set(testFiles ?? [])

  /** 测试文件去掉 .test.mjs 之类的后缀后剩下的主干。 */
  const stems = new Set([...files].map((file) => file.replace(/\.(?:test|spec)\.(?:mjs|js|ts)$/, '')))

  // 措辞里提到「单测」这一类的，才可能是自动验证。纯人工核对不查。
  //
  // 为什么认这么多同义词：只看「单测」二字时，「单元测试」「自动化测试」
  // 「unit test」全都绕过去了——而它们跟「单测」是一回事。
  const claimsUnitTest = /单测|单元测试|自动化测试|unit\s*test|unittest/i.test(verification)
  if (!claimsUnitTest) return ''

  // 写法一：写了完整文件名——逐个查，少一个都不行。
  //
  // 后缀跟 lib/verifyscan.js 的口径对齐（mjs / js / ts）：只认 mjs 的话，
  // 写 test/core.test.ts 会整个漏过严格检查。
  //
  // 匹配按**文件名**比，不按前缀：core.mjs 的主干是 core，而仓库里
  // core.test.mjs 的主干也是 core——用 startsWith 前缀匹配会把前者
  // 放行，可 core.mjs 根本不存在。
  const named = verification.match(/[\w./-]+\.(?:test\.|spec\.)?(?:mjs|js|ts)\b/g) ?? []
  if (named.length > 0) {
    // 一个测试文件都没扫到：这不是「这个文件不存在」，而是「这个目录根本
    // 没有测试」。两种情况要分开说——不然人会去翻仓库找那个文件，
    // 找不到还以为写错了名字。
    if (files.size === 0) {
      return (risk?.id ?? '这条风险') + ' 的验证方式写的是单测，但批次所在目录一个测试文件都没扫到'
        + '（扫的是批次记下的 cwd）；要么把批次开在有 test 目录的项目里，'
        + '要么把验证方式改成「人工核对：…」'
    }
    const missing = named.filter((name) => {
      const tail = name.split('/').pop()
      return ![...files].some((file) => file === name || file.split('/').pop() === tail)
    })
    if (missing.length === 0) return ''
    return (risk?.id ?? '这条风险') + ' 的验证方式说要有 ' + missing.join('、')
      + '，但批次所在目录里没有这条测试（现有：' + [...files].slice(0, 5).join('、')
      + (files.size > 5 ? ' 等 ' + files.size + ' 个' : '') + '）；写完测试再来登记，'
      + '或把验证方式改成「人工核对：…」'
  }

  // 写法二：只写主干名——那个主干得对得上某个测试文件。
  const rest = verification.replace(/[\w./-]+\.(?:test\.|spec\.)?(?:mjs|js|ts)\b/g, ' ')
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
  const list = Array.isArray(risks) ? risks : []
  if (list.length === 0) {
    problems.push('一条风险都没登记；确实没有风险的话，在批次上写 riskFree 并说明理由')
  }
  for (const risk of list) {
    const gaps = riskGaps(risk)
    const id = risk?.id ?? '这条风险'
    if (gaps.length > 0) problems.push(id + ' 缺：' + gaps.join('、'))
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
  const open = openCount(batch)
  if (open > 0) {
    // 看**整棵树**还剩多少，不是看前沿。
    //
    // 为什么：前沿是「现在就能问的」。决定依赖成环时前沿永远是空的——
    // 环里的决定互相阻塞——于是「前沿清空」把一棵永远走不完的树当成走完了。
    // 所以这里数的是整棵树上还没闭合的决定。
    const ids = (batch.decisions ?? [])
      .filter((decision) => !isClosed(decision))
      .map((decision) => decision.id)
    problems.push('还有 ' + open + ' 个决定没定：' + ids.join('、'))
  }
  const spec = batch.spec
  if (spec === undefined || spec === null) {
    problems.push('还没有规格（goal / nonGoals / acceptance）')
  } else {
    if (typeof spec.goal !== 'string' || spec.goal.trim() === '') problems.push('规格缺目标')
    if (!Array.isArray(spec.acceptance) || spec.acceptance.length === 0) {
      problems.push('规格至少要有一条验收标准')
    } else {
      // 每条验收标准也得有料——空的照样算「有验收标准」。
      const blank = spec.acceptance.filter((item) => typeof item !== 'string' || item.trim() === '')
      if (blank.length > 0) {
        problems.push('有 ' + blank.length + ' 条验收标准是空的：每条都要能跑出红绿')
      }
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
  // 方向必须是 fail-closed：只有**明确**是 false 才放行。
  //
  // 原来写 `byModel === true`，于是传 1、'true'、{} 这些真值但非严格
  // true 的入参会静默通过——而这条闸门的全部意义就是「模型不能批准
  // 自己的设计」。宁可误拦一次，也不能漏过一次。
  if (byModel !== false) {
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
  const answered = answeredQuestionCount(batch.questions)
  if (answered < MIN_ANSWERED_QUESTIONS) {
    problems.push(
      '盘问没做够：至少要有 ' + MIN_ANSWERED_QUESTIONS + ' 个已回答的问题，现在只有 ' + answered
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
  // 风险要**四栏齐全**——不只是「有一条」。文档与提示段都这么写。
  //
  // 原来只查 risks.length === 0，于是四条全是「无」「n/a」的风险也算合规，
  // 而 riskProblems 这个真正的检查就在同一个文件里，只是没接上。
  const risks = Array.isArray(batch.risks) ? batch.risks : []
  if (risks.length === 0) {
    problems.push('风险清单是空的：至少登记一条风险，四栏齐全')
  } else {
    for (const risk of risks) {
      const gaps = riskGaps(risk)
      if (gaps.length > 0) {
        problems.push((risk?.id ?? '一条风险') + ' 缺：' + gaps.join('、') + '（四栏缺一栏就不算风险）')
      }
    }
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
 * 数「问过用户、并且答了」的问题有几个。
 *
 * 这是**唯一**的口径：`design_question` 回报进度用它，`designGateProblems`
 * 判断能不能派发也用它。两处各写一遍必然漂——真机上撞到过：工具回报
 * 「answered: 3，够了」，闸门却说「只有 2 个」，人以为闸门坏了。
 *
 * 三条规矩：
 * 1. 答案 trim 后非空才算答了（空字符串等于没答）。
 * 2. `kind === 'fact'` 不算——事实是模型自己的活，不该拿去问用户。
 * 3. 按问题去重——同一条问三遍不算三个。
 *
 * @param questions - 批次上的 questions 数组。
 * @returns 真正算数的问题个数。
 */
export function answeredQuestionCount(questions) {
  const list = Array.isArray(questions) ? questions : []
  const distinct = new Set()
  for (const entry of list) {
    if (entry?.kind === 'fact') continue
    if (typeof entry?.answer !== 'string' || entry.answer.trim() === '') continue
    if (typeof entry?.question !== 'string') continue
    distinct.add(entry.question)
  }
  return distinct.size
}

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
  const tickets = Array.isArray(batch.tickets) ? batch.tickets : []
  if (tickets.length === 0) {
    problems.push('还没有工单')
  }
  const ids = new Set(tickets.map((ticket) => ticket.id))
  // 工单 id 必须唯一。
  //
  // 为什么：重复 id 时 find 取的是**第一张**，于是两张都叫 T-1 的票
  // 只会派发第一张，第二张永远拿不到自己的子会话——面板上点哪张都跑
  // 第一张的活。
  if (ids.size !== tickets.length) {
    const seen = new Set()
    const duplicated = [...new Set(tickets.map((t) => t.id).filter((id) => {
      if (seen.has(id)) return true
      seen.add(id)
      return false
    }))]
    problems.push('工单 id 重复：' + duplicated.join('、') + '（每张票的 id 必须唯一）')
  }
  const risks = Array.isArray(batch.risks) ? batch.risks : []
  const riskIds = new Set(risks.map((risk) => risk.id))
  for (const ticket of tickets) {
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
    // 模型要真的指定了是哪个模型。model: {} 看着像「定了」，其实没有——
    // 派发时会拿 undefined 去调 session.selectModel。
    if (typeof ticket.model?.model !== 'string' || ticket.model.model.trim() === '') {
      problems.push(ticket.id + ' 没定模型：得写清 model: {provider, model}')
    }
  }
  // 登记时放过、后来没写的那条单测，在这里再拦一次：
  // 风险的验证方式承诺了单测，就得真的有那条测试，派发前是最后的关口。
  if (testFiles !== undefined) {
    for (const risk of risks) {
      const gap = verificationTestGap(risk, testFiles)
      if (gap !== '') problems.push(gap)
    }
  }
  const cycle = findCycleIn(tickets.map((ticket) => ({ id: ticket.id, deps: ticket.blockedBy ?? [] })))
  if (cycle !== undefined) problems.push('工单阻塞边成环：' + cycle.join(' -> '))
  return problems
}

/**
 * 就绪的工单：前置都已完成，且自己还没开始。
 *
 * 「已完成」包含 done、partial 与 failed——后两个也是终态。
 *
 * 为什么：观察器把被截断的轮次记成 partial、把出错的记成 failed。只认 done
 * 的话，一张 partial 的票会**永久**挡住它的后继——后继再也没法派发，
 * 而工具面上还没有任何办法能解开它。
 *
 * 终态就是终态：它不会再变，后继可以继续。要重跑那张票，得人来点。
 *
 * @param batch - 设计批次。
 * @returns 现在可以派发的工单。
 */
export function readyTickets(batch) {
  const TERMINAL = new Set(['done', 'partial', 'failed', 'cancelled'])
  const tickets = Array.isArray(batch?.tickets) ? batch.tickets : []
  const done = new Set(tickets.filter((t) => TERMINAL.has(t.status)).map((t) => t.id))
  return tickets.filter((ticket) =>
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
