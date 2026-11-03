/**
 * 找出项目仓库里有哪些测试文件。
 *
 * 存在的理由：风险的「怎么验证」这一栏是模型自己写的，写「单测：…」很容易，
 * 写了不等于有。真出过一条：验证方式写着「单测：不传 batchId 断言抛错且不建
 * 会话」，仓库里根本没有这条测试，缓解措施只是写着。
 *
 * 这一层只管「有哪些文件」；「这条承诺有没有兑现」是 core.js 的纯规则。
 *
 * @module dsh-whale-tail/verifyscan
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** 会放测试的目录名。 */
const TEST_DIRS = ['test', 'tests', '__tests__', 'spec']

/** 算测试文件名的后缀。 */
const TEST_SUFFIXES = ['.test.mjs', '.test.js', '.spec.mjs', '.spec.js', '.test.ts', '.spec.ts']

/**
 * 判断一个文件名是不是测试文件。
 * @param name - 文件名。
 * @returns {boolean}
 */
export function isTestFile(name) {
  return TEST_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

/**
 * 扫一个目录，找出测试文件名。
 *
 * 只看一层：测试目录里再套目录是很少见的做法，扫一层已经够用，
 * 而且不会在巨大的目录上白花时间。
 *
 * @param root - 项目根目录。
 * @returns {Promise<string[]>} 测试文件名（不含路径）。
 */
export async function listTestFiles(root) {
  if (typeof root !== 'string' || root === '') return []
  const found = new Set()
  for (const dir of TEST_DIRS) {
    let entries
    try {
      entries = await readdir(join(root, dir), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isFile() && isTestFile(entry.name)) found.add(entry.name)
    }
  }
  return [...found]
}
