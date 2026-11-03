/**
 * 「验证方式承诺了单测，就得真有那条测试」这道闸门。
 *
 * 存在的理由：风险的「怎么验证」是模型自己写的，写「单测：…」很容易，
 * 写了不等于有。真出过一条：验证方式写着「单测：不传 batchId 断言抛错且不建
 * 会话」，仓库里根本没有这条测试，缓解措施只是写着，没被任何东西盯住。
 *
 * 两道关口都盯：
 * - 登记时（design_answer）：承诺的单测不存在就别登记
 * - 派发时（dispatch_task）：登记时放过、后来没写的，这里拦住
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'mm-verify-'))
process.env.WT_HOME = home

const { buildTools } = await import('../lib/tools.js')
const { blankBatch, save } = await import('../lib/ledger.js')
const { listTestFiles, isTestFile } = await import('../lib/verifyscan.js')
const { verificationTestGap } = await import('../lib/core.js')

/** 仓库里现有的测试文件名。 */
const FILES = ['risk-r1.test.mjs', 'observer-report.test.mjs', 'core.test.mjs']

/** 造一个只记 spawn 调用的假派发面。 */
function fakeFaces() {
  const spawns = []
  return {
    spawns,
    faces: {
      dispatcher: {
        async spawn(ticket, options) {
          spawns.push({ ticket, options })
          return { sessionId: 'session-x', model: { provider: 'p', model: 'm' } }
        },
      },
      testFiles: async () => FILES,
      warn() {},
    },
  }
}

/** 取工具面里某个工具的 execute。 */
function toolOf(tools, name) {
  const found = tools.find((tool) => tool.name === name)
  assert.ok(found !== undefined, '工具面里没有 ' + name)
  return found
}

/** 一份四栏齐全的风险草稿。 */
function draft(verification) {
  return {
    title: '测试用风险',
    trigger: '主会话绕过盘问直接派发',
    impact: '子会话白建，额度白花',
    mitigation: '代码里拒绝没有 batchId 的调用',
    verification,
  }
}

// ── 纯规则 ──────────────────────────────────────────────────────────

test('验证方式承诺了单测却没说出是哪个文件 → 有问题', () => {
  const gap = verificationTestGap(
    { id: 'R-1', verification: '单测：不传 batchId 断言抛错且不建会话' },
    FILES,
  )
  assert.notEqual(gap, '', '没点名的单测承诺该被拦下')
  assert.match(gap, /R-1/)
})

test('验证方式说出的测试文件不存在 → 有问题', () => {
  const gap = verificationTestGap(
    { id: 'R-2', verification: '单测：见 test/does-not-exist.test.mjs' },
    FILES,
  )
  assert.notEqual(gap, '')
  assert.match(gap, /does-not-exist/)
})

test('验证方式说出的测试文件存在 → 没问题', () => {
  const gap = verificationTestGap(
    { id: 'R-3', verification: '单测：risk-r1.test.mjs 断言不传 batchId 时抛错' },
    FILES,
  )
  assert.equal(gap, '')
})

test('只写主干名也算命中（risk-r1 指 risk-r1.test.mjs）', () => {
  const gap = verificationTestGap(
    { id: 'R-4', verification: '单测：risk-r1 里断言不传 batchId 时抛错' },
    FILES,
  )
  assert.equal(gap, '')
})

test('验证方式里没有「单测」二字 → 不查（可能是一次性人工验证）', () => {
  const gap = verificationTestGap(
    { id: 'R-5', verification: '这次真跑一遍，看主会话是否收到回报' },
    FILES,
  )
  assert.equal(gap, '')
})

test('人工核对的写法明确被允许', () => {
  const gap = verificationTestGap(
    { id: 'R-6', verification: '人工核对：这次跑一遍看回报内容' },
    FILES,
  )
  assert.equal(gap, '')
})

// ── 登记时的闸门 ────────────────────────────────────────────────────

test('design_answer：承诺了不存在的单测 → 拒绝登记', async () => {
  const { faces } = fakeFaces()
  const tools = buildTools(faces)
  const answer = toolOf(tools, 'design_answer')

  const batch = blankBatch('验证闸门')
  await save(batch)

  const result = await answer.execute({
    batchId: batch.id,
    risk: draft('单测：见 test/phantom.test.mjs'),
  })

  assert.equal(result.ok, false, '承诺了不存在的单测却放行了')
  assert.equal(result.code, 'verification-unbacked')
  assert.match(result.problems[0], /phantom/)
})

test('design_answer：承诺了存在的单测 → 登记成功', async () => {
  const { faces } = fakeFaces()
  const tools = buildTools(faces)
  const answer = toolOf(tools, 'design_answer')

  const batch = blankBatch('验证闸门')
  await save(batch)

  const result = await answer.execute({
    batchId: batch.id,
    risk: draft('单测：risk-r1.test.mjs 断言不传 batchId 时抛错且不建会话'),
  })

  assert.equal(result.ok, true, '真有那条测试却拒绝了：' + JSON.stringify(result))
  assert.equal(result.risk.id, 'R-1')
})

test('design_answer：一次性人工验证 → 登记成功', async () => {
  const { faces } = fakeFaces()
  const tools = buildTools(faces)
  const answer = toolOf(tools, 'design_answer')

  const batch = blankBatch('验证闸门')
  await save(batch)

  const result = await answer.execute({
    batchId: batch.id,
    risk: draft('这次真跑一遍，看主会话是否收到 [子任务回报]'),
  })

  assert.equal(result.ok, true, JSON.stringify(result))
})

// ── 派发时的闸门 ────────────────────────────────────────────────────

test('dispatch_task：风险承诺的单测后来没写 → 拒绝派发', async () => {
  const { faces, spawns } = fakeFaces()
  const tools = buildTools(faces)
  const dispatch = toolOf(tools, 'dispatch_task')

  const batch = blankBatch('派发闸门')
  batch.status = 'approved'
  batch.questions = [
    { question: 'q1', answer: 'a1' },
    { question: 'q2', answer: 'a2' },
    { question: 'q3', answer: 'a3' },
  ]
  batch.plan = { steps: '第一步', output: '一份文件' }
  batch.risks = [{
    id: 'R-1',
    title: '绕过盘问',
    trigger: '不带 batchId 直接派发',
    impact: '额度白花',
    mitigation: '代码里拒绝',
    verification: '单测：见 test/never-written.test.mjs',
  }]
  batch.tickets = [{
    id: 'T-1', title: '票', brief: '干活', blockedBy: [], riskIds: ['R-1'],
    riskFree: false, riskFreeReason: undefined,
    model: { provider: 'p', model: 'm' },
    modelReason: '快',
    source: undefined, payload: undefined, effort: undefined, notes: undefined,
    status: 'pending',
  }]
  await save(batch)

  // 登记时放过了（那时文件还在），后来文件被删了。
  const result = await dispatch.execute({ batchId: batch.id, ticketId: 'T-1' })
  assert.equal(result.ok, false, '承诺的单测没了却还是派发了')
  assert.equal(result.code, 'dispatch-blocked')
  assert.ok(result.problems.some((problem) => problem.includes('never-written')))
  assert.equal(spawns.length, 0, '拒绝派发却还是建了子会话')
})

// ── 扫测试文件 ──────────────────────────────────────────────────────

test('扫测试目录，找得到测试文件名', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mm-repo-'))
  mkdirSync(join(root, 'test'), { recursive: true })
  writeFileSync(join(root, 'test', 'alpha.test.mjs'), '')
  writeFileSync(join(root, 'test', 'beta.mjs'), '')
  writeFileSync(join(root, 'test', 'gamma.spec.js'), '')

  const files = await listTestFiles(root)
  assert.ok(files.includes('alpha.test.mjs'))
  assert.ok(files.includes('gamma.spec.js'))
  assert.ok(!files.includes('beta.mjs'), '不是测试文件就不该算进去')

  rmSync(root, { recursive: true, force: true })
})

test('仓库里没有 test 目录 → 返回空数组，不报错', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mm-empty-'))
  const files = await listTestFiles(root)
  assert.deepEqual(files, [])
  rmSync(root, { recursive: true, force: true })
})

test('测试文件名的判据', () => {
  assert.equal(isTestFile('a.test.mjs'), true)
  assert.equal(isTestFile('a.test.ts'), true)
  assert.equal(isTestFile('a.spec.js'), true)
  assert.equal(isTestFile('a.mjs'), false)
  assert.equal(isTestFile('a.txt'), false)
})

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})
