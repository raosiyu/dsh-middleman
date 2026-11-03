/**
 * dsh-middleman 宿主半区。
 *
 * 把四块接起来：工具面（模型调）、路由（面板调）、回传观察器（子会话结束
 * 时推回主会话）、以及一条系统提示段（告诉模型这个面的存在与硬规则）。
 *
 * 所有宿主能力都是「按需解析」而不是在 apply 时抓一次：官方服务的初始化
 * 是异步的，抓早了会永远 undefined。
 *
 * @module dsh-middleman
 */
import { buildTools } from './tools.js'
import { createDispatcher } from './dispatch.js'
import { makeRoutes } from './routes.js'
import { installObserver } from './observer.js'
import { MiddlemanError } from './refusals.js'
import { list } from './ledger.js'
import { listTestFiles } from './verifyscan.js'

/** 服务名：本行需要宿主先备好这些。 */
export const inject = ['tools', 'typertGateway', 'webServer', 'llm', 'systemPrompt', 'agentDefaultModel']

/** 系统提示段的名字，本包自己的命名空间。 */
export const PROMPT_SECTION = 'plugin:middleman'

/**
 * 系统提示段的正文：告诉模型这个面存在、怎么用、以及那几条硬规则。
 *
 * 这一段是「增强型训练」的地方：把 ask-matt 那套流程的骨架写进去——先盘问
 * 再动手、事实自己查、决定问用户、每轮带风险探测——并且把闸门的存在写明，
 * 让模型知道哪些动作会被拒，而不是撞了墙才学。
 */
export const PROMPT_TEXT = [
  'dsh-middleman 是本机的中台：主会话在这里盘问、收敛设计，再把设计拆成工单派给独立的子会话。',
  '',
  '## 流程',
  '',
  '1. design_open — 开一个设计批次。没有批次就没有派发。',
  '2. design_round — 取下一轮要问的问题。前沿是「前置条件都已满足、现在就能问」的决定；代码保证只要还没登记风险，这一轮一定带一个风险探测问。',
  '3. design_question — 把问过用户的问题和答案记进账本。至少要记够 3 个。',
  '4. design_answer — 定一个决定，或登记一条风险（risk 四栏：trigger / impact / mitigation / verification，缺一栏拒绝）。',
  '5. design_plan — 写下流程规划：分几步、每步产出什么、什么能并行。',
  '6. design_converge — 收敛成规格（目标 / 不做什么 / 验收标准）。',
  '7. 等人批准 — 批准只在面板上，模型没有对应的工具。',
  '8. design_split — 拆工单：每张票挂风险、写 modelReason、定模型、声明阻塞边。',
  '9. dispatch_task — 建会话、定模型、挂起，不发第一条消息。',
  '10. 人在中台面板点「执行」→ 子会话开跑 → turn/end 时结果自动推回本会话。',
  '',
  '## 硬规则（写在代码里，撞了会被拒）',
  '',
  '- dispatch_task 必须带 batchId。没有设计批次的派发一律拒绝——这条是为了防止你把本工具当成普通 subagent 用。',
  '- 派发前必须有：至少 3 个已回答的问题、一份流程规划、至少一条四栏齐全的风险。',
  '- 风险四栏缺一栏就拒绝。「无」「n/a」不算，因为不写「怎么验证」的风险只是担心，不是风险。',
  '- 验证方式里写了「单测」，就得指出是哪个测试文件（如 risk-r1.test.mjs），而且那条测试得真的存在——登记时查一次，派发时再查一次。写不出文件名就写「人工核对：…」，那是允许的。',
  '- 批准不由模型做，只能由人在中台面板上点。',
  '- 每张工单必须挂风险（或写 riskFree 加理由）、必须写 modelReason、必须定模型。阻塞边不能成环。',
  '',
  '## 怎么盘问',
  '',
  '- 事实是你的活，不是用户的活。能自己查的（读代码、跑命令、看文档）就去查，别拿去问用户。',
  '- 决定是用户的活。选 A 还是 B、要不要做、范围到哪，这些要问，而且要给推荐答案和理由。',
  '- 每轮问 2 到 4 个，一轮只推进一层。问完等用户回答，再问下一层。',
  '- 每轮至少带一个风险探测：「什么情况下这个方案会失败」。',
  '- 用户的答案原话记进 design_question，不要替他润色成结论。',
  '',
  '中文触发词：中台 / 设计批次 / 派发子任务 / 盘问 / 流程规划。',
].join('\n')

/** 读一个可选服务。 */
function readService(ctx, name, required = false) {
  const holder = ctx
  const direct = holder?.[name]
  if (direct !== undefined) return direct
  if (typeof holder?.get === 'function') {
    try {
      const viaGet = holder.get(name)
      if (viaGet !== undefined) return viaGet
    } catch {
      // 服务没备好
    }
  }
  if (required) throw new MiddlemanError('service-missing', '缺少宿主服务：' + name)
  return undefined
}

/** 读配置字段。 */
function readField(value, fallback) {
  return value === undefined || value === null ? fallback : value
}

/**
 * 激活宿主半区。
 * @param ctx - 插件上下文。
 * @param config - 行配置。
 */
export function apply(ctx, config) {
  const enabled = readField(config?.enabled, true) !== false
  if (!enabled) return

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(message)
    } catch {
      // 没有 logger 就算了
    }
  }

  /**
   * 装一个副作用，并把它挂到插件的 fiber 上。
   *
   * cordis 的 ctx.effect 会立即执行回调并登记卸载；一个精简的部署可能没有
   * 这个能力，那就直接执行一次——宁可少一次自动卸载，也不要静默不注册。
   */
  const effect = (fn, label) => {
    if (typeof ctx.effect === 'function') {
      try {
        return ctx.effect(fn, label)
      } catch (error) {
        warn('[dsh-middleman] effect 挂载失败，改为直接执行：' + String(error))
      }
    }
    try {
      return fn()
    } catch (error) {
      warn('[dsh-middleman] 直接执行也失败：' + String(error))
      return undefined
    }
  }

  /** 网关按需解析：它可能在本行 apply 之后才就绪。 */
  const gateway = () => {
    const face = readService(ctx, 'typertGateway')
    return face !== undefined && typeof face.invoke === 'function' ? face : undefined
  }

  /** 全局默认模型：读它，是为了 selectModel 之后恢复。 */
  const defaultModelFace = () => readService(ctx, 'agentDefaultModel')

  /**
   * 直接读 LLM 服务造模型目录。
   *
   * 不走网关的 session/modelCatalog：那条路径在这个 DSH 版本上会抛
   * "Cannot read properties of undefined (reading 'aborted')"，而面板要的
   * 数据就在 ctx.llm 里，多绕一层只会多一个失败点。
   * @returns 与网关同形的目录；没有 llm 服务时 undefined。
   */
  const catalog = async () => {
    const llm = readService(ctx, 'llm')
    if (llm === undefined || typeof llm.listProviders !== 'function') return undefined
    const groups = []
    for (const provider of llm.listProviders()) {
      try {
        const models = await llm.listModels(provider.id)
        groups.push({
          id: provider.id,
          name: provider.name,
          models: models.map((model) => ({ id: model.id, name: model.name })),
        })
      } catch (error) {
        warn('[dsh-middleman] 读 ' + provider.id + ' 的模型失败：' + String(error))
      }
    }
    const current = defaultModelFace()?.currentSelection?.()
    return {
      groups,
      ...(current === undefined ? {} : { default: { provider: current.provider, model: current.model } }),
    }
  }

  /** 面板排障用：说清楚这个部署里有哪些面是可用的。 */
  const diagnostic = () => ({
    llm: typeof readService(ctx, 'llm')?.listProviders,
    tools: typeof readService(ctx, 'tools')?.register,
    webServer: typeof readService(ctx, 'webServer')?.register,
    systemPrompt: typeof readService(ctx, 'systemPrompt')?.section,
    gateway: typeof gateway()?.invoke,
    defaultModel: typeof defaultModelFace()?.currentSelection,
  })

  /**
   * session/follow 是流式端点，走 gateway.stream 而不是 invoke。
   *
   * 它必须在 createDispatcher 之前定义：dispatcher 的 tail 要用它读子会话
   * 历史，缺了它就退回到 page，而 page 的游标猜错会直接抛
   * "session page through seq ... is past cursor"。
   */
  const stream = async (namespace, method, request) => {
    const face = readService(ctx, 'typertGateway')
    if (face === undefined || typeof face.stream !== 'function') return undefined
    return await face.stream({
      namespace,
      method,
      args: { request },
      peer: {
        id: 'dsh-middleman-owner:' + Math.random().toString(36).slice(2),
        principal: { kind: 'owner' },
        signal: new AbortController().signal,
        interactions: 'none',
        dispose: () => Promise.resolve(),
      },
    })
  }

  const dispatcher = createDispatcher({
    gateway,
    // peer.signal 是必需的：网关每次调用都先读 peer.signal.aborted 判断
    // 调用方是否已释放，缺了它会在 session.create 上抛
    // "Cannot read properties of undefined (reading 'aborted')"。
    peer: () => ({
      id: 'dsh-middleman-owner:' + Math.random().toString(36).slice(2),
      principal: { kind: 'owner' },
      signal: new AbortController().signal,
      interactions: 'none',
      dispose: () => Promise.resolve(),
    }),
    defaultModel: () => defaultModelFace()?.currentSelection?.(),
    defaultModelSave: async (selection) => { await defaultModelFace()?.saveSelection?.(selection) },
    warn,
    catalog: (...args) => catalog(...args),
    stream: (...args) => stream(...args),
  })

  const faces = {
    dispatcher,
    // 批次所在项目里有哪些测试文件：风险的「怎么验证」承诺了单测，
    // 就得真有那条测试。批次记着自己的 cwd，所以按批次扫。
    testFiles: async (batch) => await listTestFiles(batch?.cwd ?? ''),
    gatewayFace: gateway,
    rawPage: async (sessionId) => {
      const face = readService(ctx, 'typertGateway')
      if (face === undefined) return undefined
      return await face.invoke({
        namespace: 'session',
        method: 'page',
        args: { request: { address: { kind: 'session', sessionId }, throughSeq: 999999, maxMessages: 60 } },
        peer: {
          id: 'dsh-middleman-owner:' + Math.random().toString(36).slice(2),
          principal: { kind: 'owner' },
          signal: new AbortController().signal,
          interactions: 'none',
          dispose: () => Promise.resolve(),
        },
      })
    },
    warn,
    catalog,
    diagnostic,
    // session/follow 是流式端点，走 gateway.stream 而不是 invoke。
    stream,
  }

  // 工具面。
  const tools = readService(ctx, 'tools')
  if (tools !== undefined && typeof tools.register === 'function') {
    for (const definition of buildTools(faces)) {
      try {
        tools.register({
          name: definition.name,
          description: definition.description,
          parameters: definition.parameters,
          output: definition.output,
          timeoutMs: 120_000,
          execute: definition.execute,
        })
      } catch (error) {
        warn('[dsh-middleman] 工具没注册上：' + definition.name + ' — ' + String(error))
      }
    }
  } else {
    warn('[dsh-middleman] 这个部署没有工具注册表，工具面缺席')
  }

  // HTTP 面。
  const web = readService(ctx, 'webServer')
  if (web !== undefined && typeof web.register === 'function') {
    for (const route of makeRoutes(faces)) {
      effect(() => web.register(route), 'dsh-middleman: ' + route.path)
    }
  } else {
    warn('[dsh-middleman] 这个部署没有 webServer，面板端点缺席')
  }

  // 回传观察器。
  effect(() => installObserver(ctx, faces), 'dsh-middleman: 回传观察器')

  // 系统提示段：只在开启时注入。
  if (readField(config?.announceToAgent, true) !== false) {
    try {
      const systemPrompt = readService(ctx, 'systemPrompt')
      if (systemPrompt !== undefined && typeof systemPrompt.section === 'function') {
        effect(() => systemPrompt.section({ name: PROMPT_SECTION, order: 40, text: () => PROMPT_TEXT }), 'dsh-middleman: 提示段')
      }
    } catch (error) {
      warn('[dsh-middleman] 提示段没注册上：' + String(error))
    }
  }
}

export { buildTools } from './tools.js'
export { createDispatcher } from './dispatch.js'
export { makeRoutes } from './routes.js'
export { installObserver } from './observer.js'
export * from './core.js'
export { load, save, list, blankBatch, newBatchId } from './ledger.js'
export { MiddlemanError, isMiddlemanError } from './refusals.js'