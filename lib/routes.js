/**
 * 宿主 HTTP 面：中台面板驱动的六个端点，全部挂在 /dsh-middleman/api 下。
 *
 * 每个端点答 JSON。拒绝是一个稳定机器码加一句有界的话，不吐栈、不吐台账
 * 全文、不吐会话正文。围栏只放本机浏览器：socket 必须是环回。
 *
 * 关键端点只有一个：POST /run —— 这就是「执行」按钮打的那一下。它不经过
 * 模型，直接由人点击触发，所以它不属于工具面。
 *
 * @module dsh-middleman/routes
 */
import { MiddlemanError, isMiddlemanError, statusForCode } from './refusals.js'
import { load, list, save } from './ledger.js'
import { readyTickets } from './core.js'

/** 路由前缀。 */
export const API_PREFIX = '/dsh-middleman/api'

/** 请求体上限。 */
const BODY_LIMIT = 64 * 1024

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
}

/** 写一份 JSON 响应。 */
function writeJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

/** 拒绝。 */
function refuse(res, status, code, message) {
  writeJson(res, status, { ok: false, code, error: message })
}

/** 读请求体。 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT) throw new MiddlemanError('invalid-request', '请求体超过上限')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new MiddlemanError('invalid-request', '请求体不是合法 JSON')
  }
}

/** 是否是环回连接。 */
export function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * 造六个路由。
 * @param faces - 台账、派发面与配置。
 * @returns WebRoute 数组。
 */
export function makeRoutes(faces) {
  /** 统一包一层：环回围栏 + 错误映射。 */
  const route = (kind, path, handler) => ({
    kind,
    path,
    async handler(req, res) {
      if (!isLoopback(req.socket?.remoteAddress)) {
        refuse(res, 403, 'forbidden', '只接受本机连接')
        return
      }
      try {
        await handler(req, res)
      } catch (error) {
        if (isMiddlemanError(error)) {
          refuse(res, statusForCode(error.code), error.code, error.message)
          return
        }
        faces.warn?.('[dsh-middleman] 路由失败：' + String(error))
        // 只在本机回环上回显原因：这条围栏已经确认过 socket 是环回，
        // 把原因说出来比让人去翻日志快得多。
        refuse(res, 500, 'internal', error instanceof Error ? error.message : String(error))
      }
    },
  })

  return [
    // 状态：全部批次，或一个批次的详情。
    route('prefix', API_PREFIX + '/state', async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const id = url.searchParams.get('batchId')
      if (id === null || id === '') {
        const rows = await list()
        writeJson(res, 200, {
          ok: true,
          batches: rows.map((row) => ({
            id: row.id, title: row.title, status: row.status,
            open: (row.decisions ?? []).filter((d) => d.answer === undefined && d.deferred === undefined).length,
            tickets: (row.tickets ?? []).length,
            createdAt: row.createdAt,
          })),
        })
        return
      }
      const batch = await load(id)
      writeJson(res, 200, { ok: true, batch, ready: readyTickets(batch).map((t) => t.id) })
    }),

    // 批准：只有人点得到。这是与工具面的分工。
    route('exact', API_PREFIX + '/approve', async (req, res) => {
      const body = await readBody(req)
      const batch = await load(String(body.batchId ?? ''))
      if (batch.status === 'approved') {
        // 已经批过了：再点一次不算错。
        //
        // 为什么幂等很重要：卡片上的「批准」按钮点下去之后，页面可能
        // 还没刷新，人会再点一下——这时报 409 会让人以为没批准成功，
        // 于是反复点。点了就是批过了，回一个 ok 才说得通。
        writeJson(res, 200, { ok: true, status: batch.status, alreadyApproved: true })
        return
      }
      if (batch.status !== 'converged') {
        refuse(res, 409, 'not-converged', '只有收敛后的批次才能批准，当前状态：' + batch.status)
        return
      }
      batch.status = 'approved'
      batch.approvedAt = Date.now()
      batch.approvedBy = 'human'
      await save(batch)
      writeJson(res, 200, { ok: true, status: batch.status })
    }),

    // 执行：把挂起的子会话真正跑起来。这一下由人点击触发，不经过模型。
    route('exact', API_PREFIX + '/run', async (req, res) => {
      const body = await readBody(req)
      const batch = await load(String(body.batchId ?? ''))
      const ticket = (batch.tickets ?? []).find((candidate) => candidate.id === body.ticketId)
      if (ticket === undefined) {
        refuse(res, 404, 'ticket-missing', '没有这张工单：' + String(body.ticketId))
        return
      }
      if (typeof ticket.childSessionId !== 'string') {
        refuse(res, 409, 'not-dispatched', ticket.id + ' 还没派发，先调 dispatch_task')
        return
      }
      if (ticket.status === 'running') {
        refuse(res, 409, 'already-running', ticket.id + ' 已经在跑了')
        return
      }
      await faces.dispatcher.run(ticket.childSessionId, buildBrief(batch, ticket))
      ticket.status = 'running'
      ticket.startedAt = Date.now()
      await save(batch)
      writeJson(res, 200, { ok: true, ticketId: ticket.id, status: ticket.status })
    }),

    // 修改意见：写进工单，并送到该去的地方。
    //
    // 卡片上的「有修改意见」按钮走这里。意见不能只留在浏览器里——
    // 得有人真的收到它。
    //
    // 送到哪儿取决于这张票在什么状态：
    //   - 子会话正在跑：直接 steer 那个子会话（session.prompt 的 steer 模式）。
    //     人看到子会话跑偏了，当场就能拉回来，不用等它跑完再返工。
    //   - 票还挂着没跑：没有活着的子会话可 steer，于是推给主会话——
    //     主会话是唯一会读这张票的人，它得在下一轮就看见人说了什么。
    route('exact', API_PREFIX + '/feedback', async (req, res) => {
      const body = await readBody(req)
      const batch = await load(String(body.batchId ?? ''))
      const ticket = (batch.tickets ?? []).find((candidate) => candidate.id === body.ticketId)
      if (ticket === undefined) {
        refuse(res, 404, 'ticket-missing', '没有这张工单')
        return
      }
      const message = typeof body.message === 'string' ? body.message.trim() : ''
      if (message === '') {
        refuse(res, 400, 'invalid-request', '意见不能为空')
        return
      }
      ticket.feedback = [
        ...(Array.isArray(ticket.feedback) ? ticket.feedback : []),
        { message, at: Date.now() },
      ]
      await save(batch)

      // 子会话在跑就 steer 它；否则推给主会话。
      const running = ticket.status === 'running' && typeof ticket.childSessionId === 'string'
      if (running) {
        try {
          await faces.dispatcher.steer(ticket.childSessionId, message)
          writeJson(res, 200, { ok: true, ticketId: ticket.id, deliveredTo: 'child' })
          return
        } catch (error) {
          // steer 失败不能吞掉——人以为说到了，其实没送到。
          refuse(res, 502, 'steer-failed', error instanceof Error ? error.message : String(error))
          return
        }
      }

      if (typeof batch.parentSessionId === 'string') {
        await faces.dispatcher.run(
          batch.parentSessionId,
          '[工单修改意见] ' + ticket.id + ' ' + ticket.title + '\n' + message,
        )
        writeJson(res, 200, { ok: true, ticketId: ticket.id, deliveredTo: 'parent' })
        return
      }
      // 没有主会话可推：意见留在了票上，但没人收到。
      //
      // 不能回 deliveredTo: 'parent'——那是谎报，人以为说到了。
      // 说清楚它哪儿也没送到，让人知道得另想办法。
      writeJson(res, 200, {
        ok: true,
        ticketId: ticket.id,
        deliveredTo: 'nowhere',
        note: '这个批次没有记着主会话，意见只存在票上（' + ticket.id + '），没有送出去',
      })
    }),

    // 改模型：立刻换。
    //
    // 票还没派出去（没有子会话）时只改账本，等派发时按新的建；
    // 已经有子会话时直接给它 selectModel——子会话下一次请求就用新模型。
    route('exact', API_PREFIX + '/retarget', async (req, res) => {
      const body = await readBody(req)
      const batch = await load(String(body.batchId ?? ''))
      const ticket = (batch.tickets ?? []).find((candidate) => candidate.id === body.ticketId)
      if (ticket === undefined) {
        refuse(res, 404, 'ticket-missing', '没有这张工单：' + String(body.ticketId))
        return
      }
      const model = body.model
      if (model === undefined || model === null || typeof model.model !== 'string') {
        refuse(res, 400, 'invalid-request', '必须带 model: {provider, model}')
        return
      }
      // 子会话还没建出来（票还没派）：只改账本上的模型，等派发时按新的建。
      let applied
      if (typeof ticket.childSessionId === 'string') {
        try {
          applied = await faces.dispatcher.selectModel(ticket.childSessionId, model)
        } catch (error) {
          // 会话钉不上模型时不能装作成功——账本改了、实际没改，
          // 卡片上显示的强度就和子会话真正跑的对不上，正是修掉的那个毛病。
          refuse(res, 502, 'model-pin-failed', error instanceof Error ? error.message : String(error))
          return
        }
      }
      // 写回**宿主真正选中的**，不是我们请求的。
      //
      // 为什么：宿主会把模型 id 规范化（m2 → m2-preview），还会在没指定
      // 强度时填上它自己的默认值。写回请求值的话，账本与卡片显示的是
      // 「我们要的」，子会话跑的却是「宿主给定的」——显示的与实际跑的不是
      // 一回事，跟前两天修掉的那个毛病是同一类。
      const effective = applied === undefined || applied === null
        ? model
        : {
          provider: applied.provider ?? model.provider,
          model: applied.model ?? model.model,
          ...(typeof applied.reasoningEffort === 'string'
            ? { reasoningEffort: applied.reasoningEffort }
            : (typeof model.reasoningEffort === 'string' ? { reasoningEffort: model.reasoningEffort } : {})),
        }
      ticket.model = effective
      // 强度只有一个真相来源：model.reasoningEffort。
      // effort 对齐过去，免得两个字段各写各的，卡片显示的与实际跑的又分叉。
      if (typeof effective.reasoningEffort === 'string') {
        ticket.effort = effective.reasoningEffort
      }
      ticket.modelReason = typeof body.modelReason === 'string' ? body.modelReason : ticket.modelReason
      await save(batch)
      writeJson(res, 200, { ok: true, ticketId: ticket.id, model: ticket.model })
    }),

    // 回答子会话的「请确认」。
    //
    // 子会话停下来问时，票变成 waiting。人在这里答一句，票回到 running，
    // 答案作为**新的用户消息**送进那个子会话——它接着往下跑。
    //
    // 为什么不用 steer：steer 是打断正在跑的轮次用的。这时候那一轮已经
    // 结束了（子会话停下来了），要的是「再给它一条消息让它继续」，
    // 那是 queue 模式，不是 steer。
    route('exact', API_PREFIX + '/answer', async (req, res) => {
      const body = await readBody(req)
      const batch = await load(String(body.batchId ?? ''))
      const ticket = (batch.tickets ?? []).find((candidate) => candidate.id === body.ticketId)
      if (ticket === undefined) {
        refuse(res, 404, 'ticket-missing', '没有这张工单')
        return
      }
      if (ticket.status !== 'waiting') {
        refuse(res, 409, 'not-waiting',
          '这张票没在等人确认，当前状态：' + String(ticket.status))
        return
      }
      const answer = typeof body.answer === 'string' ? body.answer.trim() : ''
      if (answer === '') {
        refuse(res, 400, 'invalid-request', '回答不能为空')
        return
      }
      const sessionId = ticket.waiting?.sessionId ?? ticket.childSessionId
      if (typeof sessionId !== 'string') {
        refuse(res, 409, 'no-session', '这张票没有可送达的子会话')
        return
      }

      // 先把答案送出去，再改状态。
      //
      // 顺序很重要：反过来的话，发送失败时票已经显示「继续跑」，
      // 而子会话其实没收到——正是这几轮反复修的那类「显示的和实际的
      // 对不上」。
      try {
        await faces.dispatcher.run(
          sessionId,
          '[人的答复] ' + (ticket.waiting?.question ?? '') + '\n\n' + answer,
        )
      } catch (error) {
        refuse(res, 502, 'deliver-failed',
          '答复没送到子会话：' + (error instanceof Error ? error.message : String(error)))
        return
      }

      ticket.answers = [
        ...(Array.isArray(ticket.answers) ? ticket.answers : []),
        { question: ticket.waiting?.question, answer, at: Date.now() },
      ]
      delete ticket.waiting
      ticket.status = 'running'
      await save(batch)
      writeJson(res, 200, {
        ok: true,
        ticketId: ticket.id,
        status: 'running',
        note: '答复已送到子会话，它接着跑。',
      })
    }),

    // 取消。
    route('exact', API_PREFIX + '/cancel', async (req, res) => {
      const body = await readBody(req)
      const batch = await load(String(body.batchId ?? ''))
      const ticket = (batch.tickets ?? []).find((candidate) => candidate.id === body.ticketId)
      if (ticket === undefined) {
        refuse(res, 404, 'ticket-missing', '没有这张工单')
        return
      }
      if (typeof ticket.childSessionId === 'string') {
        try {
          await faces.dispatcher.cancel(ticket.childSessionId)
        } catch (error) {
          faces.warn?.('[dsh-middleman] 取消失败：' + String(error))
        }
      }
      ticket.status = 'cancelled'
      ticket.finishedAt = Date.now()
      await save(batch)
      writeJson(res, 200, { ok: true, ticketId: ticket.id, status: ticket.status })
    }),

    // 模型目录：面板的模型下拉读它。这一条永不失败——拿不到就回空列表，
    // 面板据此退化成手填 provider/model，而不是让整页报错。
    route('exact', API_PREFIX + '/models', async (_req, res) => {
      let diagnostic = null
      try {
        diagnostic = faces.diagnostic?.() ?? null
      } catch (error) {
        diagnostic = { diagnosticFailed: String(error) }
      }
      try {
        const catalog = await faces.dispatcher.modelCatalog()
        writeJson(res, 200, { ok: true, catalog, diagnostic })
      } catch (error) {
        writeJson(res, 200, {
          ok: false,
          code: 'catalog-unavailable',
          error: error instanceof Error ? error.message : String(error),
          diagnostic,
        })
      }
    }),
  ]
}

/** 点执行时发给子会话的第一条消息：任务书 + 它那张票的风险。 */
export function buildBrief(batch, ticket) {
  const lines = [ticket.brief === '' ? ticket.title : ticket.brief]
  if (Array.isArray(ticket.riskIds) && ticket.riskIds.length > 0) {
    const risks = (batch.risks ?? []).filter((risk) => ticket.riskIds.includes(risk.id))
    if (risks.length > 0) {
      lines.push('')
      lines.push('## 这张工单关联的风险')
      for (const risk of risks) {
        lines.push('- ' + risk.id + ' ' + risk.title)
        lines.push('  触发: ' + risk.trigger)
        lines.push('  缓解: ' + risk.mitigation)
        lines.push('  验证: ' + risk.verification)
      }
    }
  }
  if (Array.isArray(batch.spec?.acceptance) && batch.spec.acceptance.length > 0) {
    lines.push('')
    lines.push('## 验收标准')
    for (const item of batch.spec.acceptance) lines.push('- ' + item)
  }
  return lines.join('\n')
}