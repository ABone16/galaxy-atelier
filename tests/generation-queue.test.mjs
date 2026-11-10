import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_GENERATION_QUEUE,
  enqueueGeneration,
  enqueueAndTakeNextGeneration,
  removeQueuedGeneration,
  takeNextGeneration,
} from '../src/generation-queue.ts'

test('appends queued generations in FIFO order and takes the head', () => {
  let queue = []
  queue = enqueueGeneration(queue, { id: 'one' })
  queue = enqueueGeneration(queue, { id: 'two' })
  assert.deepEqual(queue.map(item => item.id), ['one', 'two'])
  const next = takeNextGeneration(queue)
  assert.equal(next.item.id, 'one')
  assert.deepEqual(next.rest.map(item => item.id), ['two'])
})

test('rejects additions after the queue capacity without mutating the queue', () => {
  const queue = Array.from({ length: MAX_GENERATION_QUEUE }, (_, index) => ({ id: String(index) }))
  assert.equal(enqueueGeneration(queue, { id: 'overflow' }), null)
  assert.equal(queue.length, MAX_GENERATION_QUEUE)
})

test('wakes a parked queue in FIFO order and appends the new request behind it', () => {
  const queue = [{ id: 'parked-one' }, { id: 'parked-two' }]
  const resumed = enqueueAndTakeNextGeneration(queue, { id: 'wake' })

  assert.deepEqual(resumed, {
    item: { id: 'parked-one' },
    rest: [{ id: 'parked-two' }, { id: 'wake' }],
  })
  assert.deepEqual(queue.map(item => item.id), ['parked-one', 'parked-two'])
})

test('keeps a parked queue unchanged when the wake request exceeds capacity', () => {
  const queue = Array.from({ length: MAX_GENERATION_QUEUE }, (_, index) => ({ id: String(index) }))

  assert.equal(enqueueAndTakeNextGeneration(queue, { id: 'wake' }), null)
  assert.equal(queue.length, MAX_GENERATION_QUEUE)
})

test('removes only the requested queue occurrence', () => {
  const queue = [{ id: 'one' }, { id: 'two' }, { id: 'three' }]
  assert.deepEqual(removeQueuedGeneration(queue, 'two').map(item => item.id), ['one', 'three'])
})
