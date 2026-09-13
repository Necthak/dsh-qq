import { test } from 'node:test'
import assert from 'node:assert/strict'

import { markdownToPlain, splitByBytes, stripInline } from '../lib/md-to-plain.js'

test('headings become bracketed lines', () => {
  assert.equal(markdownToPlain('## 结论'), '【结论】')
})

test('list markers become readable bullets and keep indentation', () => {
  const plain = markdownToPlain('- 一\n- 二\n  - 嵌套')
  assert.equal(plain, '· 一\n· 二\n  · 嵌套')
})

test('ordered lists keep their numbers', () => {
  assert.equal(markdownToPlain('1. 第一步\n2) 第二步'), '1. 第一步\n2. 第二步')
})

test('inline emphasis is dropped but its text survives', () => {
  assert.equal(stripInline('这是 **粗体** 和 *斜体* 和 `代码`'), '这是 粗体 和 斜体 和 代码')
})

test('links keep their label and show the target', () => {
  assert.equal(stripInline('见 [文档](https://example.com/a)'), '见 文档（https://example.com/a）')
  assert.equal(stripInline('见 <https://example.com/b>'), '见 https://example.com/b')
})

test('images degrade to alt text plus URL', () => {
  assert.equal(stripInline('![架构图](https://example.com/x.png)'), '架构图 https://example.com/x.png')
})

test('fenced code keeps its content verbatim and drops the fences', () => {
  const plain = markdownToPlain('说明\n```js\nconst a = **1**\n```\n结束')
  assert.equal(plain, '说明\nconst a = **1**\n结束', 'code punctuation must not be rewritten')
})

test('horizontal rules become a visible separator', () => {
  assert.equal(markdownToPlain('上\n---\n下'), '上\n———\n下')
})

test('blockquotes are marked', () => {
  assert.equal(markdownToPlain('> 引用内容'), '｜引用内容')
})

test('runs of blank lines collapse to a single separator', () => {
  // One blank line is kept so paragraphs stay distinguishable; only the run is
  // collapsed.
  assert.equal(markdownToPlain('a\n\n\n\nb'), 'a\n\nb')
})

test('splitByBytes returns one chunk when the text fits', () => {
  assert.deepEqual(splitByBytes('short', 100), ['short'])
})

test('splitByBytes splits on line boundaries when possible', () => {
  const text = ['aaaa', 'bbbb', 'cccc'].join('\n')
  const chunks = splitByBytes(text, 10)
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) assert.ok(Buffer.byteLength(chunk, 'utf8') <= 10)
  assert.equal(chunks.join('\n').replace(/\n+/g, '\n'), text, 'no content is lost')
})

test('splitByBytes cuts a single oversized line by characters', () => {
  const text = '中'.repeat(50)
  const chunks = splitByBytes(text, 30)
  for (const chunk of chunks) assert.ok(Buffer.byteLength(chunk, 'utf8') <= 30)
  assert.equal(chunks.join(''), text, 'multibyte characters are never split mid-sequence')
})

test('splitByBytes returns nothing for empty input', () => {
  assert.deepEqual(splitByBytes('', 100), [])
})
