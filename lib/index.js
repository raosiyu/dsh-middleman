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

/** 服务名：本行需要宿主先备好这些。 */
export const inject = ['tools', 'typertGateway', 'webServer', 'llm', 'systemPrompt', 'agentDefaultModel']

/** 系统提示段的名字，本包自己的命名空间。 */
export const PROMPT_SECTION = 'plugin:middleman'

/** 系统提示段的正文：告诉模型这个面存在、怎么用、以及那条硬规则。 */
export const PROMPT_TEXT = 'dsh-middleman 是本机的中台：主会话在这里盘问、收敛设计，再把设计拆成工单派给独立的子会话。硬规则：派发任何子任务之前必须先有设计批次（design_open），dispatch_task 会拒绝没有 batchId 的调用；风险必须四栏齐全（触发条件 / 影响 / 缓解 / 怎么验证），缺一栏会被拒绝；批准不由模型做，只能由人在中台面板上点。流程是 design_open → design_round（一轮问几个，代码保证带风险探测）→ design_answer（定决定或登记风险）→ design_converge（收敛成规格）→ 等人批准 → design_split（拆工单）→ dispatch_task（建会话并挂起）→ 人在面板上点执行 → 子会话 turn/end 时结果自动推回本会话。中文触发词：中台 / 设计批次 / 派发子任务。'

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

  const dispatcher = createDispatcher({
    gateway,
    peer: () => ({
      id: 'dsh-middleman-owner:' + Math.random().toString(36).slice(2),
      principal: { kind: 'owner' },
      interactions: 'none',
      dispose: () => Promise.resolve(),
    }),
    defaultModel: () => defaultModelFace()?.currentSelection?.(),
    defaultModelSave: async (selection) => { await defaultModelFace()?.saveSelection?.(selection) },
    warn,
    catalog: (...args) => catalog(...args),
  })

  const faces = { dispatcher, warn, catalog, diagnostic }

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