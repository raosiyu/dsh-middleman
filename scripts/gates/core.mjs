/**
 * 规则层闸门的自检探针。
 *
 * lib/core.js 是「所有不许落在这里」的那一层：批次能不能收敛、负责的人是谁、
 * 工单能不能派、风险的验证方式是不是真话。它全是纯函数，所以这里的探针
 * 不需要 $WT_HOME、不建临时目录、不 sleep——跑起来是毫秒级的。
 *
 * 每条探针做两件事，缺一不可：
 *
 * 1. **源码锚点**：断言 lib/core.js 里那句判据还在。匹配前先把注释剥掉
 *    （抄 scripts/gates/tools.mjs 里那段实现）——core.js 的注释里也写着
 *    判据的中文措辞，不剥的话「把判据注释掉」会让探针假绿。这条别人踩过。
 * 2. **行为探针**：真调纯函数，断言**本该被拦住的那种输入真的被拦了**，
 *    同时带上**反面对照**（合法输入必须放行）。
 *
 * 为什么必须带对照：只有拒绝没有放行，一个「什么都拒」的实现也能让所有
 * 拒绝断言变绿。所以每条探针都至少有一个「这一条得过去」的断言。
 *
 * @module dsh-whale-tail/scripts/gates/core
 */
import { readFileSync } from 'node:fs'

import {
  answeredQuestionCount,
  approveProblems,
  convergeProblems,
  dependencyProblems,
  dispatchProblems,
  frontier,
  isTerminalStatus,
  openCount,
  readyTickets,
  riskGaps,
  verificationTestGap,
} from '../../lib/core.js'

/** 规则层源码的位置。 */
const SOURCE_URL = new URL('../../lib/core.js', import.meta.url)

/**
 * 剥掉 JS 源码里的注释，只留代码。
 *
 * 为什么必须剥：`// problems.push('还有 N 个决定没定…')` 被注释掉之后，
 * 原文里那个字符串还在——不剥注释的话正则照样命中，闸门被停用了探针却是绿的。
 *
 * 字符串与正则字面量里的 // 与 /* 不算注释，所以引号要整段跳过。
 *
 * @param source - 原始源码。
 * @returns 去掉注释的源码（块注释换成一个空格，免得把两段代码粘成一个 token）。
 */
function stripComments(source) {
  let out = ''
  let index = 0
  while (index < source.length) {
    const ch = source[index]
    const next = source[index + 1]

    if (ch === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index++
      continue
    }

    if (ch === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index++
      index += 2
      out += ' '
      continue
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      out += ch
      index++
      while (index < source.length) {
        if (source[index] === '\\') {
          out += source[index] + (source[index + 1] ?? '')
          index += 2
          continue
        }
        out += source[index]
        if (source[index] === quote) {
          index++
          break
        }
        index++
      }
      continue
    }

    out += ch
    index++
  }
  return out
}

/** 剥完注释的源码：一个进程里只读一次。 */
let cachedCode

/**
 * 读 lib/core.js，返回去掉注释的代码。
 * @returns {string} 源码。
 */
function coreCode() {
  if (cachedCode === undefined) {
    try {
      cachedCode = stripComments(readFileSync(SOURCE_URL, 'utf8'))
    } catch (error) {
      throw new Error('读不到 lib/core.js，规则层的闸门没法自检：' + String(error?.message ?? error))
    }
  }
  return cachedCode
}

/** 探针里的断言：不成立就抛一句中文说明。 */
function must(condition, message) {
  if (!condition) throw new Error(message)
}

/**
 * 断言 lib/core.js 里的判据还在（只看代码，不看注释）。
 * @param patterns - [正则, 人话描述] 列表。
 */
function anchors(patterns) {
  const code = coreCode()
  for (const [pattern, label] of patterns) {
    must(pattern.test(code), 'lib/core.js 里那句判据不见了：' + label)
  }
}

// ── 造数据：形状照抄 test/core-gates.test.mjs ──────────────────────

/** 一条四栏齐全的风险。 */
function goodRisk(over = {}) {
  return {
    id: 'R-1',
    title: '主会话把「在等你」当成失败，后继票被误挡',
    trigger: '子会话停下来等人时观察器按终态结算',
    impact: '后继票被跳过，人也会开始忽略失败通知',
    mitigation: '把 waiting 排除在终态之外，并单独出一道闸门',
    verification: '人工核对：把探针跑一遍，看 waiting 的票没被解成终态',
    ...over,
  }
}

/** 一张能过派发闸门的票。 */
function goodTicket(over = {}) {
  return {
    id: 'T-1',
    title: '一张票',
    brief: '做点事',
    blockedBy: [],
    riskIds: ['R-1'],
    riskFree: false,
    riskFreeReason: undefined,
    model: { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
    modelReason: '活不长，快模型够用',
    status: 'pending',
    ...over,
  }
}

/**
 * 一个除了要测的那一处，其余都合规的批次。
 *
 * 拿来当**反面对照**用：dispatchProblems / convergeProblems 对它必须返回空数组。
 * 只要有一个探针的对照突然非空，说明闸门收错了范围——那也是破。
 */
function goodBatch(over = {}) {
  return {
    id: 'D-probe',
    status: 'approved',
    decisions: [
      { id: 'D1', kind: 'goal', title: '目标', body: '把规则层闸门做成探针', dependsOn: [], answer: '定了' },
    ],
    questions: [
      { id: 'Q1', kind: 'goal', question: '目标是什么？', answer: '规则层可自检' },
      { id: 'Q2', kind: 'scope', question: '范围到哪？', answer: '只加一个探针文件，lib 不动' },
      { id: 'Q3', kind: 'risk', question: '什么情况下会失败？', answer: '判据被注释掉，探针假绿' },
    ],
    plan: { steps: '先读源码，再造数据，再写锚点与行为断言', output: '一个能跑出红绿的探针文件' },
    risks: [goodRisk()],
    spec: {
      goal: '把规则层闸门做成可自检的探针',
      nonGoals: ['不改 lib/', '不碰别人的探针文件'],
      acceptance: ['node 自测全绿', '删掉一条判据时对应探针报破'],
    },
    tickets: [goodTicket()],
    ...over,
  }
}

/** 一道闸门。 */
export const coreGates = [
  // ── 状态分类：waiting 不是终态 ────────────────────────────────
  {
    id: 'g-core-terminal-waiting',
    title: 'waiting / suspended 不被当成终态，done / partial / failed / cancelled 才是',
    covers: ['core.js#isTerminalStatus'],
    probe: async () => {
      anchors([
        [
          /export function isTerminalStatus\(status\) \{\s*return status === TICKET_STATUS\.done\s*\|\| status === TICKET_STATUS\.partial\s*\|\| status === TICKET_STATUS\.failed\s*\|\| status === TICKET_STATUS\.cancelled/,
          'isTerminalStatus 的终态清单：只有 done / partial / failed / cancelled',
        ],
      ])

      // 破的那一面：waiting 一旦算终态，「在等你」的票就再也不会被重新考虑。
      must(
        isTerminalStatus('waiting') === false,
        'waiting 被当成了终态：子会话主动停下来等人，不该算「结束了」',
      )
      must(
        isTerminalStatus('suspended') === false,
        'suspended 被当成了终态：人还没点执行，它一动没动',
      )

      // 对照：四个真终态必须还是终态。
      for (const status of ['done', 'partial', 'failed', 'cancelled']) {
        must(isTerminalStatus(status) === true, status + ' 该是终态，现在不是')
      }

      // 对照：还在动的状态都不是终态。
      for (const status of ['running', 'pending']) {
        must(isTerminalStatus(status) === false, status + ' 不该被当成终态')
      }
    },
  },

  // ── 就绪判定：waiting 的票不能放出后继 ────────────────────────
  {
    id: 'g-core-ready-blocked-by-waiting',
    title: '一张 waiting 的票挡得住它的后继，改成 done 之后后继才就绪',
    covers: ['core.js#readyTickets', 'core.js#isTerminalStatus'],
    probe: async () => {
      anchors([
        [/const settled = new Set\(tickets\.filter\(\(t\) => isTerminalStatus\(t\.status\)\)\.map\(\(t\) => t\.id\)\)/, 'readyTickets 用 isTerminalStatus 算「已settled」的集合'],
        [/\(ticket\.blockedBy \?\? \[\]\)\.every\(\(dep\) => settled\.has\(dep\)\)/, 'readyTickets 的阻塞边检查'],
      ])

      const batch = {
        tickets: [
          { id: 'T-A', status: 'waiting', blockedBy: [] },
          { id: 'T-B', status: 'pending', blockedBy: ['T-A'] },
          // 对照票：没有前置的票本来就该就绪。
          { id: 'T-C', status: 'pending', blockedBy: [] },
        ],
      }

      const waitingReady = readyTickets(batch).map((ticket) => ticket.id)
      must(
        waitingReady.includes('T-C'),
        '对照票 T-C 没有前置却没被算就绪——就绪判定整体坏了，下面的断言不算数',
      )
      must(
        !waitingReady.includes('T-B'),
        'T-A 还在等人，T-B 却被放了出来（waiting 被当成了已完成）',
      )
      must(
        !waitingReady.includes('T-A'),
        'T-A 是 waiting，它自己不该被当成「可以派发」',
      )

      // 把那张票改成 done，后继就该就绪——证明拦住它的确实是 waiting 这个状态。
      batch.tickets[0].status = 'done'
      const doneReady = readyTickets(batch).map((ticket) => ticket.id)
      must(
        doneReady.includes('T-B'),
        'T-A 改成 done 之后，T-B 仍没就绪——这不是「等 waiting」，是就绪判定坏了',
      )

      // 反面对照：suspended 同样不该放出后继（人还没点执行）。
      batch.tickets[0].status = 'suspended'
      const suspendedReady = readyTickets(batch).map((ticket) => ticket.id)
      must(
        !suspendedReady.includes('T-B'),
        'suspended 的票放出了后继：人还没点执行，它一步都没跑',
      )
    },
  },

  // ── 风险四栏：缺任意一栏都算缺口 ─────────────────────────────
  {
    id: 'g-core-risk-four-fields',
    title: 'riskGaps 对缺任意一栏都报缺口，四栏齐全时是空数组',
    covers: ['core.js#riskGaps', 'core.js#RISK_FIELDS'],
    probe: async () => {
      anchors([
        [/export const RISK_FIELDS = \[/, 'RISK_FIELDS 四栏清单本身'],
        [/\['trigger', '触发条件'\]/, '四栏之一：trigger / 触发条件'],
        [/\['impact', '影响'\]/, '四栏之一：impact / 影响'],
        [/\['mitigation', '缓解'\]/, '四栏之一：mitigation / 缓解'],
        [/\['verification', '怎么验证'\]/, '四栏之一：verification / 怎么验证'],
        [/const trimmed = value\.trim\(\)/, 'riskGaps 会 trim 后再判长度'],
        [/if \(trimmed\.length < MIN_FIELD \|\| isFiller\(trimmed\)\) gaps\.push\(label\)/, 'riskGaps 的长度 + 敷衍语双重判据'],
      ])

      // 对照：四栏齐全的风险必须是零缺口。
      must(
        riskGaps(goodRisk()).length === 0,
        '四栏齐全的风险被报出了缺口：' + riskGaps(goodRisk()).join('、'),
      )

      const fields = [
        ['trigger', '触发条件'],
        ['impact', '影响'],
        ['mitigation', '缓解'],
        ['verification', '怎么验证'],
      ]

      for (const [field, label] of fields) {
        // 写法一：整栏缺字段。
        const missing = { ...goodRisk() }
        delete missing[field]
        must(
          riskGaps(missing).includes(label),
          '缺了「' + label + '」这一栏却没报缺口（' + field + ' 完全没有）',
        )

        // 写法二：字段在、值是空串。
        must(
          riskGaps({ ...goodRisk(), [field]: '' }).includes(label),
          '「' + label + '」是空串却没报缺口',
        )

        // 写法三：字段在、值是「无」——长度也拦得住，但仍必须报。
        must(
          riskGaps({ ...goodRisk(), [field]: '无' }).includes(label),
          '「' + label + '」写了「无」却被当成合规',
        )
      }

      // 四栏全缺时必须报四条，而不是只报第一条。
      must(
        riskGaps({ id: 'R-empty' }).length === 4,
        '四栏全缺时只报了 ' + riskGaps({ id: 'R-empty' }).length + ' 条，该是 4 条',
      )
    },
  },

  // ── 风险四栏：敷衍语照样算缺口 ───────────────────────────────
  {
    id: 'g-core-risk-filler',
    title: '四栏写「无」「n/a」「none」「tbd」这类敷衍语，仍然报缺口',
    covers: ['core.js#FILLER_WORDS', 'core.js#isFiller', 'core.js#riskGaps'],
    probe: async () => {
      anchors([
        [/const FILLER_WORDS = new Set\(\[/, '敷衍语黑名单本身'],
        [/'none'/, "黑名单里的 'none'"],
        [/'tbd'/, "黑名单里的 'tbd'"],
        [/function isFiller\(value\)/, 'isFiller 这个判定'],
        [/const normalized = value\.trim\(\)\.toLowerCase\(\)/, 'isFiller 先 trim + 小写'],
        [/return FILLER_WORDS\.has\(normalized\)/, 'isFiller 查的就是那份黑名单'],
      ])

      // 中文「无」与「n/a」是长度拦下的，「none」「unknown」正好够长，
      // 只能靠 blacklist 拦——两组都在这里验。
      const fillers = ['无', 'n/a', 'n.a.', 'none', 'None', 'NULL', 'tbd', 'TBD', 'todo', 'unknown', 'nothing']
      for (const filler of fillers) {
        const risk = { id: 'R-1', trigger: filler, impact: filler, mitigation: filler, verification: filler }
        const gaps = riskGaps(risk)
        must(
          gaps.length === 4,
          '四栏都写「' + filler + '」时只报了 ' + gaps.length + ' 条缺口（该是 4 条）：敷衍的风险被当成合规',
        )
      }

      // 单栏验证：长度够但内容是敷衍语，必须落在 isFiller 上。
      for (const filler of ['none', 'unknown', 'todo']) {
        const gaps = riskGaps(goodRisk({ trigger: filler }))
        must(
          gaps.includes('触发条件'),
          '触发条件写「' + filler + '」被放行了——这几个字长度够，只能靠黑名单拦',
        )
        must(
          gaps.length === 1,
          '只敷衍了一栏，却报了 ' + gaps.length + ' 条缺口：' + gaps.join('、'),
        )
      }

      // 反面对照：真写了内容的不许被误拦。
      for (const ok of ['子会话停下来等人时被按终态结算', 'not applicable in this project? no', 'xxx 之外的真话']) {
        must(
          riskGaps(goodRisk({ trigger: ok })).length === 0,
          '真人话被当成敷衍语拦了：' + ok,
        )
      }
    },
  },

  // ── 收敛：数整棵树，不是数前沿 ───────────────────────────────
  {
    id: 'g-core-converge-open-decisions',
    title: '还有未闭合决定时报「还有 N 个决定没定」，成环时（前沿为空）也照报',
    covers: ['core.js#convergeProblems', 'core.js#openCount', 'core.js#frontier'],
    probe: async () => {
      anchors([
        [/const open = openCount\(batch\)/, 'convergeProblems 数的是 openCount（整棵树）而不是前沿'],
        [/if \(open > 0\) \{/, 'convergeProblems 用 open > 0 作判据'],
        [/const ids = \(batch\.decisions \?\? \[\]\)/, '收集未闭合决定的 id'],
        [/problems\.push\('还有 ' \+ open \+ ' 个决定没定：' \+ ids\.join\('、'\)\)/, '「还有 N 个决定没定」这一条拒绝'],
      ])

      // 情形一：两个决定，都没答。
      const twoOpen = goodBatch({
        decisions: [
          { id: 'DA', kind: 'goal', title: 'a', body: 'b', dependsOn: [] },
          { id: 'DB', kind: 'scope', title: 'a', body: 'b', dependsOn: ['DA'] },
        ],
      })
      must(openCount(twoOpen) === 2, '造的数据不对：openCount 该是 2，实际 ' + openCount(twoOpen))
      const twoProblems = convergeProblems(twoOpen)
      must(
        twoProblems.some((problem) => problem.includes('还有 2 个决定没定')),
        '两个决定都没定，收敛闸门却说走完了：' + JSON.stringify(twoProblems),
      )
      must(
        twoProblems.some((problem) => problem.includes('DA') && problem.includes('DB')),
        '「还有 N 个决定没定」没把没定的 id 列出来，人不知道该问什么',
      )

      // 情形二（历史漏洞）：两个决定依赖成环，前沿永远是空的。
      const cyclic = goodBatch({
        decisions: [
          { id: 'DC1', kind: 'design', title: 'a', body: 'b', dependsOn: ['DC2'] },
          { id: 'DC2', kind: 'risk', title: 'a', body: 'b', dependsOn: ['DC1'] },
        ],
      })
      must(
        frontier(cyclic).length === 0,
        '前置不成立：成环时前沿该是空的（不然这道探针测不到那个漏洞）',
      )
      must(
        convergeProblems(cyclic).some((problem) => problem.includes('还有 2 个决定没定')),
        '成环时前沿为空，收敛闸门把一棵永远走不完的树当成了走完了',
      )

      // 情形三：一个定了一个没定 → 报 1。
      const mixed = goodBatch({
        decisions: [
          { id: 'DD1', kind: 'goal', title: 'a', body: 'b', dependsOn: [], answer: '定了' },
          { id: 'DD2', kind: 'scope', title: 'a', body: 'b', dependsOn: ['DD1'] },
        ],
      })
      must(
        convergeProblems(mixed).some((problem) => problem.includes('还有 1 个决定没定')),
        '只差一个没定时，报的数不是 1',
      )

      // 反面对照：全部定完就不许再报这条。
      must(
        !convergeProblems(goodBatch()).some((problem) => problem.includes('个决定没定')),
        '所有决定都定了，收敛闸门还在说「有决定没定」',
      )
      // 反面对照：整本合法的批次收敛问题必须是空数组。
      must(
        convergeProblems(goodBatch()).length === 0,
        '合规批次的收敛问题不是空的：' + JSON.stringify(convergeProblems(goodBatch())),
      )
    },
  },

  // ── 收敛：依赖成环 ───────────────────────────────────────────
  {
    id: 'g-core-converge-cycle',
    title: 'dependencyProblems 抓到决定依赖成环，且不误报无环的链',
    covers: ['core.js#dependencyProblems', 'core.js#findCycleIn'],
    probe: async () => {
      anchors([
        [/const cycle = findCycleIn\(decisions\.map\(\(decision\) => \(\{ id: decision\.id, deps: decision\.dependsOn \?\? \[\] \}\)\)\)/, 'dependencyProblems 里的成环检查'],
        [/决定依赖成环：/, '「决定依赖成环」这条拒绝文案'],
        [/if \(dep === decision\.id\) problems\.push\(decision\.id \+ ' 依赖了它自己'\)/, '自依赖的单独判据'],
        [/problems\.push\(decision\.id \+ ' 依赖了不存在的 ' \+ dep\)/, '指向不存在的依赖的判据'],
      ])

      const cyclic = goodBatch({
        decisions: [
          { id: 'E1', kind: 'design', title: 'a', body: 'b', dependsOn: ['E2'] },
          { id: 'E2', kind: 'risk', title: 'a', body: 'b', dependsOn: ['E1'] },
        ],
      })
      const cyclicProblems = dependencyProblems(cyclic)
      must(
        cyclicProblems.some((problem) => problem.includes('成环')),
        '两个决定互相依赖却没报成环：' + JSON.stringify(cyclicProblems),
      )
      must(
        cyclicProblems.some((problem) => problem.includes('E1') && problem.includes('E2')),
        '报了环但没把环上的 id 写出来',
      )

      // 反面对照一：有先后顺序的链不是环。
      const chain = goodBatch({
        decisions: [
          { id: 'E1', kind: 'goal', title: 'a', body: 'b', dependsOn: [] },
          { id: 'E2', kind: 'scope', title: 'a', body: 'b', dependsOn: ['E1'] },
          { id: 'E3', kind: 'design', title: 'a', body: 'b', dependsOn: ['E2'] },
        ],
      })
      must(
        !dependencyProblems(chain).some((problem) => problem.includes('成环')),
        '一条正常的链被误报成环了：' + JSON.stringify(dependencyProblems(chain)),
      )

      // 反面对照二：自依赖与不存在的依赖各报各的。
      must(
        dependencyProblems({ decisions: [{ id: 'E9', dependsOn: ['E9'] }] })
          .some((problem) => problem.includes('依赖了它自己')),
        '决定依赖自己却没报',
      )
      must(
        dependencyProblems({ decisions: [{ id: 'E9', dependsOn: ['E404'] }] })
          .some((problem) => problem.includes('依赖了不存在的')),
        '指向不存在的决定却没报',
      )
    },
  },

  // ── 收敛：规格三件套 ─────────────────────────────────────────
  {
    id: 'g-core-converge-spec',
    title: '规格缺目标、验收标准为空数组、验收标准是空串，三种都报',
    covers: ['core.js#convergeProblems'],
    probe: async () => {
      anchors([
        [/if \(typeof spec\.goal !== 'string' \|\| spec\.goal\.trim\(\) === ''\) problems\.push\('规格缺目标'\)/, '规格缺目标的判据'],
        [/if \(!Array\.isArray\(spec\.acceptance\) \|\| spec\.acceptance\.length === 0\) \{/, '验收标准为空数组的判据'],
        [/problems\.push\('规格至少要有一条验收标准'\)/, '「规格至少要有一条验收标准」这条拒绝'],
        [/const blank = spec\.acceptance\.filter\(\(item\) => typeof item !== 'string' \|\| item\.trim\(\) === ''\)/, '逐条验收标准的空值过滤'],
        [/problems\.push\('有 ' \+ blank\.length \+ ' 条验收标准是空的/, '「有 N 条验收标准是空的」这条拒绝'],
      ])

      // 情形一：缺 goal 字段。
      must(
        convergeProblems(goodBatch({ spec: { nonGoals: [], acceptance: ['能跑通'] } }))
          .some((problem) => problem.includes('规格缺目标')),
        '规格没有 goal 却没报缺目标',
      )
      // 情形一之二：goal 是空白。
      must(
        convergeProblems(goodBatch({ spec: { goal: '   ', nonGoals: [], acceptance: ['能跑通'] } }))
          .some((problem) => problem.includes('规格缺目标')),
        'goal 是空白字符串却没报缺目标',
      )

      // 情形二：acceptance 是空数组。
      must(
        convergeProblems(goodBatch({ spec: { goal: 'g', nonGoals: [], acceptance: [] } }))
          .some((problem) => problem.includes('至少要有一条验收标准')),
        'acceptance 是空数组却没报「至少要有一条验收标准」',
      )
      // 情形二之二：acceptance 根本不是数组。
      must(
        convergeProblems(goodBatch({ spec: { goal: 'g', nonGoals: [], acceptance: '能跑通' } }))
          .some((problem) => problem.includes('至少要有一条验收标准')),
        'acceptance 不是数组却没报「至少要有一条验收标准」',
      )

      // 情形三：混进一条空串——条数够，但那条没有料。
      must(
        convergeProblems(goodBatch({ spec: { goal: 'g', nonGoals: [], acceptance: ['能跑通', ''] } }))
          .some((problem) => problem.includes('有 1 条验收标准是空的')),
        'acceptance 里混了一条空串却没报「有 1 条空」',
      )
      // 情形三之二：两条空串时报 2，不是永远报 1。
      must(
        convergeProblems(goodBatch({ spec: { goal: 'g', nonGoals: [], acceptance: ['', '   ', '能跑通'] } }))
          .some((problem) => problem.includes('有 2 条验收标准是空的')),
        '两条空验收标准时没报「有 2 条空」',
      )

      // 情形四：整个 spec 都没有。
      must(
        convergeProblems(goodBatch({ spec: undefined }))
          .some((problem) => problem.includes('还没有规格')),
        '没有 spec 却没报「还没有规格」',
      )

      // 反面对照：合规规格一条都不许报。
      const specProblems = convergeProblems(goodBatch())
      must(
        !specProblems.some((problem) => problem.includes('规格') || problem.includes('验收标准')),
        '合规规格被报了问题：' + JSON.stringify(specProblems),
      )
    },
  },

  // ── 批准只能由人做 ───────────────────────────────────────────
  {
    id: 'g-core-approve-human-only',
    title: 'approveProblems 只认明确的 false，true/1/"true"/{} 一律报「批准不对模型开放」',
    covers: ['core.js#approveProblems'],
    probe: async () => {
      anchors([
        [/if \(batch\.status !== 'converged'\) \{/, '「只有收敛后的批次才能批准」这道前置检查'],
        [/if \(byModel !== false\) \{/, 'fail-closed 判据：只有明确的 false 才放行'],
        [/problems\.push\('批准不对模型开放：设计批准必须由人点按钮'\)/, '「批准不对模型开放」这条拒绝'],
      ])

      const converged = goodBatch({ status: 'converged' })

      // 破的那一面：模型来批准，必须被拦。
      must(
        approveProblems(converged, true).some((problem) => problem.includes('批准不对模型开放')),
        '模型传 true 批准却放行了——这条闸门的全部意义就是模型不能批准自己的设计',
      )

      // 真值但非 false 的入参：历史上 `byModel === true` 被它们静默绕过。
      for (const value of [1, 'true', {}, [], 'yes', 'false']) {
        must(
          approveProblems(converged, value).some((problem) => problem.includes('批准不对模型开放')),
          '模型侧批准被放行了：byModel = ' + JSON.stringify(value) + '（只有明确的 false 才该放行）',
        )
      }
      // 假值但非 false 的也一样：undefined / null / 0 / '' 都来自「没传」，不是人点的按钮。
      for (const value of [undefined, null, 0, '']) {
        must(
          approveProblems(converged, value).some((problem) => problem.includes('批准不对模型开放')),
          '没传 byModel（' + String(value) + '）却当成人在批准',
        )
      }

      // 反面对照：人在面板上点批准（false）时，收敛后的批次必须完全放行。
      must(
        approveProblems(converged, false).length === 0,
        '人批准收敛后的批次被拦了：' + JSON.stringify(approveProblems(converged, false)),
      )

      // 反面对照：状态这道前置检查还活着——没收敛就算人点也不许批。
      must(
        approveProblems(goodBatch({ status: 'approved' }), false)
          .some((problem) => problem.includes('只有收敛后的批次才能批准')),
        '状态还没收敛，人点批准却被放行了',
      )
    },
  },

  // ── 盘问账本：同一个口径数问题 ───────────────────────────────
  {
    id: 'g-core-design-questions',
    title: 'answeredQuestionCount 去重、不算 fact、不算空答案',
    covers: ['core.js#answeredQuestionCount'],
    probe: async () => {
      anchors([
        [/export function answeredQuestionCount\(questions\) \{/, 'answeredQuestionCount 本身'],
        [/const distinct = new Set\(\)/, '按问题去重的集合'],
        [/if \(entry\?\.kind === 'fact'\) continue/, 'fact 型问题跳过'],
        [/if \(typeof entry\?\.answer !== 'string' \|\| entry\.answer\.trim\(\) === ''\) continue/, '空答案与「不是字符串」的答案跳过'],
        [/if \(typeof entry\?\.question !== 'string'\) continue/, '没有问题的条目跳过'],
        [/distinct\.add\(entry\.question\)/, '按**问题文本**去重'],
        [/return distinct\.size/, '返回的是不同的问题数'],
      ])

      // 破的那一面：同一问题答三遍算 1。
      must(
        answeredQuestionCount([
          { question: '目标是什么？', answer: 'a' },
          { question: '目标是什么？', answer: 'a' },
          { question: '目标是什么？', answer: 'a' },
        ]) === 1,
        '同一条问题答了三遍被算成 3 个',
      )

      // fact 型不算——事实是模型自己的活。
      must(
        answeredQuestionCount([{ kind: 'fact', question: '仓库里有哪些测试？', answer: '十几个' }]) === 0,
        'fact 型问题被算进盘问里了',
      )

      // 空答案 / 空白答案不算。
      must(
        answeredQuestionCount([{ question: 'q-empty', answer: '' }]) === 0,
        'answer 是空串却被算成已回答',
      )
      must(
        answeredQuestionCount([{ question: 'q-blank', answer: '   \n\t ' }]) === 0,
        'answer 是空白字符却被算成已回答',
      )

      // 真的 undefined（不是字符串）不算——这里量的是 typeof，不是真值。
      must(
        answeredQuestionCount([{ question: 'q-undefined', answer: undefined }]) === 0,
        'answer 是 undefined 却被算成已回答',
      )
      must(
        answeredQuestionCount([{ question: 'q-missing' }]) === 0,
        '根本没 answer 字段却被算成已回答',
      )
      // 注意（看清楚实现再断言）：answer 是字面量字符串 "undefined" 时，
      // 现实现**会**把它算成已回答——它只是个非空字符串。这里不断言那一格，
      // 免得把「实现细节」钉成判据。

      // 没有 question 文本的条目不算：去重键就是问题文本。
      must(
        answeredQuestionCount([{ answer: 'a' }]) === 0,
        '没有 question 字段的条目被算成一个问题',
      )

      // 非数组入参不崩。
      must(answeredQuestionCount(undefined) === 0, '入参不是数组时 answeredQuestionCount 崩了')
      must(answeredQuestionCount([]) === 0, '空账本数出来不是 0')

      // 反面对照：三个不同问题都答了就必须是 3。
      must(
        answeredQuestionCount([
          { kind: 'goal', question: '目标是什么？', answer: 'a' },
          { kind: 'scope', question: '范围到哪？', answer: 'b' },
          { kind: 'risk', question: '什么情况下会失败？', answer: 'c' },
        ]) === 3,
        '三个不同问题都答了，却数不出 3 个',
      )

      // 混着脏数据时数得对：2 个有效 + 重复 + fact + 空答案。
      must(
        answeredQuestionCount([
          { kind: 'goal', question: '目标', answer: 'a' },
          { kind: 'scope', question: '范围', answer: 'b' },
          { kind: 'fact', question: '我自己查的事实', answer: 'c' },
          { kind: 'goal', question: '目标', answer: 'a' },
          { kind: 'design', question: '空答案', answer: '   ' },
          { kind: 'design', question: '没答案' },
        ]) === 2,
        '混着脏数据时数错了（该是 2）',
      )
    },
  },

  // ── 派发：每张票挂风险 ───────────────────────────────────────
  {
    id: 'g-core-dispatch-risk-binding',
    title: '票没挂风险、riskFree 没写理由、引用了不存在的风险 id，三种都报',
    covers: ['core.js#dispatchProblems'],
    probe: async () => {
      anchors([
        [/if \(!Array\.isArray\(ticket\.riskIds\) \|\| ticket\.riskIds\.length === 0\) \{/, '「没挂风险」的判据'],
        [/problems\.push\(ticket\.id \+ ' 没挂风险；确实无关就写 riskFree 并说明理由'\)/, '「没挂风险」这条拒绝'],
        [/if \(!riskIds\.has\(id\)\) problems\.push\(ticket\.id \+ ' 引用了不存在的风险 ' \+ id\)/, '引用不存在的风险 id 的判据'],
        [/else if \(typeof ticket\.riskFreeReason !== 'string' \|\| ticket\.riskFreeReason\.trim\(\) === ''\) \{/, 'riskFree 理由必须非空'],
        [/problems\.push\(ticket\.id \+ ' 标了 riskFree 但没写理由'\)/, '「标了 riskFree 但没写理由」这条拒绝'],
      ])

      // 反面对照：合规批次必须完全放行（0 条问题）。
      must(
        dispatchProblems(goodBatch()).length === 0,
        '合规批次被派发闸门拦了：' + JSON.stringify(dispatchProblems(goodBatch())),
      )

      // 情形一：既没挂风险、也没写 riskFree。
      must(
        dispatchProblems(goodBatch({ tickets: [goodTicket({ riskIds: [], riskFree: false })] }))
          .some((problem) => problem.includes('没挂风险')),
        '票没挂风险也没写 riskFree，却放行了',
      )
      // 情形一之二：riskIds 压根不是数组。
      must(
        dispatchProblems(goodBatch({ tickets: [goodTicket({ riskIds: undefined, riskFree: false })] }))
          .some((problem) => problem.includes('没挂风险')),
        'riskIds 缺失却放行了',
      )

      // 情形二：标了 riskFree，理由空白。
      for (const reason of ['', '   ', undefined]) {
        must(
          dispatchProblems(goodBatch({
            tickets: [goodTicket({ riskFree: true, riskIds: [], riskFreeReason: reason })],
          })).some((problem) => problem.includes('标了 riskFree 但没写理由')),
          '标了 riskFree 但理由是 ' + String(reason) + '，却放行了',
        )
      }

      // 情形三：引用了账本里不存在的风险 id。
      must(
        dispatchProblems(goodBatch({ tickets: [goodTicket({ riskIds: ['R-404'] })] }))
          .some((problem) => problem.includes('引用了不存在的风险 R-404')),
        '票引用了不存在的风险 id，却放行了',
      )
      // 情形三之二：一条真一条假，假的那条要单独报出来。
      must(
        dispatchProblems(goodBatch({ tickets: [goodTicket({ riskIds: ['R-1', 'R-404'] })] }))
          .some((problem) => problem.includes('R-404')),
        '一条真一条假时，假的那条没报出来',
      )

      // 反面对照：riskFree 写了真理由的票必须放行。
      must(
        dispatchProblems(goodBatch({
          tickets: [goodTicket({ riskFree: true, riskIds: [], riskFreeReason: '这张票只改文档里的错别字，不碰代码' })],
        })).length === 0,
        'riskFree 写了理由的票仍被拦：' + JSON.stringify(dispatchProblems(goodBatch({
          tickets: [goodTicket({ riskFree: true, riskIds: [], riskFreeReason: '这张票只改文档里的错别字，不碰代码' })],
        }))),
      )
    },
  },

  // ── 派发：工单阻塞边成环 ─────────────────────────────────────
  {
    id: 'g-core-dispatch-ticket-cycle',
    title: '工单阻塞边成环时报「阻塞边成环」，有先后的链不误报',
    covers: ['core.js#dispatchProblems', 'core.js#findCycleIn'],
    probe: async () => {
      anchors([
        [/const cycle = findCycleIn\(tickets\.map\(\(ticket\) => \(\{ id: ticket\.id, deps: ticket\.blockedBy \?\? \[\] \}\)\)\)/, '工单阻塞边的成环检查'],
        [/if \(cycle !== undefined\) problems\.push\('工单阻塞边成环：' \+ cycle\.join\(' -> '\)\)/, '「工单阻塞边成环」这条拒绝'],
        [/if \(!ids\.has\(dep\)\) problems\.push\(ticket\.id \+ ' 被不存在的工单阻塞：' \+ dep\)/, '被不存在的工单阻塞的判据'],
      ])

      const cyclic = goodBatch({
        tickets: [
          goodTicket({ id: 'T-1', blockedBy: ['T-2'] }),
          goodTicket({ id: 'T-2', blockedBy: ['T-1'] }),
        ],
      })
      const cyclicProblems = dispatchProblems(cyclic)
      must(
        cyclicProblems.some((problem) => problem.includes('阻塞边成环')),
        '两张票互相阻塞却没报「阻塞边成环」：' + JSON.stringify(cyclicProblems),
      )
      must(
        cyclicProblems.some((problem) => problem.includes('T-1') && problem.includes('T-2')),
        '报了成环但没把环上的工单 id 写出来',
      )

      // 反面对照：有先后顺序的链不是环。
      const chain = goodBatch({
        tickets: [
          goodTicket({ id: 'T-1', blockedBy: [] }),
          goodTicket({ id: 'T-2', blockedBy: ['T-1'] }),
        ],
      })
      must(
        !dispatchProblems(chain).some((problem) => problem.includes('成环')),
        '一条正常的阻塞链被误报成环：' + JSON.stringify(dispatchProblems(chain)),
      )
      must(
        dispatchProblems(chain).length === 0,
        '合法的链被报出了问题：' + JSON.stringify(dispatchProblems(chain)),
      )

      // 反面对照：被不存在的工单阻塞要单独报（不是成环，也不是放行）。
      must(
        dispatchProblems(goodBatch({ tickets: [goodTicket({ id: 'T-1', blockedBy: ['T-404'] })] }))
          .some((problem) => problem.includes('被不存在的工单阻塞')),
        '被不存在的工单阻塞却没报',
      )
    },
  },

  // ── 派发：工单 id 必须唯一 ───────────────────────────────────
  {
    id: 'g-core-dispatch-duplicate-ids',
    title: '两张票 id 相同时报「工单 id 重复」，不同 id 时不误报',
    covers: ['core.js#dispatchProblems'],
    probe: async () => {
      anchors([
        [/if \(ids\.size !== tickets\.length\) \{/, '「id 唯一」的判据（集合大小对不上就报）'],
        [/const duplicated = \[\.\.\.new Set\(/, '把重复的那几个 id 挑出来'],
        [/problems\.push\('工单 id 重复：' \+ duplicated\.join\('、'\) \+ '（每张票的 id 必须唯一）'\)/, '「工单 id 重复」这条拒绝'],
      ])

      // 破的那一面：两张票都叫 T-1。
      const duplicated = goodBatch({
        tickets: [
          goodTicket({ id: 'T-1', blockedBy: [] }),
          goodTicket({ id: 'T-1', blockedBy: [] }),
        ],
      })
      const problems = dispatchProblems(duplicated)
      must(
        problems.some((problem) => problem.includes('工单 id 重复')),
        '两张票 id 相同却没报「工单 id 重复」：' + JSON.stringify(problems),
      )
      must(
        problems.some((problem) => problem.includes('T-1')),
        '报了重复但没说重复的是哪个 id',
      )

      // 重复 id 藏起来的环也得报：按 id 建图的实现会漏掉下面这条边。
      const hiddenCycle = goodBatch({
        tickets: [
          goodTicket({ id: 'T-1', blockedBy: ['T-2'] }),
          goodTicket({ id: 'T-2', blockedBy: ['T-1'] }),
          goodTicket({ id: 'T-1', blockedBy: [] }),
        ],
      })
      must(
        dispatchProblems(hiddenCycle).some((problem) => problem.includes('成环')),
        '重复 id 把真实的环藏起来了（按 id 建图会覆盖掉被重复那张票的边）',
      )

      // 反面对照：id 各不相同的批次不报重复。
      const distinct = goodBatch({
        tickets: [
          goodTicket({ id: 'T-1', blockedBy: [] }),
          goodTicket({ id: 'T-2', blockedBy: ['T-1'] }),
        ],
      })
      must(
        !dispatchProblems(distinct).some((problem) => problem.includes('工单 id 重复')),
        'id 各不相同却被报成重复',
      )
    },
  },

  // ── 派发：模型与理由 ─────────────────────────────────────────
  {
    id: 'g-core-dispatch-model',
    title: 'model 是空对象 / 没有 model 字段时报「没定模型」，modelReason 空白时报「没写 modelReason」',
    covers: ['core.js#dispatchProblems'],
    probe: async () => {
      anchors([
        [/if \(typeof ticket\.model\?\.model !== 'string' \|\| ticket\.model\.model\.trim\(\) === ''\) \{/, '「模型必须真的指定了」的判据（查的是 model.model）'],
        [/problems\.push\(ticket\.id \+ ' 没定模型：得写清 model: \{provider, model\}'\)/, '「没定模型」这条拒绝'],
        [/if \(typeof ticket\.modelReason !== 'string' \|\| ticket\.modelReason\.trim\(\) === ''\) \{/, 'modelReason 必须非空的判据'],
        [/problems\.push\(ticket\.id \+ ' 没写 modelReason：模型为什么选这个'\)/, '「没写 modelReason」这条拒绝'],
      ])

      // 破的那一面：看着像「定了」，其实 model 字段是空的。
      for (const model of [{}, { provider: 'p' }, { provider: 'p', model: '' }, { provider: 'p', model: '   ' }]) {
        must(
          dispatchProblems(goodBatch({ tickets: [goodTicket({ model })] }))
            .some((problem) => problem.includes('没定模型')),
          '模型没真正指定却被放行了：' + JSON.stringify(model),
        )
      }
      // model 整个缺失。
      must(
        dispatchProblems(goodBatch({ tickets: [goodTicket({ model: undefined })] }))
          .some((problem) => problem.includes('没定模型')),
        'ticket 上根本没有 model 字段，却被放行了',
      )

      // modelReason 空白。
      for (const reason of ['', '   ', undefined]) {
        must(
          dispatchProblems(goodBatch({ tickets: [goodTicket({ modelReason: reason })] }))
            .some((problem) => problem.includes('没写 modelReason')),
          'modelReason 是 ' + String(reason) + ' 时被放行了',
        )
      }

      // 反面对照：模型与理由都齐的票必须放行。
      must(
        dispatchProblems(goodBatch()).length === 0,
        '模型和理由都齐全却仍被拦：' + JSON.stringify(dispatchProblems(goodBatch())),
      )
    },
  },

  // ── 验证方式：承诺的单测得真的存在 ───────────────────────────
  {
    id: 'g-core-verification-test-present',
    title: '验证方式承诺的单测必须真有那条文件；只写「单测」不指名就要求改成「人工核对」；写了人工核对不查',
    covers: ['core.js#verificationTestGap'],
    probe: async () => {
      anchors([
        [/const claimsUnitTest = \/单测\|单元测试\|自动化测试\|unit\\s\*test\|unittest\/i\.test\(verification\)/, '「只有提到单测一类措辞才查」的判据'],
        [/if \(!claimsUnitTest\) return ''/, '不含单测措辞的直接放行'],
        [/const named = verification\.match\(\/\[\\w\.\/-\]\+\\\.\(\?:test\\\.\|spec\\\.\)\?\(\?:mjs\|js\|ts\)\\b\/g\) \?\? \[\]/, '从验证方式里抓文件名'],
        [/if \(files\.size === 0\) \{/, '「这个目录一个测试都没扫到」与「没有这条测试」分开说的判据'],
        [/const missing = named\.filter/, '逐个查承诺的文件在不在'],
        [/却没说是哪条测试/, '「承诺了单测却没指名」这条拒绝'],
        [/人工核对/, '拒绝里给出的出路：改成人工核对'],
      ])

      // test/ 下真实存在的测试文件（risk-r1.test.mjs 已确认在仓库里）。
      // 这里不扫目录：探针只读源码做锚点，不碰别的文件系统。
      const files = ['risk-r1.test.mjs', 'core.test.mjs', 'core-gates.test.mjs', 'observer-report.test.mjs']

      // 放行的那一面：写的是真有那条测试。
      must(
        verificationTestGap({ id: 'R-1', verification: '单测：risk-r1.test.mjs 断言抛错' }, files) === '',
        '写了真的存在的 risk-r1.test.mjs 却被拦了',
      )
      must(
        verificationTestGap({ id: 'R-1', verification: '单测：test/core-gates.test.mjs 断言成环被拦' }, files) === '',
        '写了带目录的真测试文件却被拦了',
      )
      // 只写主干名，且主干对得上某个测试文件。
      must(
        verificationTestGap({ id: 'R-1', verification: '单测：risk-r1 里断言抛错' }, files) === '',
        '只写主干名 risk-r1（仓库里确有 risk-r1.test.mjs）却被拦了',
      )

      // 拦住的那一面：承诺了不存在的东西。
      must(
        verificationTestGap({ id: 'R-1', verification: '单测：never-written.test.mjs' }, files) !== '',
        '承诺了一条不存在的测试却被放行了——这正是「缓解措施只是写着」的那种假承诺',
      )
      must(
        verificationTestGap({ id: 'R-1', verification: '单测：见 test/never-written.test.mjs' }, files) !== '',
        '带目录的不存在测试被放行了',
      )

      // 只写「单测」，没指名 → 非空，且给出的出路是「人工核对」。
      const vague = verificationTestGap({ id: 'R-1', verification: '单测：把整条链路跑一遍' }, files)
      must(vague !== '', '只写了「单测」却没指名文件，却放行了')
      must(vague.includes('人工核对'), '拒绝了但没告诉模型可以改成「人工核对：…」')

      // 写了人工核对 → 不查，直接放行。
      must(
        verificationTestGap({ id: 'R-1', verification: '人工核对：在面板上点一遍批准，看横幅是否出现' }, files) === '',
        '本来就是人工核对的验证方式被拦了',
      )
      // 不含「单测」二字的一次性人工验证也不查。
      must(
        verificationTestGap({ id: 'R-1', verification: '这次跑一遍看看，肉眼确认输出正常' }, files) === '',
        '没提到单测的验证方式被拦了',
      )

      // 边界：一个测试文件都没扫到时，要说清「这个目录没有测试」而不是「没有这条测试」。
      const emptyDir = verificationTestGap({ id: 'R-1', verification: '单测：core-gates.test.mjs 断言' }, [])
      must(emptyDir !== '', '空目录时报成了通过')
      must(
        emptyDir.includes('一个测试文件都没扫到') && emptyDir.includes('cwd'),
        '空目录的情况被说成「没有这条测试」，人去找文件会白找一场',
      )

      // 反面对照：真存在的测试 + 四栏齐全的风险，整本台账不许报问题。
      must(
        riskGaps(goodRisk({
          verification: '单测：risk-r1.test.mjs 断言不传 batchId 时抛错',
        })).length === 0,
        '验证方式写对了，四栏却报缺口',
      )
    },
  },
]
