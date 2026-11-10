import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeMessages, preserveScrollAnchor } from '../src/chat-history.ts'

const message = (id, createdAt, content) => ({ id, role: 'user', createdAt, content })

test('merges older pages in stable order and replaces refreshed messages by id', () => {
  const existing = [
    message('c', '2026-01-02T00:00:00.000Z', 'current'),
    message('d', '2026-01-03T00:00:00.000Z', 'pending'),
  ]
  const merged = mergeMessages(existing, [
    message('a', '2026-01-01T00:00:00.000Z', 'older'),
    message('d', '2026-01-03T00:00:00.000Z', 'completed'),
  ])

  assert.deepEqual(merged.map(item => item.id), ['a', 'c', 'd'])
  assert.equal(merged[2].content, 'completed')
})

test('uses message ids to order messages with identical timestamps', () => {
  const merged = mergeMessages([], [
    message('b', '2026-01-01T00:00:00.000Z', 'second'),
    message('a', '2026-01-01T00:00:00.000Z', 'first'),
  ])

  assert.deepEqual(merged.map(item => item.id), ['a', 'b'])
})

test('preserves the visible scroll anchor after prepending content', () => {
  assert.equal(preserveScrollAnchor(180, 1200, 1680), 660)
  assert.equal(preserveScrollAnchor(180, 1200, 1100), 80)
  assert.equal(preserveScrollAnchor(10, 1200, 900), 0)
})
