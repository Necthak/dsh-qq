/**
 * Live turn visibility: the line `/status` prints, and the optional heartbeat.
 *
 * The tracker exists because a turn that uses tools runs for minutes, and on a
 * phone the difference between "working" and "stuck" was previously
 * unobservable. What matters here is that it never claims more than it knows —
 * a process that took over mid-turn has no step count and says so.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { TurnProgress, dueHeartbeat, formatElapsed, heartbeatLine } from '../lib/bridge/progress.js'

/** Feed a tracker a turn that is already several steps in. */
function running() {
  const progress = new TurnProgress()
  progress.observe('s1', { type: 'turn/start', data: { turn: 3 } })
  progress.observe('s1', { type: 'step/start', data: { turn: 3, step: 5 } })
  progress.observe('s1', { type: 'tool/call', data: { turn: 3, step: 5, name: 'bash' } })
  return progress
}

test('elapsed time reads the way a person waiting would say it', () => {
  assert.equal(formatElapsed(0), '0 秒')
  assert.equal(formatElapsed(45_000), '45 秒')
  assert.equal(formatElapsed(6 * 60_000 + 12_000), '6 分 12 秒')
  assert.equal(formatElapsed(2 * 3_600_000 + 5 * 60_000), '2 小时 5 分')
})

test('a running turn reports elapsed time, step and tool', () => {
  const progress = running()
  // The elapsed figure comes from the wall clock, so any exact string is a race:
  // a millisecond may pass between building the fixture and reading it (printing
  // "300 毫秒"), or half a second may pass (printing "1 秒"). Pin the shape, not
  // the value — this assertion has now flaked twice by pinning the value.
  assert.match(progress.describe('s1', true), /^已运行 \d+ (毫秒|秒) · 第 6 步 · 最近工具 bash$/)
})

test('the step count is the highest step entered, not a running total', () => {
  const progress = new TurnProgress()
  progress.observe('s1', { type: 'turn/start', data: { turn: 1 } })
  // A retried step re-enters the same number; counting entries would inflate it.
  for (const step of [0, 1, 1, 2]) progress.observe('s1', { type: 'step/start', data: { turn: 1, step } })
  assert.equal(progress.snapshot('s1').steps, 3)
})

test('a finished turn reports idle, and stops counting time', () => {
  const progress = running()
  progress.observe('s1', { type: 'turn/end', data: { turn: 3 } })
  assert.equal(progress.snapshot('s1').running, false)
  assert.equal(progress.snapshot('s1').elapsedMs, 0)
  assert.equal(progress.describe('s1', false), '空闲')
})

test('a turn this process never watched start admits that instead of guessing', () => {
  // After a plugin reload the tracker has no history, but the Host still knows
  // the agent is running. "运行中（步数未知）" beats a confident "空闲".
  const progress = new TurnProgress()
  assert.equal(progress.describe('s1', true), '运行中（本进程接管前的步数未知）')
  assert.equal(progress.describe('s1', false), '空闲')
  assert.equal(progress.describe('s1', null), '空闲')
})

test('events for an unknown session are ignored', () => {
  const progress = new TurnProgress()
  progress.observe('never-seen', { type: 'step/start', data: { step: 2 } })
  assert.equal(progress.snapshot('never-seen'), null)
})

test('heartbeats need a running turn that has outlived the interval', () => {
  const snapshot = { running: true, elapsedMs: 90_000, steps: 3, lastTool: 'bash' }
  assert.equal(dueHeartbeat({ snapshot, intervalMs: 60_000, now: 90_000 }), '⏳ 仍在运行：1 分 30 秒 · 第 3 步 · 最近工具 bash')
  assert.equal(dueHeartbeat({ snapshot, intervalMs: 0, now: 90_000 }), null, 'disabled by default')
  assert.equal(dueHeartbeat({ snapshot: { ...snapshot, elapsedMs: 30_000 }, intervalMs: 60_000, now: 30_000 }), null)
  assert.equal(dueHeartbeat({ snapshot: { ...snapshot, running: false }, intervalMs: 60_000, now: 90_000 }), null)
})

test('the pacing rule is what stops a heartbeat from becoming spam', () => {
  const snapshot = { running: true, elapsedMs: 10 * 60_000, steps: 9, lastTool: 'read' }
  // 90 minutes in with a 2-minute interval, but the last one just went out.
  assert.equal(dueHeartbeat({ snapshot, intervalMs: 120_000, lastSentAt: 90 * 60_000 - 5_000, now: 90 * 60_000 }), null)
  assert.notEqual(dueHeartbeat({ snapshot, intervalMs: 120_000, lastSentAt: 90 * 60_000 - 130_000, now: 90 * 60_000 }), null)
})

test('a heartbeat line omits what it does not know', () => {
  assert.equal(heartbeatLine({ elapsedMs: 65_000, steps: 0, lastTool: '' }), '⏳ 仍在运行：1 分 5 秒')
})
