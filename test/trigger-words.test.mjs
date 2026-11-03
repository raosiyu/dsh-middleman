/**
 * 触发词不许被悄悄删掉。
 *
 * 插件是「装了但不知道从哪开始」最容易坏在文档上的东西：README 写了
 * 触发词，提示段里却漏了，用户说一句「派个子任务」，模型根本不知道
 * 有这个面在。
 *
 * 所以这里把三处必须对齐的地方钉住：
 *   1. 提示段里必须出现全部触发词；
 *   2. 提示段必须说清「什么时候该用、什么时候不该用」——
 *      只有正向指令的话，模型会为了用而用；
 *   3. 工具描述里的触发词必须与提示段一致，不许各说各的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PROMPT_TEXT } from '../lib/index.js'
import { buildTools } from '../lib/tools.js'

/**
 * 触发词全集。
 *
 * 前五个是提示段末尾那句的权威列表；后面几个是各工具 description 里
 * 自己带的那份——它们也是触发词，只是没进那句总表。两边必须一致，
 * 不然模型从工具表认出的词，提示段却没提。
 */
const TRIGGERS = [
  '中台', '设计批次', '派发子任务', '盘问', '流程规划',
  '开个设计', '提问', '怎么分工',
]

test('提示段里每个触发词都在', () => {
  for (const word of TRIGGERS) {
    assert.ok(PROMPT_TEXT.includes(word), '提示段里没有触发词：' + word)
  }
})

test('提示段说明了什么时候该用、什么时候不该用', () => {
  // 只有正向指令的话，模型会为了用而用——问个问题也开批次。
  assert.ok(PROMPT_TEXT.includes('什么时候该用它'), '提示段没说何时该用')
  assert.match(PROMPT_TEXT, /不要自己直接动手|不要开批次/, '提示段没说不该用的时候')
})

test('工具描述里的触发词与提示段一致', () => {
  const tools = buildTools({ warn() {}, testFiles: async () => [] })
  const descriptions = tools.map((tool) => tool.description).join('\n')

  // 每条带触发词的工具，词都得是全集里的。
  for (const match of descriptions.matchAll(/中文触发词：([^。]+)。/g)) {
    const words = match[1].split('/').map((w) => w.trim()).filter(Boolean)
    for (const word of words) {
      assert.ok(
        TRIGGERS.includes(word),
        '工具描述里的触发词「' + word + '」不在提示段的权威列表里：' + TRIGGERS.join(' / '),
      )
    }
  }
})

test('提示段里列出的流程步骤与真实工具名对得上', () => {
  const tools = buildTools({ warn() {}, testFiles: async () => [] })
  const names = new Set(tools.map((tool) => tool.name))

  // 提示段里出现的工具名必须真的存在——写错名字等于叫模型去调不存在的东西。
  for (const match of PROMPT_TEXT.matchAll(/\b(design_\w+|dispatch_task|middleman_status)\b/g)) {
    assert.ok(names.has(match[1]), '提示段里提到不存在的工具：' + match[1])
  }
})
