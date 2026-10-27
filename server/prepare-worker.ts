import { parse } from 'npm:acorn@8.14.0'
import * as path from 'node:path'

export function roleFactory(source: string, role: string): string {
  const adapted = role === 'renderer' ? source.replace(/^[ \t]*export[ \t]+default[ \t]+/m, '') : source
  const ast = parse(adapted, { ecmaVersion: 'latest' })
  const last = ast.body.at(-1)
  if (last?.type !== 'ExpressionStatement') throw new Error('role has no completion expression')
  // A fresh lexical scope per evaluation; the long-lived compartment cannot
  // retain request data on its global object or hardened endowments.
  return '(() => { Object.freeze(globalThis); return () => {\n' + adapted.slice(0, last.start) + '\nreturn (' + adapted.slice(last.expression.start, last.expression.end) + ');\n}; })()'
}

export async function prepareWorker(publicDir: string, generated: string) {
  await Deno.mkdir(generated, { recursive: true })
  const assets: Record<string, string> = {}
  async function walk(dir: string, prefix = '') {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.name.startsWith('_immutable-')) continue
      const name = prefix + '/' + entry.name
      if (name === '/docs' || name === '/omnishell') continue
      if (entry.isDirectory) await walk(path.join(dir, entry.name), name)
      else if (/\.(js|json|css|html|txt)$/.test(name)) assets[name] = await Deno.readTextFile(path.join(dir, entry.name))
    }
  }
  await walk(publicDir)
  const cfg = JSON.parse(assets['/shell/shell.json'])
  const declarations = new Map<string, { name: string; role: string }>()
  for (const route of cfg.routes) {
    for (const kind of ['handlers', 'renderers', 'adapters']) {
      for (const name of route.files[kind] ?? []) declarations.set(kind + ':' + name, { name: '/' + name, role: kind.slice(0, -1) })
    }
  }
  for (const table of Object.values(cfg.validations ?? {}) as Record<string, { src: string }>[]) {
    for (const spec of Object.values(table)) declarations.set('validation:' + spec.src, { name: '/' + spec.src, role: 'validation' })
  }
  const roles = [...declarations.values()].map(({ name, role }) => {
    const source = assets[name]
    if (typeof source !== 'string') throw new Error(`missing role: ${name}`)
    const endowments = cfg.endowments?.[name.slice(1)] ?? []
    const factory = roleFactory(source, role)
    return { name, source, role, endowments, factory }
  })
  const jessie = await Deno.readTextFile(new URL('../interpreter/jessie.js', import.meta.url))
  for (const expected of ['export async function evaluateCaged(', 'export async function evaluateRole(', 'await evaluateCaged(', 'new URL("./vendor/ses.umd.min.js", import.meta.url).href']) {
    if (jessie.split(expected).length !== 2) throw new Error(`Jessie changed: expected exactly one ${expected}`)
  }
  if (jessie.split('await ensureSes();').length !== 4) throw new Error('Jessie changed: expected three SES guards')
  const sync = jessie.replace('export async function evaluateCaged(', 'export function evaluateCaged(')
    .replace('new URL("./vendor/ses.umd.min.js", import.meta.url).href', '"startup-compiled-ses"')
    .replace('export async function evaluateRole(', 'export function evaluateRole(')
    .replaceAll('await ensureSes();', 'if (!globalThis.__prontoLockdown) throw new Error("SES not initialized");')
    .replace('await evaluateCaged(', 'evaluateCaged(')
  await Deno.writeTextFile(path.join(generated, 'jessie-startup.js'), sync)
  await Deno.writeTextFile(path.join(generated, 'assets.json'), JSON.stringify(assets))
  await Deno.writeTextFile(path.join(generated, 'roles.json'), JSON.stringify(roles))
  return cfg
}
