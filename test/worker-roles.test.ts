import assert from 'node:assert/strict'
import { prepareWorker, roleFactory } from '../server/prepare-worker.ts'
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

Deno.test('worker startup resolves Statechart and preserves role grants', async () => {
  const root = await Deno.makeTempDir()
  try {
    await Deno.mkdir(`${root}/public/shell/handlers`, { recursive: true })
    await Deno.writeTextFile(`${root}/public/shell/shell.json`, JSON.stringify({ routes: [{files: {handlers: ['shell/handlers/step.js']}}], endowments: {'shell/handlers/step.js': ['Statechart']} }))
    await Deno.writeTextFile(`${root}/public/shell/handlers/step.js`, '(state) => state')
    await prepareWorker(`${root}/public`, `${root}/generated`)
    const startup = await import(`file://${root}/generated/jessie-startup.js`)
    assert.equal(typeof startup.SAFE_ENDOWMENTS.Statechart, 'function')
    const roles = JSON.parse(await Deno.readTextFile(`${root}/generated/roles.json`))
    assert.deepEqual(roles[0].endowments, ['Statechart'])
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
