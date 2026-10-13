import '../../interpreter/vendor/ses.umd.min.js';
import { evaluateRole as compile, buildEndowments } from './.generated/jessie-sync.js';
import roles from './.generated/roles.json';

lockdown({ errorTaming: 'unsafe' });
globalThis.__prontoLockdown = true;
const keyOf = (source, role, endowments) => JSON.stringify([source, role, endowments]);
const compiled = new Map(roles.map(({ source, role, endowments }) =>
  [keyOf(source, role, endowments), compile(source, role, endowments)]));
export { buildEndowments };
export async function ensureSes() {}
export async function evaluateRole(source, role = 'handler', endowments = []) {
  const key = keyOf(source, role, endowments);
  if (!compiled.has(key)) throw new Error(`role was not compiled at startup: ${role}`);
  return compiled.get(key);
}
export async function evaluateCaged() { throw new Error('runtime compilation is unavailable'); }
