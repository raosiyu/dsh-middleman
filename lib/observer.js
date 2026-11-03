/**
 * 回传：子会话的 turn 结束时，把结果推回主会话。
 *
 * 这里只订阅一个事件：ctx.on('session/event')，看 event.type === 'turn/end'。
 * 台账里没有这个 sessionId 就立刻返回，所以它不会碰你日常对话的任何一轮。
 *
 * 结算按 reason 分类，不是一律当失败：max-tokens 与 interrupted 记 partial，
 * 否则长任务被截断也会报失败，你就开始忽略失败通知了。
 *
 * @module dsh-middleman/observer
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
export function installObserver(ctx, faces) {
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
        faces.warn?.('[dsh-middleman] 读子会话历史失败，回传不带正文：' + tailError)
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
        await faces.dispatcher.run(batch.parentSessionId, reportText(batch, ticket, verdict, text, summary))
      }
    } catch (error) {
      faces.warn?.('[dsh-middleman] 回传失败：' + String(error))
    }
  })

  return () => { dispose() }
}

/** 拼给主会话看的那段结构化回报。 */
export function reportText(batch, ticket, verdict, text, summary) {
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
  lines.push(text === '' ? '(没有文字答复)' : text)
  return lines.join('\n')
}
