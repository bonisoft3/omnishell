import '../interpreter/vendor/ses.umd.min.js'
import { buildEndowments, evaluateRole as compile } from '@omnishell/jessie-startup'
import roles from '@omnishell/release-roles'

lockdown({ errorTaming: 'unsafe' })
globalThis.__prontoLockdown = true
const keyOf = (source, role, endowments) => JSON.stringify([source, role, endowments])
const factories = new Map(roles.map(({ name, source, role, endowments, factory }) => {
  try { compile(source, role, endowments) }
  catch (error) { throw new Error(`invalid role ${name}`, { cause: error }) }
  return [keyOf(source, role, endowments), compile(factory, 'handler', role === 'adapter' ? [...new Set(['Intl', ...endowments])] : endowments)]
}))
export { buildEndowments }
export async function ensureSes() {}
export async function evaluateRole(source, role = 'handler', endowments = []) {
  const factory = factories.get(keyOf(source, role, endowments))
  if (!factory) throw new Error(`role was not compiled at startup: ${role}`)
  return factory()
}
export async function evaluateCaged() { throw new Error('runtime compilation is unavailable') }
export async function evaluateEngine() { throw new Error('runtime compilation is unavailable') }
