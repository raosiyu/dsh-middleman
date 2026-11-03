/**
 * 派发：把一张工单变成一个真实的、挂起的子会话。
 *
 * 顺序固定为 create → rename → selectModel → 停手。**不发第一条消息**，
 * 这就是「挂起」的全部含义：会话已经存在、模型已经定好，但要等你点执行
 * 才真正开始干活。
 *
 * selectModel 有个副作用：它内部会顺带把全局默认模型改掉。派五个子任务，
 * 你下次新建会话的默认模型就变成最后一个子任务用的了。所以这里在改之前
 * 记下当前默认，改完立刻恢复。
 *
 * @module dsh-middleman/dispatch
 */
import { MiddlemanError } from './refusals.js'

/** 这一层需要宿主提供的全部能力，窄到只有本模块会调的那几个。 */
export function createDispatcher(faces) {
  /**
   * 对宿主网关发一次调用。
   * @param namespace - 命名空间，本模块只碰 session。
   * @param method - 方法名。
   * @param request - 载荷；无参数的两个端点直接传 {}。
   */
  const call = async (namespace, method, request) => {
    const gateway = faces.gateway?.()
    if (gateway === undefined) {
      throw new MiddlemanError('gateway-unavailable', '这个部署没有可用的宿主网关，无法建会话')
    }
    return await gateway.invoke({
      namespace,
      method,
      args: namespace === 'session' && method === 'modelCatalog' ? {} : { request },
      peer: faces.peer(),
      // 网关内部会读 signal.aborted；不给它一个，modelCatalog 这类无参数端点
      // 会直接抛 "Cannot read properties of undefined (reading 'aborted')"。
      signal: faces.signal ?? AbortSignal.timeout(60_000),
    })
  }

  /**
   * 读全局默认模型，供 selectModel 之后恢复。
   * @returns 当前默认路由，读不到时 undefined。
   */
  const readDefault = () => {
    try {
      const model = faces.defaultModel?.()
      if (model === undefined || typeof model !== 'object') return undefined
      const provider = typeof model.provider === 'string' ? model.provider : undefined
      const id = typeof model.model === 'string' ? model.model : undefined
      if (provider === undefined || id === undefined) return undefined
      return {
        provider,
        model: id,
        ...(typeof model.reasoningEffort === 'string' ? { reasoningEffort: model.reasoningEffort } : {}),
      }
    } catch {
      return undefined
    }
  }

  /**
   * 恢复全局默认模型。恢复失败不算派发失败：子会话已经建好、模型已经定好，
   * 默认模型没恢复只是环境问题，记一行日志比让整次派发回滚更合理。
   * @param previous - 派发前读到的默认路由。
   */
  const restoreDefault = async (previous) => {
    if (previous === undefined) return
    try {
      await faces.defaultModelSave?.(previous)
    } catch (error) {
      faces.warn?.('[dsh-middleman] 默认模型没能恢复：' + String(error))
    }
  }

  return {
    /** 读模型目录，供面板与工具选择。优先用宿主直接给的，退回网关。 */
    async modelCatalog() {
      const direct = await faces.catalog?.()
      if (direct !== undefined) return direct
      return await call('session', 'modelCatalog', {})
    },

    /**
     * 建一个挂起的子会话。
     * @param ticket - 工单，需要 title / brief / model。
     * @param options - workspaceId、preset 等可选项。
     * @returns 新会话 id 与本次实际使用的模型。
     */
    async spawn(ticket, options = {}) {
      let created
      try {
        // session.create 接受 workspaceId 或 cwd（二选一，两个都给会被拒）。
        // 不给位置的话，会话会落在 profile 目录里，跟用户的项目无关。
        created = await call('session', 'create', {
          ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
        })
      } catch (error) {
        throw new MiddlemanError(
          'session-create-failed',
          '宿主拒绝了建会话：' + (error instanceof Error ? error.message : String(error)),
        )
      }
      const sessionId = created?.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw new MiddlemanError('session-create-failed', '宿主没有返回会话 id')
      }

      try {
        await call('session', 'rename', { sessionId, title: ticket.title })
      } catch (error) {
        faces.warn?.('[dsh-middleman] 会话重命名失败，继续派发：' + String(error))
      }

      const previous = readDefault()
      let applied
      try {
        if (ticket.model !== undefined) {
          const selected = await call('session', 'selectModel', {
            sessionId,
            ...(ticket.model.provider === undefined ? {} : { provider: ticket.model.provider }),
            model: ticket.model.model,
            ...(ticket.model.reasoningEffort === undefined ? {} : { reasoningEffort: ticket.model.reasoningEffort }),
          })
          applied = selected?.selected ?? ticket.model
        }
      } catch (error) {
        await restoreDefault(previous)
        // 钉不上模型时，刚建好的会话不能就这么扔掉。
        //
        // 为什么：会话已经建出来了，宿主已经在计费。原来的写法把 id 丢掉
        // ——账本上没有它，它也不会被取消，于是成了一个没人管、还在计费的
        // 孤儿。而且票的状态还是 pending，再派一次就是**又一个**会话。
        //
        // 所以：先试着取消掉它，再报错。
        try {
          await call('session', 'cancel', { sessionId })
        } catch (cancelError) {
          faces.warn?.('[dsh-middleman] 钉模型失败后会话取消不掉，可能留下一个孤儿会话 ' + sessionId
            + '：' + String(cancelError))
        }
        throw new MiddlemanError(
          'model-pin-failed',
          '会话建好了但模型钉不上：' + (error instanceof Error ? error.message : String(error))
            + '（会话 ' + sessionId + ' 已尝试取消）',
        )
      }
      await restoreDefault(previous)

      // 宿主回包里的 selected 只带它认得的字段——实测它不带 reasoningEffort。
      // 直接拿它覆盖 ticket.model 的话，用户设的强度就没了，卡片上「推理
      // 强度」那一行跟着空掉——显示的与实际跑的不是一回事。
      //
      // 所以以**我们钉进去的那个**为准：宿主回包只用来确认它认了哪个
      // provider/model，强度等字段仍取自 ticket.model。
      const appliedModel = applied === undefined || applied === null
        ? ticket.model
        : {
          provider: applied.provider ?? ticket.model?.provider,
          model: applied.model ?? ticket.model?.model,
          ...(typeof ticket.model?.reasoningEffort === 'string'
            ? { reasoningEffort: ticket.model.reasoningEffort }
            : (typeof applied.reasoningEffort === 'string'
              ? { reasoningEffort: applied.reasoningEffort }
              : {})),
        }

      return { sessionId, model: appliedModel }
    },

    /** 给一个挂起的会话发第一条消息，也就是「执行」。 */
    async run(sessionId, text) {
      await call('session', 'prompt', {
        sessionId,
        requestId: 'dsh-middleman-' + Math.random().toString(36).slice(2),
        mode: 'queue',
        content: [{ type: 'text', text }],
      })
    },

    /**
     * 给一个已经建好的子会话换模型。
     *
     * 这是「调整模型」那条需求的落点：票派出去之后，人在面板上改了主意，
     * 子会话的模型得跟着换。这里只换模型，不改别的——
     * 已经发出去的消息、已经跑了一半的活，都不碰。
     *
     * selectModel 有个副作用：它内部会顺带把全局默认模型改掉（跟 spawn
     * 里一样）。所以这里也要读一次默认、换完恢复——不然用户改一张票的
     * 模型，主会话自己的默认模型就被带偏了。
     *
     * @param sessionId - 子会话 id。
     * @param model - {provider?, model, reasoningEffort?}。
     * @returns 宿主实际选中的模型。
     */
    async selectModel(sessionId, model) {
      if (model === undefined || model === null || typeof model.model !== 'string') {
        throw new MiddlemanError('invalid-model', '必须带 model: {provider, model}')
      }
      const previous = readDefault()
      let selected
      try {
        selected = await call('session', 'selectModel', {
          sessionId,
          ...(model.provider === undefined ? {} : { provider: model.provider }),
          model: model.model,
          ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
        })
      } catch (error) {
        await restoreDefault(previous)
        throw new MiddlemanError(
          'model-pin-failed',
          '模型钉不上：' + (error instanceof Error ? error.message : String(error)),
        )
      }
      await restoreDefault(previous)
      return selected?.selected ?? model
    },

    /** 给运行中的子会话追加一条指令。 */
    async steer(sessionId, text) {
      await call('session', 'prompt', {
        sessionId,
        requestId: 'dsh-middleman-steer-' + Math.random().toString(36).slice(2),
        mode: 'steer',
        content: [{ type: 'text', text }],
      })
    },

    /** 取消一个会话。 */
    async cancel(sessionId) {
      await call('session', 'cancel', { sessionId })
    },

    /**
     * 读一个会话尾部的历史，用来取最后一轮答复。
     * @param sessionId - 会话 id。
     * @returns 事件数组。
     */
    /**
     * 读一个会话尾部的历史。
     *
     * 为什么不能直接 page({ throughSeq: -1 })：throughSeq 是「读到第几号事件」，
     * -1 读作「截止到 -1」，于是 slice(cut, 0) 永远返回空数组——看上去像
     * 「子会话一个字没说」。正确姿势是先 follow 拿当前 cursor，再按它翻页。
     * @param sessionId - 会话 id。
     * @returns page 的 records（每项 {type:'event', event}）。
     */
    async tail(sessionId) {
      const address = { kind: 'session', sessionId }
      // follow 的 snapshot 帧里已经带着完整的历史（records），直接用它。
      //
      // 为什么不用 page：page 的 throughSeq 是「读到第几号事件」，猜错就抛
      // "past cursor"，猜成 -1 则 slice(cut, 0) 永远是空数组——两种猜法都
      // 表现为「子会话一个字没说」。follow 不用猜，它自己报 cursor。
      const stream = await faces.stream?.('session', 'follow', { address, maxMessages: 60 })
      if (stream === undefined) {
        // 流式端点不可用：这是**读不到**，不是「子会话没说话」。
        // 抛出去让观察器记成 tailError——否则回报里会写「(没有文字答复)」，
        // 人分不清是它真没说话，还是我们没读到。
        throw new MiddlemanError('tail-unavailable', '读不到子会话历史：宿主没有提供流式端点')
      }
      const iterator = stream[Symbol.asyncIterator]()
      try {
        const first = await iterator.next()
        const frame = first.done === true ? undefined : first.value
        if (frame?.type === 'snapshot' && Array.isArray(frame.records)) {
          return frame.records
        }
        throw new MiddlemanError('tail-unavailable', '读不到子会话历史：宿主没有返回历史快照')
      } finally {
        if (typeof iterator.return === 'function') await iterator.return()
      }
    },
  }
}

/**
 * 从一段会话历史里提取最后一轮的助手答复。
 * @param events - session/page 的事件数组。
 * @returns 助手最后说的话，没有时返回空串。
 */
export function lastAssistantText(events) {
  const texts = []
  for (const entry of events) {
    // page 回包里的每条是 { event }，测试里直接给事件本身；两种都收。
    const event = entry?.event ?? entry
    if (event?.type !== 'assistant/message') continue
    const content = event.data?.message?.content ?? event.data?.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (part?.type === 'text' && typeof part.text === 'string') texts.push(part.text)
    }
  }
  return texts.join('\n').trim()
}

/**
 * 从一段会话历史里提取结构化摘要：改了哪些文件、跑了什么命令。
 * 摘要由插件从事件里算，不靠子会话自觉写。
 * @param events - session/page 的事件数组。
 * @returns 摘要。
 */
export function summarize(events) {
  const files = new Set()
  const commands = []
  for (const entry of events) {
    const event = entry?.event ?? entry
    if (event?.type !== 'tool/call') continue
    const name = event.data?.name
    let args
    try {
      args = JSON.parse(event.data?.arguments ?? '{}')
    } catch {
      continue
    }
    if (name === 'edit' || name === 'write') {
      const path = args.file_path
      if (typeof path === 'string' && path !== '') files.add(path)
    } else if (name === 'bash') {
      const command = args.command
      if (typeof command === 'string' && command !== '') commands.push(command.split('\n')[0].slice(0, 120))
    }
  }
  return { files: [...files], commands: commands.slice(0, 12) }
}