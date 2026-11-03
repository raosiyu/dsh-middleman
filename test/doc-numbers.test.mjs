/**
 * 文档里的数字必须跟实际对得上。
 *
 * 这是踩过的坑：工单上写「共 32 条断言」，实际 34 条——数字是手写的，
 * 加了两条测试就漂了，而没有任何东西盯着它。手写数字必然漂。
 *
 * 做法：数 test/ 下所有顶层 `test(` 的个数，再跟 README / USAGE 里写的
 * 「N 个用例」比。
 *
 * 为什么静态数而不是起子进程跑一遍：子进程在 node --test 里会继承
 * NODE_TEST_CONTEXT，stdout 的报告协议就变了，拿不到 `# tests N` 那行。
 * 静态数没有这个问题，也更快。实测静态数与跑出来的数一致——下面的
 * 第二条测试把这个前提也钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 数 test/ 下所有顶层 test( 的个数——**不含本文件**。
 *
 * 为什么排除自己：这是个自指问题。检查器自己也是用例，它写几条就会
 * 改变它要检查的那个数字，于是永远追不上（第一次写成 176，加上检查器
 * 就变 177，再修又变 178……）。
 *
 * 排除自己之后，文档里那个数指的是「功能用例数」，加本文件的用例
 * 不会让它漂。
 */
function countTests() {
  const dir = join(root, 'test')
  let total = 0
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.test.mjs')) continue
    if (name === 'doc-numbers.test.mjs') continue
    const text = readFileSync(join(dir, name), 'utf8')
    // 只数行首的 test( —— 那才是顶层用例；嵌套的 t.test( 不算。
    // 注释里的 test( 行首带 " * " 之类，不会命中 ^test\(。
    total += (text.match(/^test\(/gm) ?? []).length
  }
  return total
}

test('README 与 USAGE 里写的用例数与实际一致', () => {
  const actual = countTests()
  assert.ok(actual > 0, '一个用例都没数到，正则或目录有问题')

  for (const file of ['README.md', 'USAGE.md']) {
    const text = readFileSync(join(root, file), 'utf8')
    const claimed = [...text.matchAll(/(\d+) 个用例/g)].map((m) => Number(m[1]))
    assert.ok(claimed.length > 0, file + ' 里没写用例数')
    for (const number of claimed) {
      assert.equal(
        number,
        actual,
        file + ' 说 ' + number + ' 个用例，实际 ' + actual + ' 个——手写的数字漂了，改成实际值',
      )
    }
  }
})

test('静态数用例的前提仍然成立（没人用 describe）', () => {
  // 上一条测试只有在「静态数 == 真跑出来的数」时才可信。
  // describe( 会额外起子测试，静态数就数不到——那时该换算法，
  // 而不是让文档对账静默失真。
  const dir = join(root, 'test')
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.test.mjs')) continue
    const text = readFileSync(join(dir, name), 'utf8')
    assert.equal(
      /^describe\(/m.test(text),
      false,
      name + ' 用了 describe()——静态数用例的算法要改，否则文档对账会失真',
    )
  }
})

test('AUDIT.md 里写的总条数与清单实际条目数一致', () => {
  // AUDIT.md 说「一共 31 条」，附录清单里就得更真的是 31 条。
  // 同一类病：手写的数字会漂。这份文档本身就是讲这件事的，
  // 它自己更不该漂。
  const text = readFileSync(join(root, 'AUDIT.md'), 'utf8')

  // 文档里声明总数的地方：「一共找出 **N 条**」
  const claim = text.match(/一共找出 \*\*(\d+) 条\*\*/)
  assert.ok(claim !== null, 'AUDIT.md 里没找到「一共找出 N 条」这句声明')
  const declared = Number(claim[1])

  // 清单实际条目：附录里所有行首的 "N. "
  const appendix = text.split('## 附：31 条清单')[1]
  assert.ok(appendix !== undefined, 'AUDIT.md 里没有附录清单')
  const items = (appendix.match(/^\d+\. /gm) ?? []).length

  assert.equal(
    declared,
    items,
    'AUDIT.md 说一共 ' + declared + ' 条，清单里实际 ' + items + ' 条',
  )
})

test('AUDIT.md 每段的条数与段标题里写的一致', () => {
  const text = readFileSync(join(root, 'AUDIT.md'), 'utf8')
  const appendix = text.split('## 附：31 条清单')[1]
  assert.ok(appendix !== undefined)

  // 段标题形如 **第一轮（16 条，核心规则层）**，后面跟 N 条清单项。
  const sections = [...appendix.matchAll(/\*\*第[^*]*?（(\d+) 条[^*]*?\）\*\*([\s\S]*?)(?=\*\*第|$)/g)]
  assert.ok(sections.length > 0, '没解析出任何分段')
  for (const [, claimed, body] of sections) {
    const actual = (body.match(/^\d+\. /gm) ?? []).length
    assert.equal(
      Number(claimed),
      actual,
      '段标题说 ' + claimed + ' 条，该段实际 ' + actual + ' 条',
    )
  }
})
