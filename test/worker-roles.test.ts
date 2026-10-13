import assert from 'node:assert/strict'
import { roleFactory } from '../server/prepare-worker.ts'
import { evaluateRole } from '../interpreter/jessie.js'

Deno.test('startup role factories isolate request closures and reject global retention', async () => {
  const factory = await evaluateRole(roleFactory('let value; (input) => { const previous = value; value = input; return previous; }', 'handler'))
  const first = factory()
  assert.equal(first('secret'), undefined)
  assert.equal(first('next'), 'secret')
  assert.equal(factory()('other request'), undefined)
  const global = await evaluateRole(roleFactory('(value) => { globalThis.retained = value; }', 'handler'))
  assert.throws(() => global()('secret'), TypeError)
  const renderer = await evaluateRole(roleFactory('export default (ctx) => ctx.label', 'renderer'))
  assert.equal(renderer()({ label: 'rendered' }), 'rendered')
})
