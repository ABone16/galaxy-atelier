import assert from 'node:assert/strict'
import test from 'node:test'
import { successRate } from '../src/stats.ts'

test('calculates success rate from completed requests and excludes cancellations', () => {
  assert.equal(successRate(3, 2, 1), '75%')
})

test('shows no rate when there are no completed requests', () => {
  assert.equal(successRate(0, 2, 2), '—')
})
