/**
 * 回传：子会话的 turn 结束时，把结果推回主会话。
 *
 * 这里只订阅一个事件：ctx.on('session/event')，看 event.type === 'turn/end'。
 * 台账里没有这个 sessionId 就立刻返回，所以它不会碰你日常对话的任何一轮。
 *
 * 结算按 reason 分类，不是一律当失败：max-tokens 与 interrupted 记 partial，
 * 否则长任务被截断也会报失败，你就开始忽略失败通知了。
 *
 * @module dsh-whale-tail/observer
 */
import { classifyTurnEnd } from './core.js'
import { list, save } from './ledger.js'
import { lastAssistantText, summarize } from './dispatch.js'

/**
 * 装一个观察器。
 * @param ctx - 插件上下文，只用到 ctx.on 与可选的 logger。
 * @param faces - 派发面（读历史、往主会话发消息）。
 * @returns 卸载函数。
 */
/**
 * 已经装好的观察器，按宿主上下文记一份。
 *
 * 为什么要记：插件每重载一次就 apply 一次，而重载时旧 fiber 的卸载不一定
 * 来得及跑完——同一个 turn/end 于是被推 N 次，主会话收到一串重复回报。
 *
 * 靠 fiber 卸载时序来防这件事靠不住，所以这里自己记一份：新观察器装上时，
 * 先把上一个卸掉。
 */
const installed = new WeakMap()

export function installObserver(ctx, faces) {
  // 同一份 ctx 上已经有一个观察器：先卸掉它，避免重复回报。
  const previous = installed.get(ctx)
  if (previous !== undefined) {
    try {
      previous()
    } catch (error) {
      // 卸不掉就算了：新观察器照样装，至少不会两个并存。
    }
    installed.delete(ctx)
  }

  /** 子会话 id → {batch, ticket}，从台账折叠出来，事件到达时 O(1) 命中。 */
  const index = new Map()

  /** 重建索引。台账很小，整份重读比增量维护更不容易错。 */
  const reindex = async () => {
    index.clear()
    for (const batch of await list()) {
      for (const ticket of batch.tickets ?? []) {
        if (typeof ticket.childSessionId === 'string') index.set(ticket.childSessionId, { batchId: batch.id, ticketId: ticket.id })
      }
    }
  }

  void reindex()
  // 台账可能被工具改过；每次事件到来时按需重读，代价很小。
  const ensureFresh = async () => { await reindex() }

  const dispose = ctx.on('session/event', async (session, event) => {
    if (event?.type !== 'turn/end') return
    const sessionId = session?.id
    if (typeof sessionId !== 'string') return
    await ensureFresh()
    const hit = index.get(sessionId)
    if (hit === undefined) return

    try {
      const batch = (await list()).find((candidate) => candidate.id === hit.batchId)
      if (batch === undefined) return
      const ticket = (batch.tickets ?? []).find((candidate) => candidate.id === hit.ticketId)
      if (ticket === undefined) return

      // 只结算**跑过**的票。
      //
      // 为什么：票挂起（suspended）的时候子会话已经建好，但人还没点「执行」，
      // 它没跑过任何东西。这时候来一个 turn/end（初始化失败、宿主自己发的
      // 空 turn……），观察器会把这张没跑过的票标成 done，还给主会话回一条
      // 「任务完成」——主会话于是以为活干完了。
      //
      // 判据是「跑过没有」：pending 与 suspended 一定没跑过。
      // 跑过之后票会变成 running / done / failed / partial，steer 会带起
      // 新一轮 turn，那一轮同样该回传——所以不能只认 running。
      if (ticket.status === 'pending' || ticket.status === 'suspended') return

      // 子会话主动停下来等人时，**不要结算**。
      //
      // 为什么：request_confirmation 把票置成 waiting，然后那一轮就结束了。
      // 紧接着来的 turn/end 会把它结算成 done——「在等你」被覆盖成「已完成」，
      // 面板上看起来活干完了，人也不会去答那个问题，子会话就永远停在那儿。
      //
      // 真机撞到过：waiting 字段写进去了，但 status 是 done。所以这里先看
      // waiting 字段——它才是「它在等我」的真凭据，比 status 更靠得住。
      if (ticket.status === 'waiting' || ticket.waiting !== undefined) return

      // 去重：一次派发只该回传一次。
      //
      // 为什么必须有这条：插件重载会重新 apply，而旧的监听器不一定来得及
      // 卸载干净，同一个 turn/end 于是会被推 N 次。按「这张票已经结算过」
      // 拦一道，比依赖卸载时序可靠。
      const turn = event.data?.turn
      if (ticket.reportedTurn !== undefined && ticket.reportedTurn === turn) return

      const verdict = classifyTurnEnd(event.data?.reason)
      let tail = []
      let tailError
      try {
        tail = await faces.dispatcher.tail(sessionId)
      } catch (error) {
        tailError = error instanceof Error ? error.message : String(error)
        faces.warn?.('[dsh-whale-tail] 读子会话历史失败，回传不带正文：' + tailError)
      }
      const text = lastAssistantText(tail)
      const summary = summarize(tail)

      ticket.status = verdict.status
      ticket.finishedAt = Date.now()
      ticket.reportedTurn = turn
      ticket.result = {
        text: text.slice(0, 8000),
        summary,
        note: verdict.note,
        // 排障用：读了多少条、有没有报错。正文为空时靠它区分「真没说话」和「读错了」。
        ...(tailError === undefined ? { events: tail.length } : { tailError }),
      }
      await save(batch)

      if (typeof batch.parentSessionId === 'string') {
        await faces.dispatcher.run(
          batch.parentSessionId,
          reportText(batch, ticket, verdict, text, summary, tailError),
        )
      }
    } catch (error) {
      faces.warn?.('[dsh-whale-tail] 回传失败：' + String(error))
    }
  })

  const uninstall = () => {
    dispose()
    if (installed.get(ctx) === uninstall) installed.delete(ctx)
  }
  installed.set(ctx, uninstall)
  return uninstall
}

/**
 * 拼给主会话看的那段结构化回报。
 *
 * @param batch - 批次。
 * @param ticket - 工单。
 * @param verdict - 结算结论。
 * @param text - 子会话的答复正文。
 * @param summary - 改过的文件与跑过的命令。
 * @param tailError - 读历史时的错误；读不到正文时用它说明，而不是假装
 *   「子会话没有文字答复」。
 */
export function reportText(batch, ticket, verdict, text, summary, tailError) {
  const lines = [
    '[子任务回报] ' + ticket.id + ' / 状态: ' + verdict.status,
    '批次: ' + batch.id + ' — ' + batch.title,
  ]
  if (verdict.note !== '') lines.push('说明: ' + verdict.note)
  if (summary.files.length > 0) lines.push('改动的文件: ' + summary.files.join(', '))
  if (summary.commands.length > 0) lines.push('跑过的命令: ' + summary.commands.join(' | '))
  if (Array.isArray(ticket.riskIds) && ticket.riskIds.length > 0) {
    const risks = (batch.risks ?? []).filter((risk) => ticket.riskIds.includes(risk.id))
    lines.push('关联风险: ' + risks.map((risk) => risk.id + ' ' + risk.title + '（验证方式: ' + risk.verification + '）').join('；'))
  }
  lines.push('')
  lines.push('最终答复:')
  if (tailError !== undefined) {
    // 读不到正文就说读不到——别写成「没有文字答复」，那会让人以为
    // 子会话真的什么都没干。
    lines.push('(读不到子会话的历史：' + tailError + ')')
  } else {
    lines.push(text === '' ? '(没有文字答复)' : text)
  }
  return lines.join('\n')
}
