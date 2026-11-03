/**
 * 工具层闸门的自检探针。
 *
 * 每条探针都做两件事，缺一不可：
 *
 * 1. **源码锚点**：断言 lib/ 里那句判据还在。判据被删掉、被注释掉，就报破。
 *    锚点只看**代码**（先把注释剥掉再匹配），所以注释文字被改写不算破——
 *    注释会被随口重写，判据不会。
 * 2. **行为探针**：在临时 $WT_HOME 里真调一次工具，断言拒绝真的发生了，
 *    而且副作用没发生（一个子会话都没建、台账里没多出一条风险）。
 *
 * 为什么两条都要：只有锚点，改了实现就验不到行为；只有行为，判据被搬到
 * 别处或被注释掉也可能靠着兜底逻辑「看起来还对」。两道一起才拦得住
 * 「报错了但还是写进去了」和「什么都拒，探针却全绿」这两种假绿。
 *
 * 台账只走临时 $WT_HOME，绝不碰 ~/.dsh。
 *
 * @module dsh-whale-tail/scripts/gates/tools
 */
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildTools } from '../../lib/tools.js'
import { blankBatch, save, load } from '../../lib/ledger.js'
import { answeredQuestionCount, designGateProblems } from '../../lib/core.js'
import { listTestFiles } from '../../lib/verifyscan.js'

/** 仓库根目录：测试文件清单要从真仓库里扫，不能手写假的。 */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/**
 * 剥掉 JS 源码里的注释，只留代码。
 *
 * 为什么必须剥：`// throw new MiddlemanError('batch-required', …)` 这行被
 * 注释掉之后，原文里那个字符串还在——不剥注释的话正则照样命中，闸门被
 * 停用了探针却是绿的。剥掉之后，注释掉的判据就真的「不见了」。
 *
 * 字符串里的 // 与 /* 不算注释，所以引号要整段跳过。
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

/** 剥完注释的源码缓存：一个进程里每个文件只读一次。 */
const codeCache = new Map()

/**
 * 读 lib/ 下一个文件，返回去掉注释的代码。
 * @param name - 文件名，如 'tools.js'。
 * @returns 源码。
 */
function codeOf(name) {
  const cached = codeCache.get(name)
  if (cached !== undefined) return cached
  const source = stripComments(
    readFileSync(new URL('../../lib/' + name, import.meta.url), 'utf8'),
  )
  codeCache.set(name, source)
  return source
}

/** 探针里的断言：不成立就抛一句中文说明。 */
function must(condition, message) {
  if (!condition) throw new Error(message)
}

/**
 * 断言 lib/ 里的判据还在。
 * @param name - 文件名。
 * @param patterns - [正则, 人话描述] 列表。
 */
function anchors(name, patterns) {
  const code = codeOf(name)
  for (const [pattern, label] of patterns) {
    must(pattern.test(code), 'lib/' + name + ' 里那句判据不见了：' + label)
  }
}

/**
 * 跑一次，必须抛错；把错误对象还回来。
 * @param run - 待跑的调用。
 * @param message - 没抛错时的报破说明。
 * @returns 抛出来的错误。
 */
async function rejectionOf(run, message) {
  try {
    await run()
  } catch (error) {
    return error
  }
  throw new Error(message + '（没有抛错）')
}

/**
 * 在临时 $WT_HOME 里跑一段：台账落临时目录，跑完连目录一起删。
 * @param run - 拿到 home 路径的回调。
 * @returns 回调的返回值。
 */
async function withTempHome(run) {
  const previous = process.env.WT_HOME
  const home = mkdtempSync(join(tmpdir(), 'mm-check-'))
  process.env.WT_HOME = home
  try {
    return await run(home)
  } finally {
    if (previous === undefined) delete process.env.WT_HOME
    else process.env.WT_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

/**
 * 造一个只记 spawn 调用的假派发面。
 *
 * testFiles 走真的 listTestFiles(仓库根)——手写假清单会让「承诺的单测在不在」
 * 那道闸门验不真：假清单里写什么都有，闸门就永远是绿的。
 *
 * @returns {{ spawns: Array, faces: object }}
 */
function fakeFaces() {
  const spawns = []
  return {
    spawns,
    faces: {
      dispatcher: {
        async spawn(ticket, options) {
          spawns.push({ ticket, options })
          return { sessionId: 'session-should-not-exist', model: { provider: 'p', model: 'm' } }
        },
      },
      testFiles: async () => await listTestFiles(REPO_ROOT),
      warn() {},
    },
  }
}

/** 取工具面里某个工具的定义。 */
function toolOf(tools, name) {
  const found = tools.find((tool) => tool.name === name)
  must(found !== undefined, '工具面里没有 ' + name)
  return found
}

/** 一份四栏齐全、验证方式是「人工核对」的风险草稿——各条探针按需改一栏。 */
function draftRisk(over = {}) {
  return {
    title: '测试用风险',
    trigger: '主会话绕过盘问，不带 batchId 直接派发',
    impact: '子会话白建，额度白花，而且没人知道派过',
    mitigation: '在 dispatch_task 里用代码拒绝，不看提示词',
    verification: '人工核对：跑一遍，看主会话是否收到 [子任务回报]',
    ...over,
  }
}

/** 一张能过闸门的工单。 */
function ticket(id = 'T-1') {
  return {
    id,
    title: '可派的票',
    brief: '干活',
    blockedBy: [],
    riskIds: ['R-1'],
    riskFree: false,
    riskFreeReason: undefined,
    model: { provider: 'p', model: 'm' },
    modelReason: '活不长，快模型够用',
    source: undefined,
    payload: undefined,
    effort: undefined,
    notes: undefined,
    status: 'pending',
  }
}

/** 一个已经过设计闸门、但状态是 approved 的批次（不给它省任何一步）。 */
function approvedBatch(title) {
  const batch = blankBatch(title)
  batch.status = 'approved'
  batch.questions = [
    { question: 'q1', answer: 'a1' },
    { question: 'q2', answer: 'a2' },
    { question: 'q3', answer: 'a3' },
  ]
  batch.plan = { steps: '第一步', output: '一份文件' }
  batch.risks = [{
    id: 'R-1',
    title: '绕过盘问',
    trigger: '不带 batchId 直接派发',
    impact: '额度白花',
    mitigation: '代码里拒绝',
    verification: '人工核对：跑一遍看回报',
  }]
  batch.tickets = [ticket()]
  return batch
}

export const toolGates = [
  {
    id: 'g-tool-batch-required',
    title: 'dispatch_task 不带 batchId 抛 batch-required，且一个子会话都不建',
    covers: ['tools.js#dispatch_task', 'tools.js#batch-required'],
    async probe() {
      anchors('tools.js', [
        [/throw new MiddlemanError\(\s*'batch-required'/, "throw new MiddlemanError('batch-required', …)"],
        [/typeof args\.batchId !== 'string' \|\| args\.batchId\.trim\(\) === ''/, 'dispatch_task 开头那道 batchId 检查（含 trim）'],
      ])

      await withTempHome(async (home) => {
        const { faces, spawns } = fakeFaces()
        const dispatch = toolOf(buildTools(faces), 'dispatch_task')

        const error = await rejectionOf(
          () => dispatch.execute({ ticketId: 'T-1' }),
          '不带 batchId 的派发被放行了',
        )
        must(error.code === 'batch-required', '拒绝该用机器码 batch-required，实际是：' + error.code)
        must(spawns.length === 0, '抛了错却还是建了子会话——额度已经花掉，这条风险没防住')
        must(!existsSync(join(home, 'designs')), '被拒绝的派发却在台账里写下了东西')
      })
    },
  },

  {
    id: 'g-tool-batch-required-blank',
    title: 'batchId 是空白串（"   "）也拒绝——空白不算「带了」',
    covers: ['tools.js#dispatch_task', 'tools.js#batchId.trim'],
    async probe() {
      anchors('tools.js', [
        [/typeof args\.batchId !== 'string' \|\| args\.batchId\.trim\(\) === ''/, '判据必须 trim 后判空，不能只判 falsy'],
      ])

      await withTempHome(async () => {
        const { faces, spawns } = fakeFaces()
        const dispatch = toolOf(buildTools(faces), 'dispatch_task')

        // 真出过的绕过：batchId 写成空白串，`!args.batchId` / `batchId === ''`
        // 这类判法都会放行，于是「没有批次不许派发」这道闸门一道就过了。
        for (const blank of ['   ', '\t', '\n  ']) {
          const error = await rejectionOf(
            () => dispatch.execute({ batchId: blank, ticketId: 'T-1' }),
            '空白 batchId（' + JSON.stringify(blank) + '）被当成「带了批次」放行了',
          )
          must(
            error.code === 'batch-required',
            '空白 batchId 该用 batch-required 拒绝，实际是：' + error.code,
          )
        }
        must(spawns.length === 0, '空白 batchId 被拒了，却还是建了子会话')
      })
    },
  },

  {
    id: 'g-tool-dispatch-blocked',
    title: '批次存在但设计闸门没过 → 返回 dispatch-blocked 与 problems，不建会话',
    covers: ['tools.js#dispatchProblems', 'tools.js#dispatch-blocked', 'core.js#dispatchProblems'],
    async probe() {
      anchors('tools.js', [
        [/const problems = dispatchProblems\(batch,\s*await faces\.testFiles/, '派发前再查一遍 dispatchProblems（含 testFiles）'],
        [/'dispatch-blocked'/, "'dispatch-blocked' 这个拒绝码"],
        [/if \(problems\.length > 0\) return refusal\('dispatch-blocked', problems\)/, '闸门没过必须先 return，不能先 spawn'],
      ])

      await withTempHome(async () => {
        const { faces, spawns } = fakeFaces()
        const dispatch = toolOf(buildTools(faces), 'dispatch_task')

        // 刚开的批次：没有已回答的问题、没有流程规划、没有风险。
        const batch = blankBatch('闸门验证')
        batch.tickets = [ticket()]
        await save(batch)

        const result = await dispatch.execute({ batchId: batch.id, ticketId: 'T-1' })
        must(result !== undefined && result.ok === false, '设计闸门没过却放行了：' + JSON.stringify(result))
        must(result.code === 'dispatch-blocked', '该用 dispatch-blocked，实际是：' + result.code)
        must(Array.isArray(result.problems) && result.problems.length > 0, '拒绝时得说清差什么，problems 是空的')
        must(spawns.length === 0, '闸门没过却建了子会话')

        const saved = await load(batch.id)
        must(saved.tickets[0].childSessionId === undefined, '拒绝派发却把子会话 id 写进了台账')
        must(saved.tickets[0].status === 'pending', '拒绝派发却把票的状态改掉了：' + saved.tickets[0].status)
      })
    },
  },

  {
    id: 'g-tool-risk-four-fields',
    title: 'design_answer 登记风险缺一栏就拒绝，且台账里风险数没增加',
    covers: ['tools.js#design_answer', 'tools.js#riskGaps', 'core.js#riskGaps'],
    async probe() {
      anchors('tools.js', [
        [/const gaps = riskGaps\(\{/, 'design_answer 里对四栏跑 riskGaps'],
        [/'risk-incomplete'/, "'risk-incomplete' 这个拒绝码"],
        [/if \(gaps\.length > 0\)/, '缺栏必须 return，不能先 push 再报错'],
      ])
      anchors('core.js', [
        [/export function riskGaps/, 'core 里的 riskGaps 本身'],
        [/for \(const \[field, label\] of RISK_FIELDS\)/, '四栏是照 RISK_FIELDS 逐栏查的'],
      ])

      await withTempHome(async () => {
        const { faces } = fakeFaces()
        const answer = toolOf(buildTools(faces), 'design_answer')

        // 四栏各缺一次：每栏都得单独拦住，不能只查其中一栏。
        const full = draftRisk()
        for (const field of ['trigger', 'impact', 'mitigation', 'verification']) {
          const batch = blankBatch('缺 ' + field)
          await save(batch)
          const partial = { ...full }
          delete partial[field]

          const result = await answer.execute({ batchId: batch.id, risk: partial })
          must(result !== undefined && result.ok === false, '缺 ' + field + ' 一栏的风险被登记了')
          must(result.code === 'risk-incomplete', '缺 ' + field + ' 该用 risk-incomplete 拒绝，实际是：' + result.code)

          const saved = await load(batch.id)
          must(
            saved.risks.length === 0,
            '缺 ' + field + ' 时报了错，风险却写进台账了——「报错了但写进去了」比不报错更糟',
          )
        }
      })
    },
  },

  {
    id: 'g-tool-risk-filler',
    title: '四栏写成「无」「n/a」「none」「todo」这类敷衍语，同样拒绝',
    covers: ['core.js#FILLER_WORDS', 'core.js#isFiller', 'core.js#riskGaps'],
    async probe() {
      anchors('core.js', [
        [/const FILLER_WORDS = new Set\(\[/, '敷衍语黑名单 FILLER_WORDS'],
        [/function isFiller\(/, 'isFiller 这个判据'],
        [/isFiller\(trimmed\)/, 'riskGaps 真的调了 isFiller（不是只定义了没用）'],
        [/const MIN_FIELD = 4/, 'MIN_FIELD 长度下限'],
      ])

      await withTempHome(async () => {
        const { faces } = fakeFaces()
        const answer = toolOf(buildTools(faces), 'design_answer')

        // 挑长度够（≥4）但依然没内容的写法：长度检查拦不住它们，
        // 只有黑名单拦得住。这一条专门验黑名单真的接上了。
        for (const filler of ['none', 'todo', 'null', 'unknown', 'n/a']) {
          const batch = blankBatch('敷衍 ' + filler)
          await save(batch)
          const result = await answer.execute({
            batchId: batch.id,
            risk: draftRisk({
              trigger: filler,
              impact: filler,
              mitigation: filler,
              verification: filler,
            }),
          })
          must(result !== undefined && result.ok === false, '四栏全填「' + filler + '」的风险被登记了')
          must(result.code === 'risk-incomplete', '敷衍语该用 risk-incomplete 拒绝，实际是：' + result.code)

          const saved = await load(batch.id)
          must(saved.risks.length === 0, '敷衍语被拒了，风险却写进台账了：' + filler)
        }
      })
    },
  },

  {
    id: 'g-tool-verification-test-missing',
    title: '验证方式写「单测：never-written.test.mjs」而仓库里没有 → 登记处就拒',
    covers: ['tools.js#verificationTestGap', 'core.js#verificationTestGap'],
    async probe() {
      anchors('tools.js', [
        [/const gap = verificationTestGap\(risk, await faces\.testFiles\?\.\(batch\) \?\? \[\]\)/, '登记风险时查承诺的单测在不在'],
        [/'verification-unbacked'/, "'verification-unbacked' 这个拒绝码"],
      ])
      anchors('core.js', [
        [/export function verificationTestGap/, 'core 里的 verificationTestGap 本身'],
        [/const named = verification\.match\(/, '按文件名逐个查'],
      ])

      await withTempHome(async () => {
        const { faces } = fakeFaces()
        const answer = toolOf(buildTools(faces), 'design_answer')

        // 先确认假清单是真清单：仓库里确实没有这条测试，否则探针验的是空气。
        const files = await listTestFiles(REPO_ROOT)
        must(files.length > 0, '仓库里一个测试文件都没扫到——探针的前提不成立')
        must(
          !files.includes('never-written.test.mjs'),
          '仓库里居然真有 never-written.test.mjs，这条探针的前提已变，需要换一个不存在的文件名',
        )

        const batch = blankBatch('假承诺')
        await save(batch)
        const result = await answer.execute({
          batchId: batch.id,
          risk: draftRisk({ verification: '单测：never-written.test.mjs 断言不传 batchId 时抛错' }),
        })

        must(result !== undefined && result.ok === false, '承诺了不存在的单测却登记成功了')
        must(result.code === 'verification-unbacked', '该用 verification-unbacked，实际是：' + result.code)
        must(
          Array.isArray(result.problems) && result.problems.some((p) => p.includes('never-written')),
          '拒绝时得点名是哪个文件不在：' + JSON.stringify(result.problems),
        )

        const saved = await load(batch.id)
        must(saved.risks.length === 0, '假承诺被拒了，风险却写进台账了')
      })
    },
  },

  {
    id: 'g-tool-verification-test-present',
    title: '反面对照：验证方式写「单测：risk-r1.test.mjs」（仓库里真有）→ 接受',
    covers: ['core.js#verificationTestGap', 'verifyscan.js#listTestFiles', 'tools.js#design_answer'],
    async probe() {
      anchors('core.js', [
        [/if \(named\.length > 0\)/, '写了完整文件名要走严格那一路'],
        [/const missing = named\.filter/, '逐个查缺了哪几个'],
      ])
      anchors('verifyscan.js', [
        [/const TEST_SUFFIXES = \[/, '测试文件后缀清单'],
        [/export async function listTestFiles/, 'listTestFiles 本身'],
      ])

      await withTempHome(async () => {
        const { faces } = fakeFaces()
        const answer = toolOf(buildTools(faces), 'design_answer')

        // 闸门的另一半：真有那条测试时必须放行。
        //
        // 没有这一条，探针可能只是「什么都拒」——全拒的闸门也能让上面三条
        // 「拒绝」全绿，但它把正常派发也一起堵死了。
        const files = await listTestFiles(REPO_ROOT)
        must(
          files.includes('risk-r1.test.mjs'),
          '仓库里没有 risk-r1.test.mjs，这条对照探针失去意义（它有就该在）',
        )

        const batch = blankBatch('真承诺')
        await save(batch)
        const result = await answer.execute({
          batchId: batch.id,
          risk: draftRisk({ verification: '单测：risk-r1.test.mjs 断言不传 batchId 时抛错且不建会话' }),
        })

        must(
          result !== undefined && result.ok === true,
          '真有那条测试却拒绝了：' + JSON.stringify(result),
        )
        must(result.risk?.id === 'R-1', '登记成功该回 R-1，实际是：' + JSON.stringify(result.risk))

        const saved = await load(batch.id)
        must(saved.risks.length === 1, '放行了却没把风险写进台账，实际有 ' + saved.risks.length + ' 条')
      })
    },
  },

  {
    id: 'g-tool-verification-unspecified',
    title: '写「单测」却没指名文件 → 拒绝，并提示改写「人工核对：…」',
    covers: ['core.js#verificationTestGap', 'core.js#claimsUnitTest'],
    async probe() {
      anchors('core.js', [
        [/const claimsUnitTest = /, '「单测」这类措辞的识别（不看这个就整段跳过检查）'],
        [/人工核对：/, '拒绝时给出的出路：改写成「人工核对：…」'],
        [/const candidates = rest\.match/, '只写主干名的那一路'],
      ])

      await withTempHome(async () => {
        const { faces } = fakeFaces()
        const answer = toolOf(buildTools(faces), 'design_answer')

        const batch = blankBatch('没点名')
        await save(batch)
        const result = await answer.execute({
          batchId: batch.id,
          // 承诺了单测，但一个文件名都没给——就是那句「写了不等于有」。
          risk: draftRisk({ verification: '单测：不传 batchId 断言抛错且不建会话' }),
        })

        must(result !== undefined && result.ok === false, '没点名文件的单测承诺被登记了')
        must(result.code === 'verification-unbacked', '该用 verification-unbacked，实际是：' + result.code)
        must(
          Array.isArray(result.problems) && result.problems.some((p) => p.includes('人工核对')),
          '拒绝时得告诉人往哪走（改成「人工核对：…」）：' + JSON.stringify(result.problems),
        )

        const saved = await load(batch.id)
        must(saved.risks.length === 0, '没点名的承诺被拒了，风险却写进台账了')
      })
    },
  },

  {
    id: 'g-tool-answered-count-dedupe',
    title: '同一问题答三遍只算 1 个；fact 型不算；空答案不算',
    covers: ['core.js#answeredQuestionCount', 'tools.js#design_question'],
    async probe() {
      anchors('core.js', [
        [/distinct\.add\(entry\.question\)/, '按问题去重（同一个问题问三遍不算三个）'],
        [/entry\?\.kind === 'fact'\)\s*continue/, "fact 型问题直接跳过（事实是模型自己的活）"],
        [/entry\.answer\.trim\(\) === ''\)\s*continue/, '空答案跳过'],
        [/export function answeredQuestionCount/, 'answeredQuestionCount 本身'],
      ])

      await withTempHome(async () => {
        const { faces } = fakeFaces()
        const ask = toolOf(buildTools(faces), 'design_question')

        const batch = blankBatch('去重')
        await save(batch)

        // 同一个问题答三遍：账本里三条，数出来必须还是 1。
        for (let index = 0; index < 3; index++) {
          await ask.execute({ batchId: batch.id, question: '这次的范围到哪为止？', answer: '就到闸门层' })
        }
        const saved = await load(batch.id)
        must(saved.questions.length === 3, '三条问答没记下来，实际 ' + saved.questions.length + ' 条')
        const counted = answeredQuestionCount(saved.questions)
        must(counted === 1, '同一个问题答三遍被算成了 ' + counted + ' 个（该按问题去重算 1 个）')

        const again = await ask.execute({ batchId: batch.id, question: '这次的范围到哪为止？', answer: '就到闸门层' })
        must(again.answered === 1, '工具自报 answered=' + again.answered + '，与去重口径不一致')

        // fact 型不算：事实是模型自己的活，不该拿去问用户。
        must(
          answeredQuestionCount([{ question: 'q', answer: 'a', kind: 'fact' }]) === 0,
          'kind:"fact" 的问题被算成了已回答——于是问事实就能凑够盘问数量',
        )

        // 空答案不算：trim 之后是空，等于没答。
        for (const blank of ['', '   ', '\t']) {
          must(
            answeredQuestionCount([{ question: 'q' + blank.length, answer: blank }]) === 0,
            '空答案（' + JSON.stringify(blank) + '）被算成了已回答',
          )
        }
      })
    },
  },

  {
    id: 'g-tool-design-question-fact',
    title: 'design_question 记 fact 型问题时，工具自报的数字与 core 闸门口径一致（不是 3）',
    covers: ['tools.js#design_question', 'tools.js#answeredQuestionCount', 'core.js#designGateProblems'],
    async probe() {
      anchors('tools.js', [
        [/const answered = answeredQuestionCount\(batch\.questions\)/, '工具回报进度必须调 core 的同一个函数'],
        [/needed: MIN_ANSWERED_QUESTIONS/, '回报里带上闸门用的下限'],
      ])
      anchors('core.js', [
        [/export function designGateProblems/, 'designGateProblems 本身'],
        [/const answered = answeredQuestionCount\(batch\.questions\)/, '闸门也必须调同一个函数'],
      ])

      await withTempHome(async () => {
        const { faces } = fakeFaces()
        const ask = toolOf(buildTools(faces), 'design_question')

        const batch = blankBatch('口径一致')
        await save(batch)

        await ask.execute({ batchId: batch.id, question: '目标是什么？', answer: '把工具层闸门做成可自检的探针' })
        await ask.execute({ batchId: batch.id, question: '范围到哪？', answer: '只加一个探针文件，lib 不动' })
        // 真出过的分歧：工具把 fact 型算成已回答，回报 3，闸门却只数 2，
        // 人以为闸门坏了。这一条就是钉死「两处必须同一个数」。
        const fact = await ask.execute({
          batchId: batch.id,
          question: '仓库里现成的测试文件有哪些？',
          answer: 'test/ 下有十几个 *.test.mjs',
          kind: 'fact',
        })

        const saved = await load(batch.id)
        must(saved.questions.length === 3, '三条问答该都记进账本，实际 ' + saved.questions.length + ' 条')

        const gateCount = answeredQuestionCount(saved.questions)
        must(gateCount === 2, 'core 数出 ' + gateCount + ' 个已回答（fact 不该算，该是 2）')
        must(
          fact.answered === gateCount,
          '工具自报 answered=' + fact.answered + '，闸门口径是 ' + gateCount + '——两处各数一遍必然漂',
        )
        must(fact.ok === true, 'fact 型问题该能记下来（只是不算盘问），实际：' + JSON.stringify(fact))

        // 闸门也这么说，人看到的两处数字才一致。
        const problems = designGateProblems(saved)
        must(
          problems.some((problem) => problem.includes('现在只有 2 个')),
          '设计闸门没按 2 个算：' + JSON.stringify(problems),
        )
        must(
          !problems.some((problem) => problem.includes('现在只有 3 个')),
          '设计闸门把 fact 型问题也算成了已回答',
        )
      })
    },
  },
]
