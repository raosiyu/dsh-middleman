/**
 * 从源码里扫出「闸门」——清单不手写，扫出来。
 *
 * 为什么要有这一层：`scripts/gates/manifest.mjs` 是一份手工冻结的闸门清单。
 * 手写的清单迟早会跟代码漂：有人删掉一道闸门（比如把收敛里那条「还有 N 个
 * 决定没定」叉掉、把观察器里那道 waiting 闸移除），自检照着一份没人改过的
 * 清单跑，于是全绿——而闸门其实已经没了。
 *
 * 所以对账是**双向**的：
 * - 清单里登记的每一道，源码里必须还能扫到（扫不到 = 闸门被删了）；
 * - 源码里扫到的每一道，清单里必须登记过（没登记 = 新闸门没人盯）。
 *
 * 这一层只负责「扫」，不判断对错；判断在 `scripts/check.mjs`。
 *
 * 扫描口径都是**结构性**的：找 `problems.push(` 调用、找对象的键、找
 * `refuse(res, 409, 'not-waiting'` 这样的调用点。所以注释被改写不算漂，
 * 判据被删才算漂——正好是我们要区分的两件事。
 *
 * @module dsh-whale-tail/scripts/gates/inventory
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

/** 仓库根目录。 */
export const ROOT = new URL('../../', import.meta.url)

/**
 * 读一份源码。
 * @param relative - 相对仓库根的路径，如 lib/core.js。
 * @returns {string} 源码全文。
 */
export function read(relative) {
  return readFileSync(new URL(relative, ROOT), 'utf8')
}

/**
 * 把注释抹成空格——**长度与换行保持不变**。
 *
 * 为什么要保持长度：后面所有 offset 都靠它对回原文，抹短了就对不上了。
 *
 * @param source - 源码。
 * @returns {string} 同样长度的、没有注释的源码。
 */
export function blankComments(source) {
  let out = ''
  let i = 0
  while (i < source.length) {
    const char = source[i]
    const next = source[i + 1]
    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') { out += ' '; i += 1 }
      continue
    }
    if (char === '/' && next === '*') {
      out += '  '
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' '
        i += 1
      }
      if (i < source.length) { out += '  '; i += 2 }
      continue
    }
    // 字符串原样保留：判据就在字符串里，抹了就没得扫了。
    if (char === "'" || char === '"' || char === '`') {
      const quote = char
      out += char
      i += 1
      while (i < source.length) {
        if (source[i] === '\\') { out += source[i] + (source[i + 1] ?? ''); i += 2; continue }
        out += source[i]
        if (source[i] === quote) { i += 1; break }
        i += 1
      }
      continue
    }
    out += char
    i += 1
  }
  return out
}

/**
 * 从 `(` 或 `{` 的位置往右找配对的收尾，返回中间那段的起止 offset。
 *
 * 跳过字符串，所以字符串里的括号不会打乱层级。
 *
 * @param source - 源码（注释已抹）。
 * @param openAt - 开括号的 offset。
 * @returns {{ start: number, end: number }} 中间内容的区间；找不到时 end 为 -1。
 */
function balanced(source, openAt) {
  let depth = 0
  let i = openAt
  while (i < source.length) {
    const char = source[i]
    if (char === "'" || char === '"' || char === '`') {
      const quote = char
      i += 1
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue }
        if (source[i] === quote) break
        i += 1
      }
      i += 1
      continue
    }
    if (char === '(' || char === '{' || char === '[') depth += 1
    else if (char === ')' || char === '}' || char === ']') {
      depth -= 1
      if (depth === 0) return { start: openAt + 1, end: i }
    }
    i += 1
  }
  return { start: openAt + 1, end: -1 }
}

/**
 * 取一个 `export function name(...) { ... }` 的函数体。
 * @param source - 源码（注释已抹）。
 * @param name - 函数名。
 * @returns {string | undefined} 函数体；没有这个函数时是 undefined。
 */
export function functionBody(source, name) {
  const head = new RegExp('export function ' + name + '\\s*\\(', 'g').exec(source)
  if (head === null) return undefined
  const params = balanced(source, head.index + head[0].length - 1)
  if (params.end < 0) return undefined
  const openBrace = source.indexOf('{', params.end)
  if (openBrace < 0) return undefined
  const body = balanced(source, openBrace)
  if (body.end < 0) return undefined
  return source.slice(body.start, body.end)
}

/**
 * 中文判据的标签：取第一个含中文字符的字符串字面量。
 *
 * 为什么用中文而非行号：行号一动就漂，而那跟闸门在不在无关。中文判据是
 * 人写字的地方，改措辞是真改动，值得报出来。
 *
 * @param text - 表达式原文。
 * @returns {string | undefined} 标签。
 */
function labelOf(text) {
  const literals = [...text.matchAll(/'([^'\\]*)'/g)].map((match) => match[1])
  const cjk = literals.filter((value) => /[\u4e00-\u9fff]/.test(value))
  // 把这条判据的所有中文字面量接起来当标签：「还有 」+「 个决定没定：」这样
  // 拼出来才是人能读的一句，单取第一个只会得到半句。
  if (cjk.length > 0) {
    return cjk.join('').replace(/\s+/g, ' ').trim().replace(/[：:、,，。]$/, '')
  }
  // 没有中文字面量：多半是把变量 push 进去（如 `gap`）。
  const bare = text.trim()
  if (/^[A-Za-z_$][\w$]*$/.test(bare)) return '@' + bare
  return literals.find((value) => value.trim() !== '')?.trim()
}

/**
 * 扫一个函数里所有 `problems.push(...)` 调用点。
 *
 * 这就是「闸门」的骨架：每一处 push 都是一条会拒绝人的判据。
 *
 * @param source - 源码（注释已抹）。
 * @param name - 函数名。
 * @returns {Array<{ fn: string, label: string, text: string }>} 调用点。
 */
export function pushSites(source, name) {
  const body = functionBody(source, name)
  if (body === undefined) return []
  const sites = []
  const pattern = /problems\.push\(/g
  let match
  while ((match = pattern.exec(body)) !== null) {
    const openAt = match.index + match[0].length - 1
    const arg = balanced(body, openAt)
    if (arg.end < 0) continue
    const text = body.slice(arg.start, arg.end).replace(/\s+/g, ' ').trim()
    // 转发式调用（...riskProblems(...)）不是本函数的判据，是别人的。
    // 这里跳过：那道闸门由被转发的那个函数自己登记，重复登记会让
    // 「删掉一道闸门」在清单里对不上两条。
    if (/^\.\.\./.test(text)) continue
    const label = labelOf(text)
    sites.push({ fn: name, label: label ?? text.slice(0, 24), text })
  }
  return sites
}

/**
 * 扫 `export const NAME = { a: 'a', ... }` 这种常量对象的键。
 * @param source - 源码（注释已抹）。
 * @param name - 常量名。
 * @returns {string[]} 键名。
 */
export function objectKeys(source, name) {
  const head = new RegExp('export const ' + name + '\\s*=\\s*\\{').exec(source)
  if (head === null) return []
  const body = balanced(source, head.index + head[0].length - 1)
  if (body.end < 0) return []
  const inner = source.slice(body.start, body.end)
  const keys = []
  for (const match of inner.matchAll(/(?:^|,|\{)\s*([A-Za-z_$][\w$]*)\s*:/g)) keys.push(match[1])
  return keys
}

/**
 * 扫一个函数体里对某个枚举的所有引用，如 `TICKET_STATUS.done`。
 * @param source - 源码（注释已抹）。
 * @param name - 函数名。
 * @param enumName - 枚举名。
 * @returns {string[]} 引用到的键名。
 */
export function enumRefs(source, name, enumName) {
  const body = functionBody(source, name)
  if (body === undefined) return []
  const refs = []
  for (const match of body.matchAll(new RegExp(enumName + '\\.([A-Za-z_$][\\w$]*)', 'g'))) refs.push(match[1])
  return refs
}

/**
 * 扫 `export const RISK_FIELDS = [[a, b], ...]` 的字段对。
 * @param source - 源码（注释已抹）。
 * @returns {Array<[string, string]>} 字段名与中文名。
 */
export function riskFields(source) {
  const head = /export const RISK_FIELDS\s*=\s*\[/.exec(source)
  if (head === null) return []
  const body = balanced(source, head.index + head[0].length - 1)
  if (body.end < 0) return []
  const inner = source.slice(body.start, body.end)
  const pairs = []
  for (const match of inner.matchAll(/\[\s*'([^']+)'\s*,\s*'([^']+)'\s*\]/g)) pairs.push([match[1], match[2]])
  return pairs
}

/**
 * 找出源码里每个 offset 落在哪个「命名的块」里——路由处理器或具名函数。
 *
 * 为什么要这个：`refuse(res, 404, 'ticket-missing'` 在 routes.js 里出现了
 * 五次。只按机器码编号，同一段代码里五条判据会塌成一条 id，于是删掉其中
 * 一条也看不出来（id 还在，只是少了一条）。有了块名，id 变成
 * `routes.js#refuse:run/ticket-missing`，五条各自独立。
 *
 * @param source - 源码（注释已抹）。
 * @returns {Array<{ name: string, start: number, end: number }>} 块区间，按开始位置排序。
 */
export function blocks(source) {
  const found = []

  // 路由处理器：route('exact', API_PREFIX + '/run', async (req, res) => { ... })
  // 名字取路径最后一段。
  const routePattern = /route\(\s*'[^']*'\s*,\s*API_PREFIX\s*\+\s*'([^']+)'[^,]*,\s*async\s*\([^)]*\)\s*=>\s*\{/g
  let match
  while ((match = routePattern.exec(source)) !== null) {
    const openAt = match.index + match[0].length - 1
    const body = balanced(source, openAt)
    if (body.end < 0) continue
    found.push({ name: match[1].replace(/^\//, ''), start: body.start, end: body.end })
  }

  // 具名函数：export function name(...) { ... } 与 function name(...) { ... }
  const fnPattern = /(?:export\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g
  while ((match = fnPattern.exec(source)) !== null) {
    const paramsAt = match.index + match[0].length - 1
    const params = balanced(source, paramsAt)
    if (params.end < 0) continue
    const openBrace = source.indexOf('{', params.end)
    if (openBrace < 0) continue
    const body = balanced(source, openBrace)
    if (body.end < 0) continue
    found.push({ name: match[1], start: body.start, end: body.end })
  }

  // 数组字面量里那些没有名字的箭头块——tools.js 就是这种形状：
  //   [{ name: 'design_answer', ..., async execute(args) { ... } }, { ... }]
  //
  // 每个对象都叫 `name: '<工具名>'`，所以以它开头的那段就是「这个工具的块」。
  // 没有这一层，tools.js 里二十来条拒绝全都落在 buildTools 这一个块里，
  // 同一机器码出现两次就塌成一条 id。
  const toolPattern = /name:\s*'([A-Za-z_$][\w$]*)'\s*,/g
  while ((match = toolPattern.exec(source)) !== null) {
    const openBrace = source.lastIndexOf('{', match.index)
    if (openBrace < 0) continue
    const body = balanced(source, openBrace)
    if (body.end < 0) continue
    found.push({ name: match[1], start: body.start, end: body.end })
  }

  // 内层块排前面：同一个 offset 落在两层里时，取最内层的那个名字。
  found.sort((a, b) => (a.end - a.start) - (b.end - b.start))
  return found
}

/**
 * 一个 offset 属于哪个块。
 * @param blocks - blocks() 的结果。
 * @param offset - 位置。
 * @returns {string} 块名；不在任何块里时是 '<top>'。
 */
export function blockAt(blocks, offset) {
  for (const block of blocks) {
    if (offset > block.start && offset < block.end) return block.name
  }
  return '<top>'
}

/**
 * 扫 `refuse(res, <状态码>, '<机器码>'` 调用点。
 *
 * 状态码写死在这里，跟 `statusForCode` 的映射表是两份东西——它们会漂。
 * 每条带上它所在的块名，好让同一个机器码的五个调用点各算一道闸门。
 *
 * @param source - 源码（注释已抹）。
 * @returns {Array<{ block: string, status: number | string, code: string }>} 调用点。
 */
export function refuseSites(source) {
  const sites = []
  const table = blocks(source)
  for (const match of source.matchAll(/refuse\(\s*res\s*,\s*([^,]+?)\s*,\s*'([^']+)'/g)) {
    const status = match[1].trim()
    sites.push({
      block: blockAt(table, match.index),
      status: /^\d+$/.test(status) ? Number(status) : status,
      code: match[2],
      phrase: refusalLabel(source, match.index) ?? match[2],
    })
  }
  return sites
}

/**
 * 取一个拒绝调用之后那段参数里，第一个能当标签的中文串。
 *
 * 为什么需要：同一段代码里两条 `invalid-request` 是两道闸门——「risk 与
 * decisionId 只能给一个」和「risk 得是一个对象」拦的不是同一件事。只按
 * 机器码编号，删掉其中一条时 id 还在（另一条撑着的），清单对账看不见。
 *
 * 标签取的是**判据的措辞**，所以改措辞会报漂——这是有意的：改措辞就是
 * 改了拒绝时要说什么，值得人看一眼。
 *
 * @param source - 源码（注释已抹）。
 * @param from - 拒绝调用的起止位置：从 `refusal(` 或 `new MiddlemanError(` 的开头算。
 * @returns {string | undefined} 标签。
 */
function refusalLabel(source, from) {
  const open = source.indexOf('(', from)
  if (open < 0) return undefined
  const arg = balanced(source, open)
  if (arg.end < 0) return undefined
  const inner = source.slice(arg.start, arg.end)
  // 多行数组形式：refusal('invalid-request', [ '第一句', ... ])
  const literals = [...inner.matchAll(/'([^'\\]*)'/g)].map((match) => match[1])
  // 第一个字面量是机器码本身，跳过；往后找第一个含中文的。
  const cjk = literals.slice(1).find((value) => /[\u4e00-\u9fff]/.test(value))
  if (cjk !== undefined) return cjk.trim().slice(0, 40)
  return undefined
}

/**
 * 扫本插件自造的拒绝码：`refusal('code'` 与 `new MiddlemanError('code'`。
 *
 * 每条带两个身份：所在的块名 + 拒绝时的中文措辞。两个都要，因为块名会
 * 在同一个处理器里重复（design_answer 有六条 invalid-request），而措辞
 * 能让它们各算一道闸门。
 *
 * @param source - 源码（注释已抹）。
 * @returns {Array<{ block: string, kind: string, code: string, phrase: string }>} 调用点。
 */
export function refusalCodes(source) {
  const found = []
  const table = blocks(source)
  for (const match of source.matchAll(/refusal\(\s*'([^']+)'/g)) {
    found.push({
      block: blockAt(table, match.index),
      kind: 'refusal',
      code: match[1],
      phrase: refusalLabel(source, match.index) ?? match[1],
    })
  }
  for (const match of source.matchAll(/new MiddlemanError\(\s*'([^']+)'/g)) {
    found.push({
      block: blockAt(table, match.index),
      kind: 'error',
      code: match[1],
      phrase: refusalLabel(source, match.index) ?? match[1],
    })
  }
  return found
}

/** lib/core.js 里会拒绝人的那几个纯规则函数——每一个的每一条 push 都是一道闸门。 */
export const CORE_GATE_FUNCTIONS = [
  'convergeProblems',
  'designGateProblems',
  'dispatchProblems',
  'approveProblems',
  'riskProblems',
  'dependencyProblems',
]

/**
 * 扫 `switch (code) { case 'x': ... }` 里所有 case 标签。
 *
 * refusals.js 的 statusForCode 就是这种形状：它把拒绝码映射到 HTTP 状态码。
 * 这张表跟 routes.js 里写死的状态码是两份东西，会漂——所以它也被当成闸门扫。
 *
 * @param source - 源码（注释已抹）。
 * @returns {string[]} case 标签。
 */
export function switchCases(source) {
  const found = []
  for (const match of source.matchAll(/case\s+'([^']+)'\s*:/g)) found.push(match[1])
  return found
}

/**
 * 扫出全部闸门锚点。
 *
 * 每个锚点带一个稳定 id——`<文件>#<类别>:<键>`。probe 用这个 id 说明
 * 「我盯的是哪一道」，清单用这个 id 登记，对账靠它。
 *
 * @returns {Array<{ id: string, file: string, kind: string, label: string, detail: string }>} 锚点。
 */
export function scanAnchors() {
  const anchors = []
  const add = (file, kind, label, detail = '') => {
    anchors.push({ id: file + '#' + kind + ':' + label, file, kind, label, detail })
  }

  const core = blankComments(read('lib/core.js'))
  for (const fn of CORE_GATE_FUNCTIONS) {
    const sites = pushSites(core, fn)
    if (sites.length === 0) add('lib/core.js', 'missing-function', fn, '整个函数都不见了')
    for (const site of sites) add('lib/core.js', 'push', fn + '/' + site.label, site.text)
  }

  for (const key of objectKeys(core, 'TICKET_STATUS')) add('lib/core.js', 'status', key)

  const terminal = enumRefs(core, 'isTerminalStatus', 'TICKET_STATUS')
  if (terminal.length === 0) add('lib/core.js', 'missing-function', 'isTerminalStatus', '整个函数都不见了')
  for (const key of terminal) add('lib/core.js', 'terminal', key)

  const fields = riskFields(core)
  if (fields.length === 0) add('lib/core.js', 'missing-function', 'RISK_FIELDS', '四栏定义不见了')
  for (const [field, label] of fields) add('lib/core.js', 'risk-field', field, label)

  const refusalsSource = blankComments(read('lib/refusals.js'))
  const routes = blankComments(read('lib/routes.js'))
  for (const site of refuseSites(routes)) add('lib/routes.js', 'refuse', site.block + '/' + site.code + '/' + site.phrase, 'status ' + site.status + ' ' + site.phrase)

  // refusals.js 里没有「调用点」，只有 statusForCode 那张 switch 表。
  // 那张表也是一道闸门（它决定每个拒绝码回什么 HTTP 状态码），所以要按
  // case 分支扫出来，而不是找 refusal() 调用。
  for (const code of switchCases(refusalsSource)) add('lib/refusals.js', 'status-code', code)

  const tools = blankComments(read('lib/tools.js'))
  for (const entry of refusalCodes(tools)) add('lib/tools.js', entry.kind, entry.block + '/' + entry.code + '/' + entry.phrase, entry.phrase)

  const dispatch = blankComments(read('lib/dispatch.js'))
  for (const entry of refusalCodes(dispatch)) add('lib/dispatch.js', entry.kind, entry.block + '/' + entry.code + '/' + entry.phrase, entry.phrase)

  const observer = blankComments(read('lib/observer.js'))
  for (const anchor of OBSERVER_ANCHORS) {
    if (!observer.includes(anchor.text)) add('lib/observer.js', 'missing-judgment', anchor.id, anchor.text)
    else add('lib/observer.js', 'judgment', anchor.id, anchor.text)
  }

  return anchors
}

/**
 * 观察器里必须原样存在的判据。
 *
 * 这些是「静默」的闸门：正常工作时一句话都不说，所以只能靠判据原文盯住。
 * 改注释不算漂；这段判据被删掉就是事故。
 */
export const OBSERVER_ANCHORS = [
  { id: 'unstarted-gate', text: "ticket.status === 'pending' || ticket.status === 'suspended'" },
  { id: 'waiting-gate', text: "ticket.status === 'waiting' || ticket.waiting !== undefined" },
  { id: 'dedupe-gate', text: 'ticket.reportedTurn !== undefined && ticket.reportedTurn === turn' },
  { id: 'unknown-session-gate', text: 'if (hit === undefined) return' },
]

/**
 * 把锚点集合折成 id → 锚点 的映射。
 * @param anchors - 锚点列表。
 * @returns {Map<string, object>} 映射。
 */
export function indexById(anchors) {
  const index = new Map()
  for (const anchor of anchors) {
    if (index.has(anchor.id)) {
      // 同一个 id 出现两次说明扫描口径有歧义（比如同一函数里两条 push 用了
      // 同样的中文标签）。这会静默吞掉一道闸门，所以直接炸。
      throw new Error('扫描出的锚点 id 重复：' + anchor.id + '——两条判据用了同一个标签，清单没法区分它们')
    }
    index.set(anchor.id, anchor)
  }
  return index
}

/**
 * 给一个锚点配一句人话（清单里给人和模型读）。
 * @param anchor - 锚点。
 * @returns {string} 描述。
 */
export function describe(anchor) {
  const name = basename(anchor.file)
  switch (anchor.kind) {
    case 'push': return name + ' 的一条拒绝：' + anchor.label
    case 'status': return name + ' 的工单状态 TICKET_STATUS.' + anchor.label
    case 'terminal': return name + ' 把 ' + anchor.label + ' 当作终态'
    case 'risk-field': return name + ' 的风险栏位 ' + anchor.label + '（' + anchor.detail + '）'
    case 'refuse': return name + ' 的拒绝 ' + anchor.label + '（' + anchor.detail + '）'
    case 'judgment': return name + ' 的判据：' + anchor.detail
    case 'missing-function':
    case 'missing-judgment': return name + ' 缺了：' + anchor.label
    default: return name + ' 的拒绝码 ' + anchor.label + '（' + anchor.kind + '）'
  }
}
