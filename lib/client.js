/**
 * dsh-middleman 浏览器半区。
 *
 * 只做两件事：在侧边栏加一行「中台」，在中间栏放那个页面。页面本身不碰
 * 模型，只打 /dsh-middleman/api 的六个端点——尤其是 /run，那一下必须由人
 * 点击，所以它注定只能在这里发生。
 *
 * 这一层刻意不引任何客户端 UI 包：面板用原生 DOM 拼，随插件一起走，不跟
 * 宿主的组件版本绑死。
 *
 * @module dsh-middleman/client
 */

/** 侧边栏行的 id，与主栏的 key 一致。 */
export const PANEL_ID = 'middleman'

/** 行序：插件页 0、日程 10、任务板 20，中台放 30。 */
const PANEL_ORDER = 30

/** 客户端需要的服务。 */
export const inject = ['slots']

/** 侧边栏图标。 */
function icon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.3')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.innerHTML = '<rect x="1.6" y="2.2" width="5" height="3.4" rx="0.9"></rect>'
    + '<rect x="1.6" y="10.4" width="5" height="3.4" rx="0.9"></rect>'
    + '<rect x="9.4" y="6.3" width="5" height="3.4" rx="0.9"></rect>'
    + '<path d="M6.6 3.9h1.3v4.1h1.5"></path><path d="M6.6 12.1h1.3V8h1.5"></path>'
  return svg
}

/** 打一次 API。 */
async function api(path, body) {
  const response = await fetch('/dsh-middleman/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const payload = await response.json().catch(() => ({ ok: false, error: '响应不是 JSON' }))
  return payload
}

/** 一点内联样式，避免依赖宿主的样式表。 */
const CSS = {
  wrap: 'display:flex;flex-direction:column;gap:16px;padding:20px;font-size:14px;line-height:1.6;',
  h1: 'font-size:20px;font-weight:600;margin:0;',
  row: 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;',
  card: 'border:1px solid rgba(127,127,127,.28);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:8px;',
  muted: 'opacity:.62;',
  button: 'padding:7px 14px;border-radius:8px;border:1px solid rgba(127,127,127,.35);background:transparent;cursor:pointer;font-size:13px;',
  primary: 'padding:7px 14px;border-radius:8px;border:1px solid transparent;background:#3b82f6;color:#fff;cursor:pointer;font-size:13px;',
  badge: 'padding:1px 8px;border-radius:999px;font-size:12px;border:1px solid rgba(127,127,127,.35);',
}

/** 状态徽标颜色。 */
function tone(status) {
  if (status === 'done') return '#16a34a'
  if (status === 'running') return '#2563eb'
  if (status === 'partial') return '#d97706'
  if (status === 'failed') return '#dc2626'
  if (status === 'suspended') return '#7c3aed'
  return '#6b7280'
}

/**
 * 中台页。
 * @param props - 宿主给的注入面。
 * @returns 页面根节点。
 */
function MiddlemanPage() {
  const root = document.createElement('div')
  root.style.cssText = CSS.wrap

  const title = document.createElement('h1')
  title.textContent = '中台'
  title.style.cssText = CSS.h1
  root.append(title)

  const hint = document.createElement('div')
  hint.style.cssText = CSS.muted
  hint.textContent = '设计批次 → 工单 → 挂起的子会话。点「执行」才真正开始，点之前不花额度。'
  root.append(hint)

  const listBox = document.createElement('div')
  listBox.style.cssText = 'display:flex;flex-direction:column;gap:10px;'
  root.append(listBox)

  const refresh = async () => {
    listBox.textContent = ''
    const state = await api('/state')
    if (state.ok !== true) {
      const error = document.createElement('div')
      error.textContent = state.error ?? '读不到状态'
      error.style.color = '#dc2626'
      listBox.append(error)
      return
    }
    if (!Array.isArray(state.batches) || state.batches.length === 0) {
      const empty = document.createElement('div')
      empty.style.cssText = CSS.muted
      empty.textContent = '还没有设计批次。在对话里说「开个设计批次」，模型会调 design_open。'
      listBox.append(empty)
      return
    }
    for (const row of state.batches) {
      listBox.append(await batchCard(row))
    }
  }

  /** 一个批次的卡片。 */
  const batchCard = async (row) => {
    const card = document.createElement('div')
    card.style.cssText = CSS.card

    const head = document.createElement('div')
    head.style.cssText = CSS.row
    const name = document.createElement('strong')
    name.textContent = row.title
    const badge = document.createElement('span')
    badge.textContent = row.status
    badge.style.cssText = CSS.badge + 'color:' + tone(row.status) + ';border-color:' + tone(row.status) + ';'
    head.append(name, badge)
    card.append(head)

    const detail = await api('/state?batchId=' + encodeURIComponent(row.id))
    if (detail.ok === true && detail.batch !== undefined) {
      const batch = detail.batch
      for (const ticket of batch.tickets ?? []) {
        card.append(ticketRow(batch, ticket))
      }
      if (batch.status === 'converged') {
        const approve = document.createElement('button')
        approve.textContent = '批准这份设计'
        approve.style.cssText = CSS.primary
        approve.addEventListener('click', async () => {
          const result = await api('/approve', { batchId: batch.id })
          if (result.ok !== true) alert(result.error ?? '批准失败')
          await refresh()
        })
        card.append(approve)
      }
    }
    return card
  }

  /** 一张工单的行。 */
  const ticketRow = (batch, ticket) => {
    const row = document.createElement('div')
    row.style.cssText = CSS.row + 'justify-content:space-between;padding:8px 0;border-top:1px solid rgba(127,127,127,.16);'

    const left = document.createElement('div')
    left.style.cssText = 'display:flex;flex-direction:column;gap:2px;'
    const name = document.createElement('span')
    name.textContent = ticket.id + ' ' + ticket.title
    const meta = document.createElement('span')
    meta.style.cssText = CSS.muted + 'font-size:12px;'
    const model = ticket.model === undefined ? '未定模型' : (ticket.model.provider ?? '') + '/' + ticket.model.model
    meta.textContent = model + ' · ' + (ticket.modelReason ?? '')
    left.append(name, meta)

    const right = document.createElement('div')
    right.style.cssText = CSS.row
    const badge = document.createElement('span')
    badge.textContent = ticket.status ?? 'pending'
    badge.style.cssText = CSS.badge + 'color:' + tone(ticket.status) + ';border-color:' + tone(ticket.status) + ';'
    right.append(badge)

    if (ticket.childSessionId !== undefined) {
      const run = document.createElement('button')
      run.textContent = '执行'
      run.style.cssText = CSS.primary
      run.addEventListener('click', async () => {
        const result = await api('/run', { batchId: batch.id, ticketId: ticket.id })
        if (result.ok !== true) alert(result.error ?? '执行失败')
        await refresh()
      })
      right.append(run)
    }

    row.append(left, right)
    return row
  }

  void refresh()
  return root
}

/**
 * 装侧边栏行与主栏页面。
 * @param ctx - 客户端上下文。
 */
export function apply(ctx) {
  const slots = ctx.slots
  if (slots === undefined) return
  ctx.effect(() => slots.inject('sidebar.panellist', () => slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: PANEL_ORDER,
    label: () => '中台',
  }, icon)), 'dsh-middleman: 侧边栏行')

  ctx.effect(() => slots.inject('main', () => slots.register({
    name: 'main',
    key: PANEL_ID,
  }, MiddlemanPage)), 'dsh-middleman: 中台页')
}
