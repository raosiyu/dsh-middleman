/**
 * 模型可调用的工具面。
 *
 * 七个工具，分三段：盘问（design_open / design_round / design_answer）、
 * 收敛与闸门（design_converge / design_split）、派发（dispatch_task 等）。
 *
 * 一条硬规则：**approve 不在这个面上**。批准只能由人在面板上点，模型
 * 没有对应的工具可调。这就是「模型不能批准自己的设计」这句话的实现。
 *
 * @module dsh-middleman/tools
 */
import {
  frontier, blocked, openCount, nextRound, riskGaps,
  convergeProblems, dispatchProblems, readyTickets, RISK_FIELDS,
  designGateProblems, MIN_ANSWERED_QUESTIONS, verificationTestGap, answeredQuestionCount,
} from './core.js'
import { blankBatch, load, save, list } from './ledger.js'
import { MiddlemanError } from './refusals.js'

/** 工具的 JSON Schema 片段：一个必填字符串。 */
const str = (description) => ({ type: 'string', description })

/** 输出统一是一个 JSON 字符串，面板与模型读同一份。 */
const jsonOut = (schema) => ({ schema, render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] })

/** 把一串拒绝包成一个可读的 ok:false。 */
function refusal(code, problems) {
  return { ok: false, code, problems }
}

/**
 * 安全地取一个字符串。
 *
 * 为什么不能直接 String(x)：String(undefined) 是字符串 "undefined"，
 * 非空，于是它能骗过下游所有 trim() !== '' 的检查。
 *
 * 真出过：design_question 不给 answer 时写成 answer: "undefined"，
 * 设计闸门数它当「已回答」——于是「至少 3 个已回答的问题」这道闸门
 * 一道就能绕过。同理 plan.steps / plan.output。
 *
 * 所以这里只接受真正的字符串；不是字符串就当没给。
 *
 * @param value - 候选值。
 * @param fallback - 不是字符串时的替代值。
 * @returns 字符串。
 */
function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

/**
 * 取一个非空字符串；空的话返回 undefined。
 * @param value - 候选值。
 * @returns 字符串或 undefined。
 */
function requiredText(value) {
  if (typeof value !== 'string') return undefined
  return value.trim() === '' ? undefined : value
}

/**
 * 建工具面。
 * @param faces - 宿主能力与台账。
 * @returns 工具定义数组。
 */
export function buildTools(faces) {
  /** 取一个批次，找不到就抛可读拒绝。 */
  const need = async (id) => {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new MiddlemanError('invalid-request', '必须带 batchId')
    }
    return await load(id)
  }

  /**
   * 给每个工具套一层参数兜底。
   *
   * 为什么需要：插件用裸 tools.register() 注册，宿主**不按 JSON Schema
   * 校验参数**——模型传 null / undefined / 少传字段都是可能的。除了
   * 各个工具内部已经做的字段校验，还得先保证 args 本身是个对象，
   * 否则第一行 `args.batchId` 就抛 TypeError。
   *
   * 套在一处而不是九个工具各写一遍：写九遍必然漏一两处。
   */
  const guarded = (definitions) => definitions.map((definition) => ({
    ...definition,
    async execute(args, exec) {
      const safe = args === null || typeof args !== 'object' || Array.isArray(args) ? {} : args
      return await definition.execute(safe, exec)
    },
  }))

  return guarded([
    {
      name: 'design_open',
      description: '开一个设计批次：盘问阶段的容器。派发任何子任务之前必须先有批次，dispatch_task 会拒绝没有 batchId 的调用。中文触发词：设计批次 / 开个设计。',
      parameters: {
        type: 'object',
        properties: {
          title: str('这次要做的事，一句话'),
          decisions: {
            type: 'array',
            description: '初始设计树。每项是 {id, title, body, dependsOn, kind}；kind 取 goal/scope/design/risk/verify。省略时由插件给一棵默认树。',
            items: { type: 'object' },
          },
        },
        required: ['title'],
        additionalProperties: false,
      },
      output: jsonOut({ type: 'object' }),
      async execute(args, exec) {
        const batch = blankBatch(args.title)
        // 记下开批次的那个会话：子会话结束时，回传要推给它；
        // 同时记下它所在的工作目录与工作区，派发时子会话要落在同一个地方，
        // 否则会掉进 profile 目录（应用自己的目录），跟你的项目完全无关。
        const parent = exec?.agent?.session?.id ?? exec?.agent?.id
        if (typeof parent === 'string' && parent !== '') batch.parentSessionId = parent
        const cwd = exec?.agent?.session?.header?.cwd
          ?? exec?.agent?.session?.cwd
          ?? exec?.agent?.cwd
          ?? exec?.cwd
        if (typeof cwd === 'string' && cwd !== '') batch.cwd = cwd
        const workspaceId = exec?.agent?.session?.header?.workspaceId
        if (typeof workspaceId === 'string' && workspaceId !== '') batch.workspaceId = workspaceId
        const seeded = Array.isArray(args.decisions) && args.decisions.length > 0
          ? args.decisions.map((decision, index) => ({
            id: typeof decision?.id === 'string' && decision.id !== '' ? decision.id : 'D' + (index + 1),
            kind: typeof decision?.kind === 'string' ? decision.kind : 'design',
            title: text(decision?.title, '未命名决定'),
            body: text(decision?.body),
            dependsOn: Array.isArray(decision?.dependsOn) ? decision.dependsOn : [],
          }))
          : defaultTree()
        batch.decisions = seeded
        await save(batch)
        return {
          ok: true,
          batchId: batch.id,
          status: batch.status,
          open: openCount(batch),
          frontier: frontier(batch).map((d) => d.id),
          blocked: blocked(batch).map((d) => d.id),
          next: nextRound(batch),
        }
      },
    },

    {
      name: 'design_round',
      description: '取下一轮要问的问题。前沿是「前置条件都已满足、现在就能问」的决定。代码保证：只要一条风险都还没登记，这一轮一定带一个风险探测问。',
      parameters: {
        type: 'object',
        properties: {
          batchId: str('批次 id'),
          size: { type: 'number', description: '一轮最多几问，默认 4' },
        },
        required: ['batchId'],
        additionalProperties: false,
      },
      output: jsonOut({ type: 'object' }),
      async execute(args) {
        const batch = await need(args.batchId)
        const round = nextRound(batch, typeof args.size === 'number' ? args.size : 4)
        return { ok: true, ...round, risks: batch.risks.length, open: openCount(batch) }
      },
    },

    {
      name: 'design_answer',
      description: '把一个决定定下来，或登记一条风险。定决定用 decisionId + answer；登记风险必须四栏齐全（trigger/impact/mitigation/verification），缺一栏就拒绝——风险不是聊完就忘的段落。验证方式里如果写了「单测」，必须指出是哪个测试文件（如 risk-r1.test.mjs）且那条测试真的存在，否则登记与派发都会被拒；做不了自动化验证就写「人工核对：…」。',
      parameters: {
        type: 'object',
        properties: {
          batchId: str('批次 id'),
          decisionId: str('决定 id，例如 D3'),
          answer: str('这个决定的答案'),
          deferred: { type: 'boolean', description: '明确推迟这个决定' },
          risk: {
            type: 'object',
            description: '要登记的风险：{title, trigger, impact, mitigation, verification}',
          },
        },
        required: ['batchId'],
        additionalProperties: false,
      },
      output: jsonOut({ type: 'object' }),
      async execute(args) {
        const batch = await need(args.batchId)

        // 同时给 risk 与 decisionId 会让 risk 分支提前返回，那个决定就被
        // 静默丢掉了——调用方以为两个都办了，其实只有风险登记了。
        if (args.risk !== undefined && args.decisionId !== undefined) {
          return refusal('invalid-request', [
            'risk 与 decisionId 只能给一个：两个都给了的话，决定会被静默丢掉',
          ])
        }

        if (args.risk !== undefined) {
          const draft = args.risk
          if (draft === null || typeof draft !== 'object') {
            return refusal('invalid-request', ['risk 得是一个对象'])
          }
          const gaps = riskGaps({
            trigger: draft.trigger,
            impact: draft.impact,
            mitigation: draft.mitigation,
            verification: draft.verification,
          })
          if (gaps.length > 0) {
            return refusal('risk-incomplete', ['风险缺：' + gaps.join('、') + '。四栏是 ' + RISK_FIELDS.map(([, label]) => label).join(' / ')])
          }
          const risk = {
            id: 'R-' + (batch.risks.length + 1),
            title: text(draft.title, '未命名风险'),
            trigger: text(draft.trigger),
            impact: text(draft.impact),
            mitigation: text(draft.mitigation),
            verification: text(draft.verification),
            createdAt: Date.now(),
          }
          // 验证方式承诺了单测，就得真有那条测试：写了不等于有。
          const gap = verificationTestGap(risk, await faces.testFiles?.(batch) ?? [])
          if (gap !== '') return refusal('verification-unbacked', [gap])
          batch.risks.push(risk)
          await save(batch)
          return { ok: true, risk, risks: batch.risks.length }
        }

        if (typeof args.decisionId !== 'string' || args.decisionId === '') {
          return refusal('invalid-request', ['要么带 decisionId 定一个决定，要么带 risk 登记一条风险'])
        }
        const decision = batch.decisions.find((candidate) => candidate.id === args.decisionId)
        if (decision === undefined) {
          return refusal('invalid-request', ['没有这个决定：' + args.decisionId])
        }
        if (args.deferred === true) {
          decision.deferred = args.answer ?? '(推迟)'
        } else {
          if (typeof args.answer !== 'string' || args.answer.trim() === '') {
            return refusal('invalid-request', ['answer 不能为空；要推迟就传 deferred: true'])
          }
          decision.answer = args.answer.trim()
        }
        decision.decidedAt = Date.now()
        await save(batch)
        return {
          ok: true,
          decided: decision.id,
          open: openCount(batch),
          frontier: frontier(batch).map((d) => d.id),
        }
      },
    },

    {
      name: 'design_question',
      description: '记一个问过用户的问题和他的答案。这条是盘问的账本：派发之前至少要有 3 个已回答的问题，否则 dispatch_task 会拒绝。问的时候把「你为什么这么选」「什么情况下这个会失败」这类问题问出来，别自己替用户回答。中文触发词：盘问 / 提问。',
      parameters: {
        type: 'object',
        properties: {
          batchId: str('批次 id'),
          question: str('问用户的问题，原话'),
          answer: str('用户的答案，原话'),
          kind: {
            type: 'string',
            description: '这个问题的性质：goal 目标 / scope 范围 / design 设计 / risk 风险 / verify 验收 / fact 需要自己查的事实',
            enum: ['goal', 'scope', 'design', 'risk', 'verify', 'fact'],
          },
          recommendation: str('你给的推荐答案，以及理由'),
        },
        required: ['batchId', 'question', 'answer'],
        additionalProperties: false,
      },
      output: jsonOut({ type: 'object' }),
      async execute(args) {
        const batch = await need(args.batchId)
        // 问题与答案都必须真的给了。
        //
        // 不能靠 String(args.answer) —— 那会把「没给」变成字符串
        // "undefined"，非空，于是这道闸门形同虚设。
        const question = requiredText(args.question)
        const answer = requiredText(args.answer)
        if (question === undefined || answer === undefined) {
          return refusal('invalid-request', [
            'question 与 answer 都得给：没给的记下来不算数——盘问的账本记的是「问过什么、用户答了什么」',
          ])
        }
        const entry = {
          id: 'Q' + (batch.questions.length + 1),
          question,
          answer,
          kind: typeof args.kind === 'string' ? args.kind : 'design',
          ...(args.recommendation === undefined ? {} : { recommendation: text(args.recommendation) }),
          at: Date.now(),
        }
        batch.questions.push(entry)
        await save(batch)
        // 口径跟闸门共用同一个函数——两处各数一遍必然漂。
        const answered = answeredQuestionCount(batch.questions)
        return {
          ok: true,
          question: entry.id,
          answered,
          needed: MIN_ANSWERED_QUESTIONS,
          note: answered < MIN_ANSWERED_QUESTIONS
            ? '还要再问 ' + (MIN_ANSWERED_QUESTIONS - answered) + ' 个问题才能派发'
            + (entry.kind === 'fact' ? '（事实型的问题不算盘问——事实是你自己的活）' : '')
            : '盘问够了，接下来写流程规划',
        }
      },
    },

    {
      name: 'design_plan',
      description: '写下这次要做的事的流程规划：分几步、每步产出什么、什么能并行、卡点在哪。派发之前必须写——没规划就派发，等于把「怎么做」丢给了子会话自己猜。中文触发词：流程规划 / 怎么分工。',
      parameters: {
        type: 'object',
        properties: {
          batchId: str('批次 id'),
          steps: str('分几步，每步一行，写清楚每步做什么'),
          output: str('做完之后留下什么：文件、报告、还是一次可运行的东西'),
          parallel: str('哪几步可以同时做，为什么'),
          blockers: { type: 'array', description: '已知会卡住的地方', items: { type: 'string' } },
        },
        required: ['batchId', 'steps', 'output'],
        additionalProperties: false,
      },
      output: jsonOut({ type: 'object' }),
      async execute(args) {
        const batch = await need(args.batchId)
        // steps 与 output 都得真的给了——String(undefined) 是 "undefined"，
        // 非空，能骗过「流程规划缺 steps」这道检查。
        const steps = requiredText(args.steps)
        const output = requiredText(args.output)
        if (steps === undefined || output === undefined) {
          return refusal('invalid-request', [
            'steps 与 output 都得给：没写的规划等于没规划——派发时子会话会自己猜「怎么做」',
          ])
        }
        batch.plan = {
          steps,
          output,
          ...(args.parallel === undefined ? {} : { parallel: text(args.parallel) }),
          ...(Array.isArray(args.blockers) ? { blockers: args.blockers.map((b) => text(b)) } : {}),
          at: Date.now(),
        }
        await save(batch)
        return { ok: true, plan: batch.plan, gate: designGateProblems(batch) }
      },
    },

    {
      name: 'design_converge',
      description: '把批次收敛成一份规格。会检查：前沿清空、规格有目标与验收标准、风险四栏齐全、依赖边合法。任何一条不过就返回 problems，不落状态。',
      parameters: {
        type: 'object',
        properties: {
          batchId: str('批次 id'),
          goal: str('一句话目标'),
          nonGoals: { type: 'array', description: '明确不做什么', items: { type: 'string' } },
          acceptance: { type: 'array', description: '验收标准，每条要能跑出红绿', items: { type: 'string' } },
        },
        required: ['batchId', 'goal', 'acceptance'],
        additionalProperties: false,
      },
      output: jsonOut({ type: 'object' }),
      async execute(args) {
        const batch = await need(args.batchId)
        const goal = requiredText(args.goal)
        if (goal === undefined) {
          return refusal('invalid-request', ['goal 得给一句话目标'])
        }
        batch.spec = {
          goal,
          nonGoals: Array.isArray(args.nonGoals) ? args.nonGoals.map((v) => text(v)) : [],
          acceptance: Array.isArray(args.acceptance) ? args.acceptance.map((v) => text(v)) : [],
        }
        const problems = convergeProblems(batch)
        if (problems.length > 0) {
          await save(batch)
          return refusal('converge-blocked', problems)
        }
        batch.status = 'converged'
        batch.convergedAt = Date.now()
        await save(batch)
        return {
          ok: true,
          status: batch.status,
          note: '已收敛。批准只能由人在中台面板上点，模型没有对应的工具。',
        }
      },
    },

    {
      name: 'design_split',
      description: '把收敛后的设计拆成工单。每张票必须挂至少一条风险（或写 riskFree 加理由）、必须写 modelReason（为什么选这个模型）、必须写 model。阻塞边不能成环。',
      parameters: {
        type: 'object',
        properties: {
          batchId: str('批次 id'),
          tickets: {
            type: 'array',
            description: '工单数组，每项 {id, title, brief, blockedBy, riskIds, riskFree, riskFreeReason, model:{provider,model,reasoningEffort}, modelReason, source, payload, effort, notes:{before,order,parallel}}。推理强度只认 model.reasoningEffort——派发时钉模型传的就是它；effort 只是冗余，只在 model 里没写时才用。notes 是给人看的执行提示：before=开始前要做什么，order=顺序，parallel=可以和谁同时做。',
            items: { type: 'object' },
          },
        },
        required: ['batchId', 'tickets'],
        additionalProperties: false,
      },
      output: jsonOut({ type: 'object' }),
      async execute(args) {
        const batch = await need(args.batchId)
        if (!Array.isArray(args.tickets)) {
          return refusal('invalid-request', ['tickets 必须是数组'])
        }
        if (args.tickets.some((ticket) => ticket === null || typeof ticket !== 'object')) {
          return refusal('invalid-request', ['每张票都得是一个对象，不能有 null'])
        }
        // 已经派出去的票要保住。
        //
        // 为什么：原来的写法整份替换 tickets，并把每张票重置成 pending——
        // 于是 childSessionId、dispatchedAt、reportedTurn、result、feedback
        // 全被抹掉。那张票的子会话还在跑，却从账本上消失了：再派一次就是
        // 第二个子会话，第一个成了孤儿，还在计费。
        //
        // 所以：派过的票不许被重新拆。模型要改工单，就改还没派的那几张。
        const previous = new Map((batch.tickets ?? []).map((ticket) => [ticket.id, ticket]))
        const dispatched = (batch.tickets ?? []).filter((ticket) => typeof ticket.childSessionId === 'string')
        const incomingIds = new Set(args.tickets.map((ticket, index) => (
          typeof ticket.id === 'string' && ticket.id !== '' ? ticket.id : 'T-' + (index + 1)
        )))
        const clobbered = dispatched.filter((ticket) => incomingIds.has(ticket.id))
        if (clobbered.length > 0) {
          return refusal('split-blocked', [
            '这些票已经派出去了，不能重新拆：' + clobbered.map((t) => t.id).join('、')
            + '（它们的子会话还在跑，重新拆会抹掉子会话、留下一个还在计费的孤儿）',
          ])
        }

        batch.tickets = args.tickets.map((ticket, index) => {
          // 推理强度只有一个真相来源：model.reasoningEffort。
          // 派发时钉模型传的就是它（lib/dispatch.js 的 session.selectModel）。
          // 工单里另一个同名字段 effort 只是给人看的冗余，写进来就以
          // model.reasoningEffort 为准——否则两者会各写各的，卡片显示的
          // 强度和子会话真正跑的不是一回事。
          const model = ticket.model === undefined || ticket.model === null
            ? undefined
            : {
              ...ticket.model,
              ...(typeof ticket.model.reasoningEffort === 'string'
                ? {}
                : (typeof ticket.effort === 'string' && ticket.effort !== ''
                  ? { reasoningEffort: ticket.effort }
                  : {})),
            }
          const effort = typeof model?.reasoningEffort === 'string'
            ? model.reasoningEffort
            : (typeof ticket.effort === 'string' ? ticket.effort : undefined)
          const id = typeof ticket.id === 'string' && ticket.id !== '' ? ticket.id : 'T-' + (index + 1)

          // 重新拆一张**没派过**的票时，保留它已有的东西——
          // 比如人提过的修改意见、上一轮的结算记录。
          const old = previous.get(id)

          return {
            id,
            title: text(ticket.title, '未命名工单'),
            brief: text(ticket.brief),
            blockedBy: Array.isArray(ticket.blockedBy) ? ticket.blockedBy : [],
            riskIds: Array.isArray(ticket.riskIds) ? ticket.riskIds : [],
            riskFree: ticket.riskFree === true,
            riskFreeReason: typeof ticket.riskFreeReason === 'string' ? ticket.riskFreeReason : undefined,
            model,
            modelReason: typeof ticket.modelReason === 'string' ? ticket.modelReason : '',
            // 卡片要给人看的东西：工单文件、要发送的内容、推理强度、执行提示。
            source: typeof ticket.source === 'string' ? ticket.source : undefined,
            payload: typeof ticket.payload === 'string' ? ticket.payload : undefined,
            effort,
            notes: ticket.notes !== undefined && typeof ticket.notes === 'object' && ticket.notes !== null ? {
              before: typeof ticket.notes.before === 'string' ? ticket.notes.before : undefined,
              order: typeof ticket.notes.order === 'string' ? ticket.notes.order : undefined,
              parallel: typeof ticket.notes.parallel === 'string' ? ticket.notes.parallel : undefined,
            } : undefined,
            ...(old?.feedback === undefined ? {} : { feedback: old.feedback }),
            ...(old?.result === undefined ? {} : { result: old.result }),
            ...(old?.reportedTurn === undefined ? {} : { reportedTurn: old.reportedTurn }),
            status: old?.status === 'done' || old?.status === 'failed' || old?.status === 'partial'
              ? old.status
              : 'pending',
          }
        })
        const problems = dispatchProblems(batch)
        await save(batch)
        if (problems.length > 0) return refusal('split-blocked', problems)
        return {
          ok: true,
          tickets: batch.tickets.map((t) => ({ id: t.id, title: t.title, blockedBy: t.blockedBy })),
          ready: readyTickets(batch).map((t) => t.id),
        }
      },
    },

    {
      name: 'dispatch_task',
      description: '把一张已批准、已就绪的工单派成一个独立子会话并挂起。必须带 batchId：没有批次的派发一律拒绝，这条规则就是为了防止主会话把本工具当成普通 subagent 用。派发前还必须走完盘问与规划：至少 3 个已回答的问题、一份流程规划、至少一条四栏齐全的风险，否则同样拒绝。子会话建好、模型定好，但不发第一条消息——要等人点执行。',
      parameters: {
        type: 'object',
        properties: {
          batchId: str('批次 id。必填，没有它一律拒绝'),
          ticketId: str('工单 id，例如 T-1'),
          workspaceId: str('可选的 workspace id'),
          agentPreset: str('可选的 agent preset id'),
        },
        required: ['batchId', 'ticketId'],
        additionalProperties: false,
      },
      output: jsonOut({ type: 'object' }),
      async execute(args) {
        // R-1：这一条就是那条风险的缓解措施，写在代码里。
        if (typeof args.batchId !== 'string' || args.batchId.trim() === '') {
          throw new MiddlemanError('batch-required', 'dispatch_task 必须带 batchId：没有设计批次的派发一律拒绝')
        }
        const batch = await need(args.batchId)
        // 派发是最后一道关口：这里再查一遍「承诺的单测在不在」——
        // 登记风险时放过、后来一直没写的那条，在这里拦住。
        const problems = dispatchProblems(batch, await faces.testFiles?.(batch) ?? [])
        if (problems.length > 0) return refusal('dispatch-blocked', problems)

        const ticket = batch.tickets.find((candidate) => candidate.id === args.ticketId)
        if (ticket === undefined) return refusal('ticket-missing', ['没有这张工单：' + args.ticketId])
        if (!readyTickets(batch).includes(ticket)) {
          return refusal('ticket-not-ready', [ticket.id + ' 还没就绪：前置工单未完成，或它已经在跑'])
        }

        // 位置：显式参数 > 批次记下的工作区 > 批次记下的 cwd。
        // session.create 接受 workspaceId 或 cwd，不能两个都给。
        const workspaceId = args.workspaceId ?? batch.workspaceId
        const cwd = workspaceId === undefined ? batch.cwd : undefined
        const spawned = await faces.dispatcher.spawn(ticket, {
          ...(workspaceId === undefined ? {} : { workspaceId }),
          ...(cwd === undefined ? {} : { cwd }),
          ...(args.agentPreset === undefined ? {} : { agentPreset: args.agentPreset }),
        })
        ticket.childSessionId = spawned.sessionId
        ticket.model = spawned.model
        ticket.status = 'suspended'
        ticket.dispatchedAt = Date.now()
        await save(batch)
        return {
          ok: true,
          ticketId: ticket.id,
          sessionId: spawned.sessionId,
          status: 'suspended',
          note: '子会话已建好并挂起。在中台面板上点「执行」才真正开始；点之前它不会花任何额度。',
        }
      },
    },

    {
      name: 'middleman_status',
      description: '读一个批次的当前状态：前沿、风险、工单与每张票的子会话。不传 batchId 时列出全部批次。',
      parameters: {
        type: 'object',
        properties: { batchId: str('批次 id；省略则列出全部') },
        additionalProperties: false,
      },
      output: jsonOut({ type: 'object' }),
      async execute(args) {
        if (typeof args.batchId !== 'string' || args.batchId === '') {
          const rows = await list()
          return {
            ok: true,
            batches: rows.map((row) => ({
              id: row.id, title: row.title, status: row.status,
              open: openCount(row), tickets: (row.tickets ?? []).length,
            })),
          }
        }
        const batch = await need(args.batchId)
        return {
          ok: true,
          id: batch.id,
          title: batch.title,
          status: batch.status,
          open: openCount(batch),
          frontier: frontier(batch).map((d) => ({ id: d.id, title: d.title })),
          risks: (Array.isArray(batch.risks) ? batch.risks : []).map((risk) => ({ id: risk.id, title: risk.title })),
          tickets: (batch.tickets ?? []).map((ticket) => ({
            id: ticket.id, title: ticket.title, status: ticket.status,
            sessionId: ticket.childSessionId, blockedBy: ticket.blockedBy,
          })),
        }
      },
    },
  ])
}

/** 默认设计树：够盘问一轮起步，模型可以按需要增删。 */
export function defaultTree() {
  return [
    { id: 'D1', kind: 'goal', title: '要解决什么问题', body: '一句话说清这次要做什么，以及不做什么。', dependsOn: [] },
    { id: 'D2', kind: 'scope', title: '范围到哪为止', body: '哪些是这次必须做的，哪些明确留给以后。', dependsOn: ['D1'] },
    { id: 'D3', kind: 'design', title: '数据结构长什么样', body: '核心实体与它们的关系；先只写会变的字段。', dependsOn: ['D1'] },
    { id: 'D4', kind: 'design', title: '接口边界放哪里', body: '调用方需要知道什么，实现藏在哪。', dependsOn: ['D3'] },
    { id: 'D5', kind: 'risk', title: '最可能失败的那条路径', body: '给出具体触发条件，不是「可能有风险」。', dependsOn: ['D2'] },
    { id: 'D6', kind: 'verify', title: '怎么算做完了', body: '可执行的验收标准，能跑出红绿的那种。', dependsOn: ['D2', 'D4'] },
  ]
}
