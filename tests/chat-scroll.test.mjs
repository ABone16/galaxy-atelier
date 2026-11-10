import assert from 'node:assert/strict'
import test from 'node:test'
import { CHAT_SCROLL_FOLLOW_THRESHOLD, ChatScrollFollow, isAtScrollEnd } from '../src/chat-scroll.ts'

test('keeps following when the reader is at or near the conversation end', () => {
  assert.equal(isAtScrollEnd({ scrollHeight: 1200, clientHeight: 600, scrollTop: 600 }), true)
  assert.equal(isAtScrollEnd({ scrollHeight: 1200, clientHeight: 600, scrollTop: 600 - CHAT_SCROLL_FOLLOW_THRESHOLD }), true)
  assert.equal(isAtScrollEnd({ scrollHeight: 1200, clientHeight: 600, scrollTop: 600 - CHAT_SCROLL_FOLLOW_THRESHOLD - 1 }), false)
})

test('treats a conversation shorter than its viewport as already at the end', () => {
  assert.equal(isAtScrollEnd({ scrollHeight: 400, clientHeight: 600, scrollTop: 0 }), true)
})

test('disables following while reading older messages and restores it at the end', () => {
  const follow = new ChatScrollFollow()
  assert.equal(follow.isFollowing, true)

  const away = follow.sample({ scrollHeight: 1200, clientHeight: 600, scrollTop: 300 })
  assert.deepEqual(away, { atEnd: false, showLatestButton: true })
  assert.equal(follow.isFollowing, false)

  const atEnd = follow.sample({ scrollHeight: 1200, clientHeight: 600, scrollTop: 600 })
  assert.deepEqual(atEnd, { atEnd: true, showLatestButton: false })
  assert.equal(follow.isFollowing, true)
})

test('can reset follow intent when opening another conversation', () => {
  const follow = new ChatScrollFollow()
  follow.sample({ scrollHeight: 1200, clientHeight: 600, scrollTop: 300 })
  follow.reset()

  assert.equal(follow.isFollowing, true)
})

test('does not mistake large overscroll for being at the end', () => {
  assert.equal(isAtScrollEnd({ scrollHeight: 1200, clientHeight: 600, scrollTop: 720 }), false)
})
