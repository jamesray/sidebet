import assert from 'node:assert/strict'
import { test } from 'node:test'
import { search } from '../src/search.js'

test('finds items by name', () => {
  assert.deepEqual(search([{ name: 'apple' }, { name: 'pear' }], 'pea'), [{ name: 'pear' }])
})
