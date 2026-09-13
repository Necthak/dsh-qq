import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PendingInteractions, formatQuestions, parseApprovalReply, parseQuestionReply } from '../lib/bridge/pending.js'

test('approval replies accept the Chinese and English forms', () => {
  for (const text of ['通过', '允许', '同意', '可以', 'yes', 'OK', 'Approve']) {
    assert.equal(parseApprovalReply(text), 'allowed-once', text)
  }
  for (const text of ['拒绝', '不行', 'no', 'Reject']) {
    assert.equal(parseApprovalReply(text), 'rejected', text)
  }
})

test('an unrelated message is not an approval decision', () => {
  assert.equal(parseApprovalReply('帮我看看这个 bug'), undefined)
  assert.equal(parseApprovalReply(''), undefined)
})

test('a single question accepts free text as the custom answer', () => {
  const questions = [{ id: 'q1', question: '项目名？', options: [{ label: '甲' }, { label: '乙' }] }]
  assert.deepEqual(parseQuestionReply(questions, '甲'), { answers: [{ id: 'q1', selected: ['甲'] }] })
  assert.deepEqual(parseQuestionReply(questions, '2'), { answers: [{ id: 'q1', selected: ['乙'] }] })
  assert.deepEqual(parseQuestionReply(questions, '都不是'), { answers: [{ id: 'q1', selected: [], custom: '都不是' }] })
})

test('multiple questions require numbered lines and ignore unmatched ones', () => {
  const questions = [
    { id: 'q1', question: '一？', options: [{ label: 'A' }, { label: 'B' }] },
    { id: 'q2', question: '二？', options: [{ label: 'C' }, { label: 'D' }] },
  ]
  const parsed = parseQuestionReply(questions, '1. A\n2. 自由回答')
  assert.deepEqual(parsed, {
    answers: [
      { id: 'q1', selected: ['A'] },
      { id: 'q2', selected: [], custom: '自由回答' },
    ],
  })
  assert.equal(parseQuestionReply(questions, '完全无关'), undefined)
})

test('the question prompt lists numbered options', () => {
  const text = formatQuestions([
    { id: 'q1', question: '选哪个？', options: [{ label: '甲', description: '第一个' }, { label: '乙' }] },
  ])
  assert.match(text, /选哪个？/)
  assert.match(text, /1\) 甲 — 第一个/)
  assert.match(text, /2\) 乙/)
})

test('an open interaction consumes the next message as its answer', async () => {
  const pending = new PendingInteractions({ log: () => {} })
  const answer = pending.open('private:U', {
    kind: 'approval',
    timeoutMs: 1_000,
    parse: parseApprovalReply,
  })
  assert.equal(pending.offer('private:U', '通过'), true)
  assert.equal(await answer, 'allowed-once')
  assert.equal(pending.size, 0)
})

test('an unparsable message re-prompts instead of resolving', async () => {
  const pending = new PendingInteractions({ log: () => {} })
  let reprompts = 0
  const answer = pending.open('private:U', {
    kind: 'approval',
    timeoutMs: 1_000,
    parse: parseApprovalReply,
    onReprompt: () => { reprompts += 1 },
  })

  assert.equal(pending.offer('private:U', '这是什么'), true, 'still consumed, so it never reaches the agent')
  assert.equal(reprompts, 1)
  assert.equal(pending.size, 1, 'the interaction stays open')

  pending.offer('private:U', '拒绝')
  assert.equal(await answer, 'rejected')
})

test('messages for other conversations do not touch an open interaction', () => {
  const pending = new PendingInteractions({ log: () => {} })
  pending.open('private:U', { kind: 'approval', timeoutMs: 1_000, parse: parseApprovalReply })
  assert.equal(pending.offer('private:OTHER', '通过'), false)
  pending.closeAll()
})

test('an interaction expires rather than blocking a turn forever', async () => {
  const pending = new PendingInteractions({ log: () => {} })
  const answer = pending.open('private:U', { kind: 'approval', timeoutMs: 20, parse: parseApprovalReply })
  assert.equal(await answer, undefined)
  assert.equal(pending.size, 0)
})

test('opening a second interaction closes the first', async () => {
  const pending = new PendingInteractions({ log: () => {} })
  const first = pending.open('private:U', { kind: 'approval', timeoutMs: 1_000, parse: parseApprovalReply })
  pending.open('private:U', { kind: 'question', timeoutMs: 1_000, parse: () => ({ answers: [] }) })
  assert.equal(await first, undefined)
})
