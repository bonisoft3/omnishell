const fixtureDir = Deno.args[0];
if (!fixtureDir) throw new Error('prepare.ts <capture-directory>');
const here = new URL('.', import.meta.url);
await Deno.mkdir(new URL('.generated/', here), { recursive: true });
await Deno.copyFile(fixtureDir + '/fixture.json', new URL('.generated/fixture.json', here));
// Only the timing of evaluation changes. Keep SES, role validation and
// endowment restrictions byte-for-byte from the interpreter under test.
const jessie = await Deno.readTextFile(new URL('../../interpreter/jessie.js', here));
for (const expected of ['export async function evaluateCaged(', 'export async function evaluateRole(', 'await evaluateCaged(', 'new URL("./vendor/ses.umd.min.js", import.meta.url).href']) {
  if (jessie.split(expected).length !== 2) throw new Error(`Jessie changed: expected exactly one ${expected}`);
}
if (jessie.split('await ensureSes();').length !== 3) throw new Error('Jessie changed: expected two SES guards');
const sync = jessie.replace('export async function evaluateCaged(', 'export function evaluateCaged(')
  .replace('new URL("./vendor/ses.umd.min.js", import.meta.url).href', '"startup-compiled-ses"')
  .replace('export async function evaluateRole(', 'export function evaluateRole(')
  .replaceAll('await ensureSes();', 'if (!globalThis.__prontoLockdown) throw new Error("SES not initialized");')
  .replace('await evaluateCaged(', 'evaluateCaged(');
await Deno.writeTextFile(new URL('.generated/jessie-sync.js', here), sync);
// Wrangler aliases the interpreter's Jessie boundary, not the rendering
// algorithm. Unknown code remains an error during request handling.
const fixture = JSON.parse(await Deno.readTextFile(fixtureDir + '/fixture.json'));
const roles = Object.entries(fixture.assets).flatMap(([name, source]) => {
  const role = /\/(handlers|renderers|adapters)\//.exec(name)?.[1];
  return role ? [{ source, role: role.slice(0, -1), endowments: fixture.cfg.endowments?.[name.slice(1)] ?? [] }] : [];
});
await Deno.writeTextFile(new URL('.generated/roles.json', here), JSON.stringify(roles));
const config = {
  name: 'golaberto-native-ssr-spike', main: '../worker.ts', compatibility_date: '2026-09-01',
  compatibility_flags: ['nodejs_compat'], workers_dev: false, keep_names: false,
  alias: { './jessie.js': new URL('roles.ts', here).pathname },
};
await Deno.writeTextFile(new URL('.generated/wrangler.json', here), JSON.stringify(config, null, 2));
console.log(JSON.stringify({ roles: roles.length, queries: Object.keys(fixture.queries).length }));
