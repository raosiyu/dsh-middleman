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
