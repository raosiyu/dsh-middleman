/**
 * 派发卡片的判断层。
 *
 * 这里只放纯计算：给哪个阶段的参数、卡片上摆哪几行、按钮长什么样。
 * 不碰 React，不碰 DOM——所以它能被单测直接盯住。
 *
 * 单独拆出来的原因：这张卡片挂在对话流里，一个阶段写错就是整张卡空白，
 * 而空白在浏览器里很难一眼看出是「没渲染」还是「没数据」。
 *
 * @module dsh-whale-tail/card-model
 */

/** 状态 → 颜色。 */
export const TONE = {
  done: '#16a34a',
  running: '#2563eb',
  partial: '#d97706',
  failed: '#dc2626',
  suspended: '#7c3aed',
  pending: '#6b7280',
  cancelled: '#6b7280',
  grilling: '#6b7280',
  converged: '#d97706',
  approved: '#16a34a',
  dispatched: '#2563eb',
}

/**
 * 从一个阶段的 block 里取参数。
 *
 * 三个阶段的形状不一样：
 * - preparing：参数还没到齐，没有 argsRaw
 * - start：block.argsRaw
 * - result：block.call.argsRaw（call 是回填的调用头）
 *
 * 写成 `block.call?.argsRaw ?? block.argsRaw` 在 start 阶段会取到 undefined，
 * 在 result 阶段能取到；反过来写则 start 阶段取不到。所以按阶段分别读。
 *
 * @param phase - 阶段：preparing / start / result。
 * @param block - 该阶段的 block。
 * @returns 参数字符串，取不到时是 undefined。
 */
export function argsRawOf(phase, block) {
  if (phase === 'start') return block?.argsRaw
  if (phase === 'result') return block?.call?.argsRaw
  return undefined
}

/**
 * 解析参数。
 * @param phase - 阶段。
 * @param block - 该阶段的 block。
 * @returns { batchId?: string, ticketId?: string }。
 */
export function argsOf(phase, block) {
  const raw = argsRawOf(phase, block)
  if (typeof raw !== 'string') return {}
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object') return {}
  const batchId = typeof parsed.batchId === 'string' ? parsed.batchId : undefined
  const ticketId = typeof parsed.ticketId === 'string' ? parsed.ticketId : undefined
  return { ...(batchId === undefined ? {} : { batchId }), ...(ticketId === undefined ? {} : { ticketId }) }
}

/**
 * 把模型目录摊平成一张可选项的表。
 *
 * 目录的形状是 {groups: [{id, name, models: [{id, name}]}]}。摊平之后
 * 每项记着 provider 与 model——改模型时这两个要一起发回去，只发 model
 * 名字是不够的，不同 provider 下可能有同名模型。
 *
 * @param catalog - 模型目录，拿不到时传 undefined。
 * @returns [{ value: 'provider/model', provider, model, label }]。
 */
export function modelOptions(catalog) {
  const groups = catalog?.groups
  if (!Array.isArray(groups)) return []
  const options = []
  for (const group of groups) {
    if (group === null || typeof group !== 'object') continue
    const provider = typeof group.id === 'string' ? group.id : undefined
    if (provider === undefined) continue
    const models = Array.isArray(group.models) ? group.models : []
    for (const model of models) {
      if (model === null || typeof model !== 'object') continue
      const id = typeof model.id === 'string' ? model.id : undefined
      if (id === undefined) continue
      const name = typeof model.name === 'string' ? model.name : id
      options.push({
        value: provider + '/' + id,
        provider,
        model: id,
        label: provider + ' · ' + name,
      })
    }
  }
  return options
}

/**
 * 算出一张票在卡片上怎么显示。
 *
 * @param ticket - 工单，来自 /state。
 * @returns 卡片的行与按钮。
 */
export function ticketView(ticket) {
  if (ticket === undefined || ticket === null) {
    return { kind: 'missing', fields: [], hints: [], buttons: [] }
  }

  const model = ticket.model === undefined || ticket.model === null
    ? '未定模型'
    : (ticket.model.provider === undefined ? '' : ticket.model.provider + '/') + ticket.model.model
  // 推理强度要显示**子会话真正会用的那个值**，不是另一个近似字段。
  //
  // 派发时钉模型走的是 ticket.model.reasoningEffort（lib/dispatch.js 里
  // session.selectModel 传的就是它），所以卡片必须先读它。
  // ticket.effort 只是兜底——工单没写 model.reasoningEffort 时才用。
  //
  // 反过来写（先读 ticket.effort）会骗人：实测出现过卡片写 low、
  // 子会话其实跑 high 的情况，因为两者是各自独立写进去的。
  const effort = ticket.model?.reasoningEffort ?? ticket.effort
  const notes = ticket.notes ?? {}

  const fields = [
    ['工单文件', ticket.source],
    ['要发送的内容', ticket.payload ?? ticket.brief],
    ['模型', model],
    ['推理强度', effort],
  ].filter(([, value]) => value !== undefined && value !== null && value !== '')

  const hints = []
  if (notes.before !== undefined) hints.push(['开始前', notes.before])
  if (notes.order !== undefined) hints.push(['顺序', notes.order])
  if (notes.parallel !== undefined) hints.push(['可以同时做的', notes.parallel])

  const dispatched = ticket.childSessionId !== undefined
  const running = ticket.status === 'running'

  const buttons = []
  if (dispatched && !running) {
    buttons.push({ kind: 'run', label: '执行' })
  } else if (running) {
    buttons.push({ kind: 'wait', label: '正在运行…' })
  } else {
    buttons.push({ kind: 'wait', label: '等前序工单完成' })
  }
  // 意见送哪儿取决于票在什么状态，说清楚免得人以为说给了谁。
  buttons.push({
    kind: 'feedback',
    label: running ? '追加指令' : '有修改意见',
  })

  return {
    kind: 'ready',
    title: ticket.id + ' ' + ticket.title,
    status: ticket.status,
    fields,
    hints,
    buttons,
  }
}
