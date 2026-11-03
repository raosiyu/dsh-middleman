/**
 * dsh-middleman 浏览器半区。
 *
 * 这个文件不是普通 ESM：它必须按 DSH 的客户端模块协议注册自己
 * （window.__ModuleLoader__.load({id, factory})），由 web 应用在启动时加载。
 * 写成 export function apply 的形式宿主会当普通模块，浏览器永远看不到它。
 *
 * 页面用 React.createElement 拼，不用 JSX —— 于是不需要构建步骤，
 * 仓库里就是能直接装的那一份。
 *
 * @module dsh-middleman/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-middleman',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** 侧边栏行的 id，与主栏的 key 一致。 */
    const PANEL_ID = 'middleman'

    /** 行序：插件页 0、日程 10、任务板 20，中台放 30。 */
    const PANEL_ORDER = 30

    // 状态 → 颜色：用判断层那份，客户端与测试同源。

    // ── 卡片的判断层 ───────────────────────────────────────────────
    // 由 scripts/inline-card-model.mjs 从 lib/card-model.js 生成，别手改。
    // 两份的逐字一致由 test/client-bundle.test.mjs 守住。
    const cardModel = (() => {
/**
 * 派发卡片的判断层。
 *
 * 这里只放纯计算：给哪个阶段的参数、卡片上摆哪几行、按钮长什么样。
 * 不碰 React，不碰 DOM——所以它能被单测直接盯住。
 *
 * 单独拆出来的原因：这张卡片挂在对话流里，一个阶段写错就是整张卡空白，
 * 而空白在浏览器里很难一眼看出是「没渲染」还是「没数据」。
 *
 * @module dsh-middleman/card-model
 */

/** 状态 → 颜色。 */
const TONE = {
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
function argsRawOf(phase, block) {
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
function argsOf(phase, block) {
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
 * 算出一张票在卡片上怎么显示。
 *
 * @param ticket - 工单，来自 /state。
 * @returns 卡片的行与按钮。
 */
function ticketView(ticket) {
  if (ticket === undefined || ticket === null) {
    return { kind: 'missing', fields: [], hints: [], buttons: [] }
  }

  const model = ticket.model === undefined || ticket.model === null
    ? '未定模型'
    : (ticket.model.provider === undefined ? '' : ticket.model.provider + '/') + ticket.model.model
  const effort = ticket.effort ?? ticket.model?.reasoningEffort
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
  buttons.push({ kind: 'feedback', label: '有修改意见' })

  return {
    kind: 'ready',
    title: ticket.id + ' ' + ticket.title,
    status: ticket.status,
    fields,
    hints,
    buttons,
  }
}
      return { TONE, argsRawOf, argsOf, ticketView }
    })()

    /** 打一次本插件 API。 */
    async function api(path, body) {
      try {
        const response = await fetch('/dsh-middleman/api' + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: body === undefined ? {} : { 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        return await response.json()
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    }

    /** 一枚状态徽标。 */
    function badge(status) {
      const color = TONE[status] ?? '#6b7280'
      return h('span', {
        style: {
          padding: '1px 8px',
          borderRadius: 999,
          fontSize: 12,
          color,
          border: '1px solid ' + color,
          whiteSpace: 'nowrap',
        },
      }, status ?? 'pending')
    }

    /** 一张工单的行。 */
    function TicketRow(props) {
      const { batch, ticket, onChanged } = props
      const [busy, setBusy] = React.useState(false)
      const model = ticket.model === undefined
        ? '未定模型'
        : (ticket.model.provider === undefined ? '' : ticket.model.provider + '/') + ticket.model.model

      const act = async (path, body) => {
        setBusy(true)
        const result = await api(path, body)
        setBusy(false)
        if (result.ok !== true) alert(result.error ?? '操作失败')
        await onChanged()
      }

      const actions = []
      if (ticket.childSessionId !== undefined) {
        actions.push(h('button', {
          key: 'run',
          disabled: busy || ticket.status === 'running',
          onClick: () => act('/run', { batchId: batch.id, ticketId: ticket.id }),
          style: {
            padding: '6px 14px', borderRadius: 8, border: '1px solid transparent',
            background: busy || ticket.status === 'running' ? '#9ca3af' : '#3b82f6',
            color: '#fff', cursor: busy ? 'default' : 'pointer', fontSize: 13,
          },
        }, ticket.status === 'running' ? '运行中' : '执行'))
      }

      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12, padding: '8px 0', borderTop: '1px solid rgba(127,127,127,.16)',
        },
      }, [
        h('div', { key: 'left', style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } }, [
          h('span', { key: 'name', style: { fontSize: 14 } }, ticket.id + ' ' + ticket.title),
          h('span', {
            key: 'meta',
            style: { fontSize: 12, opacity: 0.62, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, model + (ticket.modelReason ? ' · ' + ticket.modelReason : '')),
        ]),
        h('div', { key: 'right', style: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 } }, [
          badge(ticket.status),
          ...actions,
        ]),
      ])
    }

    /** 一个批次的卡片。 */
    function BatchCard(props) {
      const { row, onChanged } = props
      const [detail, setDetail] = React.useState(null)

      const load = React.useCallback(async () => {
        const result = await api('/state?batchId=' + encodeURIComponent(row.id))
        setDetail(result.ok === true ? result.batch : null)
      }, [row.id])

      React.useEffect(() => { void load() }, [load])

      const approve = async () => {
        const result = await api('/approve', { batchId: row.id })
        if (result.ok !== true) alert(result.error ?? '批准失败')
        await load()
        await onChanged()
      }

      const children = [
        h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } }, [
          h('strong', { key: 'name', style: { fontSize: 14 } }, row.title),
          badge(detail?.status ?? row.status),
          h('span', { key: 'id', style: { fontSize: 12, opacity: 0.55 } }, row.id),
        ]),
      ]

      for (const ticket of detail?.tickets ?? []) {
        children.push(h(TicketRow, { key: ticket.id, batch: detail, ticket, onChanged: load }))
      }

      if (detail !== null && (detail.tickets ?? []).length === 0) {
        children.push(h('div', { key: 'empty', style: { fontSize: 13, opacity: 0.62 } },
          '设计还没拆成工单。在对话里继续盘问，收敛后再 design_split。'))
      }

      if (detail?.status === 'converged') {
        children.push(h('button', {
          key: 'approve',
          onClick: approve,
          style: {
            alignSelf: 'flex-start', marginTop: 6, padding: '6px 14px', borderRadius: 8,
            border: '1px solid transparent', background: '#16a34a', color: '#fff',
            cursor: 'pointer', fontSize: 13,
          },
        }, '批准这份设计'))
      }

      return h('div', {
        style: {
          border: '1px solid rgba(127,127,127,.28)', borderRadius: 10,
          padding: 14, display: 'flex', flexDirection: 'column', gap: 6,
        },
      }, children)
    }

    /** 中台页。 */
    function MiddlemanPage() {
      const [state, setState] = React.useState({ loading: true, batches: [] })

      const refresh = React.useCallback(async () => {
        const result = await api('/state')
        setState({ loading: false, batches: result.ok === true ? (result.batches ?? []) : [], error: result.error })
      }, [])

      React.useEffect(() => { void refresh() }, [refresh])

      const body = []
      if (state.loading) {
        body.push(h('div', { key: 'loading', style: { opacity: 0.62 } }, '读取中…'))
      } else if (state.error !== undefined) {
        body.push(h('div', { key: 'err', style: { color: '#dc2626' } }, state.error))
      } else if (state.batches.length === 0) {
        body.push(h('div', { key: 'empty', style: { opacity: 0.62 } },
          '还没有设计批次。在对话里说「开个设计批次」，模型会调 design_open。'))
      } else {
        for (const row of state.batches) {
          body.push(h(BatchCard, { key: row.id, row, onChanged: refresh }))
        }
      }

      return h('div', {
        style: {
          display: 'flex', flexDirection: 'column', gap: 16, padding: 20,
          fontSize: 14, lineHeight: 1.6, height: '100%', overflowY: 'auto',
        },
      }, [
        h('h1', { key: 'title', style: { fontSize: 20, fontWeight: 600, margin: 0 } }, '中台'),
        h('div', { key: 'hint', style: { opacity: 0.62 } },
          '设计批次 → 工单 → 挂起的子会话。点「执行」才真正开始，点之前不花额度。'),
        ...body,
      ])
    }

    /** 侧边栏图标。 */
    function MiddlemanIcon(props) {
      const size = props?.size ?? 16
      return h('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', 'data-dsh-panel-entry': PANEL_ID,
      }, [
        h('rect', { key: 'a', x: 1.6, y: 2.2, width: 5, height: 3.4, rx: 0.9 }),
        h('rect', { key: 'b', x: 1.6, y: 10.4, width: 5, height: 3.4, rx: 0.9 }),
        h('rect', { key: 'c', x: 9.4, y: 6.3, width: 5, height: 3.4, rx: 0.9 }),
        h('path', { key: 'd', d: 'M6.6 3.9h1.3v4.1h1.5' }),
        h('path', { key: 'e', d: 'M6.6 12.1h1.3V8h1.5' }),
      ])
    }

    /**
     * 一行「项目 / 内容」。
     *
     * 内容里可能有 `code` 片段（工单路径、命令），用等宽字体单独渲染，
     * 免得和正文混在一起看不出边界。
     */
    function FieldRow(props) {
      const { label, value } = props
      if (value === undefined || value === null || value === '') return null
      return h('tr', null, [
        h('td', {
          key: 'k',
          style: { verticalAlign: 'top', padding: '6px 12px 6px 0', whiteSpace: 'nowrap', opacity: 0.7, width: 120 },
        }, label),
        h('td', { key: 'v', style: { verticalAlign: 'top', padding: '6px 0', wordBreak: 'break-word' } },
          String(value).split('\n').map((line, index) => h('div', {
            key: 'i' + index,
            style: /[/\\]|\s--|\s[a-z-]+ \S/.test(line) && line.trim() !== ''
              ? { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, background: 'rgba(127,127,127,.12)', borderRadius: 4, padding: '1px 5px', display: 'inline-block', margin: '1px 0' }
              : undefined,
          }, line))),
      ])
    }

    /**
     * 对话流里的派发卡片。
     *
     * dispatch_task 的结果不该只躺在中台页面里：它在对话里被调用，卡片就该
     * 出现在调用它的那条消息下面，带「执行」按钮。这样你不用离开对话就能放行。
     *
     * 版式照着一张 Claude Code 的工单确认卡：一张两列表格说清「发什么、
     * 用哪个模型、什么强度」，下面一条提示说清「开始前做什么、什么顺序、
     * 什么能并行」，最后是执行与修改意见两个按钮。
     *
     * 判断层在 lib/card-model.js，那里有单测：三个阶段的参数来源不同
     *（start 读 block.argsRaw，result 读 block.call.argsRaw），写错一次
     * 就是整张卡空白。
     */
    function DispatchCard(props) {
      const { phase, block } = props
      const [state, setState] = React.useState({ loading: true })

      const { batchId, ticketId } = cardModel.argsOf(phase, block)

      const load = React.useCallback(async () => {
        if (batchId === undefined) {
          setState({ loading: false, missing: true })
          return
        }
        const result = await api('/state?batchId=' + encodeURIComponent(batchId))
        if (result.ok !== true) {
          setState({ loading: false, error: result.error ?? '读不到批次' })
          return
        }
        const ticket = (result.batch?.tickets ?? []).find((candidate) => candidate.id === ticketId)
        setState({ loading: false, ticket })
      }, [batchId, ticketId])

      React.useEffect(() => { void load() }, [load])

      const act = async (path, body) => {
        const result = await api(path, body)
        if (result.ok !== true) alert(result.error ?? '操作失败')
        await load()
      }

      const shell = (children) => h('div', {
        style: {
          border: '1px solid rgba(127,127,127,.3)', borderRadius: 12,
          padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12,
          fontSize: 14, lineHeight: 1.6, background: 'rgba(127,127,127,.04)',
        },
      }, children)

      // 参数还没到：先给个占位，别闪一下空白。
      if (phase === 'preparing') {
        return shell([h('span', { key: 'p', style: { opacity: 0.7 } }, '准备派发…')])
      }
      if (state.missing) return shell([h('span', { key: 'm', style: { opacity: 0.7 } }, '派发卡片：缺少批次信息')])
      if (state.loading) return shell([h('span', { key: 'l', style: { opacity: 0.7 } }, '读取工单…')])
      if (state.error !== undefined) return shell([h('span', { key: 'e', style: { color: '#dc2626' } }, state.error)])

      const view = cardModel.ticketView(state.ticket)
      if (view.kind === 'missing') {
        return shell([h('span', { key: 'n', style: { opacity: 0.7 } }, '工单 ' + String(ticketId) + ' 不在批次里')])
      }

      const buttons = view.buttons.map((button) => {
        if (button.kind === 'run') {
          return h('button', {
            key: 'run',
            onClick: () => act('/run', { batchId, ticketId }),
            style: {
              padding: '7px 16px', borderRadius: 8, border: '1px solid transparent',
              background: '#111827', color: '#fff', cursor: 'pointer', fontSize: 13,
            },
          }, button.label)
        }
        if (button.kind === 'feedback') {
          return h('button', {
            key: 'feedback',
            onClick: () => {
              const reply = window.prompt('要改什么？写清楚，我会转给主会话。')
              if (reply !== null && reply.trim() !== '') {
                void act('/feedback', { batchId, ticketId, message: reply.trim() })
              }
            },
            style: {
              padding: '7px 16px', borderRadius: 8, border: '1px solid rgba(127,127,127,.4)',
              background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 13,
            },
          }, button.label)
        }
        return h('span', { key: 'wait', style: { opacity: 0.65, fontSize: 13 } }, button.label)
      })

      return shell([
        h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, [
          h('strong', { key: 't' }, view.title),
          badge(view.status),
        ]),
        view.fields.length > 0
          ? h('table', {
            key: 'table',
            style: { borderCollapse: 'collapse', width: '100%', fontSize: 13 },
          }, view.fields.map(([label, value]) => h(FieldRow, { key: label, label, value })))
          : null,
        view.hints.length > 0
          ? h('div', {
            key: 'hints',
            style: {
              border: '1px solid rgba(127,127,127,.22)', borderRadius: 10,
              padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4,
              fontSize: 12.5, opacity: 0.9,
            },
          }, view.hints.map(([label, value], index) => h('div', { key: 'h' + index }, [
            h('span', { key: 'l', style: { opacity: 0.65 } }, label + '：'),
            h('span', { key: 'v' }, value),
          ])))
          : null,
        h('div', { key: 'act', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, buttons),
      ])
    }

    /** 装侧边栏行与主栏页面。 */
    function apply(ctx) {
      const slots = ctx.slots
      if (slots === undefined) return

      // 直接调用 slots.inject，不包 ctx.effect：inject 本身返回 disposer，
      // 而它注册的是浏览器侧的占位，与宿主 fiber 无关。包一层会让主栏那个
      // key 注册不上，点开是空面板。
      slots.inject('sidebar.panellist', () => slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: PANEL_ORDER,
        label: () => '中台',
      }, MiddlemanIcon))

      // 对话流里的派发卡片：key 就是工具名，宿主按它把结果行交给这个组件。
      // 注册形状跟官方的 ui-skill 一样：只要 name / key / locale。
      slots.inject('tool.call.toolview', () => slots.register({
        name: 'tool.call.toolview',
        key: 'dispatch_task',
      }, DispatchCard))

      slots.inject('main', () => slots.register({
        name: 'main',
        key: PANEL_ID,
        // 主栏每个占位都要声明 inject：壳把它的返回值当 props 交给组件。
        inject: () => ({}),
      }, MiddlemanPage))
    }

    return { name: 'dsh-middleman', inject: ['slots'], apply }
  },
})