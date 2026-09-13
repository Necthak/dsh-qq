import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionMap, conversationKey, splitConversationKey } from '../lib/bridge/sessions.js'

function tempPath(name = 'sessions.json') {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-test-'))
  return { path: join(dir, name), dir }
}

test('conversation keys round-trip', () => {
  assert.equal(conversationKey('private', 'U1'), 'private:U1')
  assert.deepEqual(splitConversationKey('group:G1'), { kind: 'group', peerId: 'G1' })
  assert.equal(splitConversationKey('bogus:G1'), null)
  assert.equal(splitConversationKey('private:'), null)
  assert.equal(splitConversationKey(42), null)
})

test('a binding survives a reload from disk', () => {
  const { path, dir } = tempPath()
  try {
    const first = new SessionMap({ path, log: () => {} })
    first.bind('private:U1', 'sess_a')
    first.setReplyTarget('private:U1', 'msg_1')

    const second = new SessionMap({ path, log: () => {} })
    const record = second.get('private:U1')
    assert.equal(record.sessionId, 'sess_a')
    assert.equal(record.replyToMessageId, 'msg_1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt table degrades to empty instead of throwing', () => {
  const { path, dir } = tempPath()
  try {
    const map = new SessionMap({ path, log: () => {} })
    map.bind('private:U1', 'sess_a')
    // Overwrite with garbage.
    writeFileSync(path, '{not json', 'utf8')
    const reloaded = new SessionMap({ path, log: () => {} })
    assert.equal(reloaded.size, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reply slots advance msg_seq and stop at the platform allowance', () => {
  const { path, dir } = tempPath()
  try {
    const map = new SessionMap({ path, log: () => {} })
    map.bind('private:U1', 'sess_a')
    map.setReplyTarget('private:U1', 'msg_1')

    assert.deepEqual(map.takeReplySlot('private:U1', 4), { msgId: 'msg_1', msgSeq: 1 })
    assert.deepEqual(map.takeReplySlot('private:U1', 4), { msgId: 'msg_1', msgSeq: 2 })
    assert.deepEqual(map.takeReplySlot('private:U1', 4), { msgId: 'msg_1', msgSeq: 3 })
    assert.deepEqual(map.takeReplySlot('private:U1', 4), { msgId: 'msg_1', msgSeq: 4 })
    assert.equal(map.takeReplySlot('private:U1', 4), null, 'the fifth reply must fall back to an active message')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a new inbound message resets the reply ordinal', () => {
  const { path, dir } = tempPath()
  try {
    const map = new SessionMap({ path, log: () => {} })
    map.bind('private:U1', 'sess_a')
    map.setReplyTarget('private:U1', 'msg_1')
    map.takeReplySlot('private:U1', 4)
    map.takeReplySlot('private:U1', 4)

    map.setReplyTarget('private:U1', 'msg_2')
    assert.deepEqual(map.takeReplySlot('private:U1', 4), { msgId: 'msg_2', msgSeq: 1 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('no reply slot is available before an inbound message arrives', () => {
  const { path, dir } = tempPath()
  try {
    const map = new SessionMap({ path, log: () => {} })
    map.bind('private:U1', 'sess_a')
    assert.equal(map.takeReplySlot('private:U1', 4), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('keyForSession finds the conversation bound to a session', () => {
  const { path, dir } = tempPath()
  try {
    const map = new SessionMap({ path, log: () => {} })
    map.bind('private:U1', 'sess_a')
    map.bind('group:G1', 'sess_b')
    assert.equal(map.keyForSession('sess_b'), 'group:G1')
    assert.equal(map.keyForSession('sess_missing'), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reset drops the binding so the next message starts fresh', () => {
  const { path, dir } = tempPath()
  try {
    const map = new SessionMap({ path, log: () => {} })
    map.bind('private:U1', 'sess_a')
    assert.equal(map.reset('private:U1'), true)
    assert.equal(map.get('private:U1'), undefined)
    assert.equal(map.reset('private:U1'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a reply target older than the window is not offered', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-sess-'))
  try {
    const path = join(dir, 'sessions.json')
    const now = Date.now()
    writeFileSync(path, JSON.stringify({
      'group:G1': {
        sessionId: 'sess_1',
        replyToMessageId: 'MSG1',
        replySeq: 0,
        replyTargetAt: now - 6 * 60_000,
        createdAt: now,
        updatedAt: now,
      },
      'private:U1': {
        sessionId: 'sess_2',
        replyToMessageId: 'MSG2',
        replySeq: 0,
        replyTargetAt: now - 6 * 60_000,
        createdAt: now,
        updatedAt: now,
      },
    }), 'utf8')

    const sessions = new SessionMap({ path, log: () => {} })

    // Six minutes is past the group window but well inside the private one.
    assert.equal(sessions.takeReplySlot('group:G1', 5, 5 * 60_000), null)
    assert.deepEqual(sessions.takeReplySlot('private:U1', 4, 60 * 60_000), { msgId: 'MSG2', msgSeq: 1 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a fresh reply target is offered and clearReplyTarget kills it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-sess-'))
  try {
    const sessions = new SessionMap({ path: join(dir, 'sessions.json'), log: () => {} })
    sessions.bind('group:G1', 'sess_1')
    sessions.setReplyTarget('group:G1', 'MSG1')
    assert.deepEqual(sessions.takeReplySlot('group:G1', 5, 5 * 60_000), { msgId: 'MSG1', msgSeq: 1 })

    sessions.clearReplyTarget('group:G1')
    assert.equal(sessions.takeReplySlot('group:G1', 5, 5 * 60_000), null)
    assert.equal(sessions.get('group:G1').sessionId, 'sess_1', 'the session binding survives')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an event reply target yields event_id, not a msg_id slot', () => {
  const { path, dir } = tempPath()
  try {
    const map = new SessionMap({ path, log: () => {} })
    map.bind('private:U1', 'sess_a')
    // A button click's id is an event id; the platform refuses it in msg_id.
    map.setReplyTarget('private:U1', 'EVENT1', 'event')
    assert.deepEqual(map.takeReplySlot('private:U1', 4), { eventId: 'EVENT1' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a target armed without a kind stays a message target', () => {
  const { path, dir } = tempPath()
  try {
    const map = new SessionMap({ path, log: () => {} })
    map.bind('private:U1', 'sess_a')
    map.setReplyTarget('private:U1', 'msg_1')
    assert.deepEqual(map.takeReplySlot('private:U1', 4), { msgId: 'msg_1', msgSeq: 1 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a table written before targets were typed still replies as a message', () => {
  const { path, dir } = tempPath()
  try {
    // Exactly the shape an older build persisted: no `replyTargetKind` field.
    writeFileSync(path, JSON.stringify({
      'private:U1': {
        sessionId: 'sess_a',
        replyToMessageId: 'msg_1',
        replySeq: 0,
        replyTargetAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    }))
    const map = new SessionMap({ path, log: () => {} })
    assert.deepEqual(map.takeReplySlot('private:U1', 4), { msgId: 'msg_1', msgSeq: 1 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('clearing a target forgets that it was an event', () => {
  const { path, dir } = tempPath()
  try {
    const map = new SessionMap({ path, log: () => {} })
    map.bind('private:U1', 'sess_a')
    map.setReplyTarget('private:U1', 'EVENT1', 'event')
    map.clearReplyTarget('private:U1')
    assert.equal(map.takeReplySlot('private:U1', 4), null)
    map.setReplyTarget('private:U1', 'msg_2')
    assert.deepEqual(map.takeReplySlot('private:U1', 4), { msgId: 'msg_2', msgSeq: 1 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('every field survives a reload, not just the ones load knows about', () => {
  // The table is written whole but used to be restored field by field, so each
  // new field vanished on the next restart — and the write after that erased it
  // from disk as well. `lastUserId` is what the agent's own group sends are
  // judged by, so losing it silently re-broke sending after every restart.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-sessions-'))
  try {
    const path = join(dir, 'table.json')
    const first = new SessionMap({ path, log: () => {} })
    first.bind('group:G', 'sess_1')
    first.setReplyTarget('group:G', 'evt_1', 'event', 'OWNER_OPENID')
    first.flush()

    const reopened = new SessionMap({ path, log: () => {} })
    const record = reopened.get('group:G')
    assert.equal(record.lastUserId, 'OWNER_OPENID', 'the remembered sender survives')
    assert.equal(record.replyTargetKind, 'event', 'so does the target type')
    assert.deepEqual(reopened.takeReplySlot('group:G', 5, 60_000), { eventId: 'evt_1' }, 'and the slot still answers as an event')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a field this version does not know is still carried through', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-sessions-'))
  try {
    const path = join(dir, 'table.json')
    writeFileSync(path, JSON.stringify({
      'private:X': { sessionId: 'sess_x', replyToMessageId: '', replySeq: 0, somethingAddedLater: 'keep me' },
    }))
    const map = new SessionMap({ path, log: () => {} })
    assert.equal(map.get('private:X').somethingAddedLater, 'keep me')
    map.setReplyTarget('private:X', 'msg_2')
    map.flush()
    assert.equal(JSON.parse(readFileSync(path, 'utf8'))['private:X'].somethingAddedLater, 'keep me', 'a rewrite does not drop it either')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
