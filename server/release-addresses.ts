/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// A release is its entry. Every file a page may run or fetch is written beside
// itself at its content address, `_immutable-<sha256>-<name>`, and every entry
// document carries the map from logical name to address (`#pronto-assets`):
// the release's identity is that map, so a page cannot run files from two
// releases, and an addressed file never changes.
//
// The URLs keep their directory so relative imports and import.meta.url still
// resolve against the source's base; nothing is combined, rewritten or
// minified but a stylesheet's references to its siblings.
import * as path from 'node:path'
import { parseHTML } from 'npm:linkedom@0.18.4'
import { parse } from 'npm:acorn@8.14.0'
import { simple } from 'npm:acorn-walk@8.3.4'
// @ts-types="npm:@types/css-tree@2.3.10"
import * as cssTree from 'npm:css-tree@3.1.0'

import { skeletonRoutes } from '../interpreter/preloads.js'
import { hasStrip, stripRoutes } from '../interpreter/chrome.js'
import { servesGuests } from '../interpreter/document.js'

const origin = 'https://release.invalid'
const encoder = new TextEncoder()
const digest = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))
const hex = (bytes: Uint8Array) => [...bytes].map(n => n.toString(16).padStart(2, '0')).join('')
export const local = (value: string, base: string) => {
  try {
    const url = new URL(value, origin + base)
    return (url.origin === origin && url.protocol === 'https:' && url.pathname.startsWith('/')) ? url.pathname : null
  } catch {
    return null
  }
}

/** What addressing a tree wrote: the map every entry carries, the screens each
 * screen links to, the entries it rewrote, and the inline scripts they hold,
 * which a door's Content-Security-Policy must name. */
export interface Release {
  imports: Record<string, string>
  screens: Record<string, string[]>
  entries: string[]
  scripts: string[]
  cfg: { routes: { path: string; screen?: string; paths?: Record<string, string>; access?: 'public' | 'private'; ssr?: 'spa' | 'ssg' | 'ssr'; files: Record<string, string | string[]>; nav: { label: string; strip?: boolean } }[]; auth?: { required?: boolean }; tables?: unknown[]; i18n?: { locales?: Record<string, unknown> }; prefix?: string }
}

/** An RTCIceServer: a STUN server's `urls`, and a TURN relay's credentials. */
export interface IceServer {
  urls: string | string[]
  username?: string
  credential?: string
}

export interface AddressOptions {
  /** A host that answers `.html` by other rules (Cloudflare's assets) is
   * given addressed templates under another suffix. */
  htmlSuffix?: string
  /** The ICE servers the release target hands an online race's
   * RTCPeerConnection, written into the terminal config before it is
   * addressed; without them the tree keeps the config's own. */
  iceServers?: IceServer[]
}

/** The ICE servers a release names, refused unless each is an RTCIceServer. */
export function parseIceServers(text: string): IceServer[] {
  const servers = JSON.parse(text)
  const valid = (s: Record<string, unknown>) =>
    s !== null && typeof s === 'object' &&
    (typeof s.urls === 'string' || (Array.isArray(s.urls) && s.urls.length > 0 && s.urls.every(u => typeof u === 'string'))) &&
    Object.keys(s).every(k => ['urls', 'username', 'credential'].includes(k) && (k === 'urls' || typeof s[k] === 'string'))
  if (!Array.isArray(servers) || !servers.every(valid)) throw new Error(`ice servers ${text} are not a list of RTCIceServer`)
  return servers
}

// A document a reader navigates to, which loads the runtime itself.
const ENTRY = /<script\b[^>]*\b(?:type="module"[^>]*\bsrc=|data-pronto-boot=)/

/** Addresses `out` in place and rewrites its entries to their release. */
export async function addressRelease(out: string, options: AddressOptions = {}): Promise<Release> {
  const files = new Map<string, Uint8Array>()
  const entries: string[] = []
  const decoder = new TextDecoder('utf-8', { fatal: true })
  async function collect(dir: string) {
    for await (const entry of Deno.readDir(path.join(out, dir))) {
      const name = path.posix.join(dir, entry.name)
      if (entry.name.startsWith('_immutable-')) throw new Error(`reserved asset name: ${name}`)
      if (entry.isDirectory) await collect(name)
      else if (!entry.isFile || name === 'offline-first-sw.js') continue
      else {
        const bytes = await Deno.readFile(path.join(out, name))
        if (name.endsWith('.html') && ENTRY.test(decoder.decode(bytes))) entries.push(name)
        else files.set('/' + name.split('/').map(encodeURIComponent).join('/'), bytes)
      }
    }
  }
  await collect('')
  if (!entries.includes('shell/index.html')) throw new Error('a release has no shell/index.html')
  if (options.iceServers) {
    const written = files.get('/shell/shell.json')
    if (!written) throw new Error('a release has no shell/shell.json to write its ICE servers into')
    const config = JSON.parse(decoder.decode(written))
    const bytes = encoder.encode(JSON.stringify({ ...config, iceServers: options.iceServers }))
    await Deno.writeFile(path.join(out, 'shell/shell.json'), bytes)
    files.set('/shell/shell.json', bytes)
  }
  const imports: Record<string, string> = {}
  const integrities: Record<string, string> = {}
  const active = new Set<string>()
  async function address(name: string): Promise<string> {
    if (imports[name]) return imports[name]
    if (active.has(name)) throw new Error(`cyclic CSS dependency: ${name}`)
    let bytes = files.get(name)
    if (!bytes) throw new Error(`undeclared asset: ${name}`)
    active.add(name)
    if (name.endsWith('.css')) {
      let css = decoder.decode(bytes)
      // Screen CSS is installed as a style element in /shell/, not as an
      // external sheet in /shell/screens/. Other sheets retain their own base.
      const base = name.startsWith('/shell/screens/') ? '/shell/' : name
      const refs: (cssTree.Url | cssTree.StringNode)[] = []
      const ast = cssTree.parse(css, { positions: true, parseCustomProperty: true, onParseError: error => { throw error } })
      cssTree.walk(ast, {
        visit: 'Url', enter(node: cssTree.Url) { refs.push(node) },
      })
      cssTree.walk(ast, {
        visit: 'Atrule', enter(node: cssTree.Atrule) {
          if (node.name.toLowerCase() !== 'import' || node.prelude?.type !== 'AtrulePrelude') return
          const first = node.prelude.children.first
          if (first?.type === 'String') refs.push(first)
        },
      })
      for (const ref of refs.sort((a, b) => b.loc!.start.offset - a.loc!.start.offset)) {
        const value = ref.value
        if (value.startsWith('#') || /^(?:data:|https?:|\/\/)/.test(value)) continue
        const target = local(value, base)
        if (!target) continue
        const url = new URL(value, origin + base)
        const mapped = await address(target) + url.search + url.hash
        const replaced = ref.type === 'Url' ? `url(${JSON.stringify(mapped)})` : JSON.stringify(mapped)
        css = css.slice(0, ref.loc!.start.offset) + replaced + css.slice(ref.loc!.end.offset)
      }
      bytes = encoder.encode(css)
    }
    const hash = hex(await digest(bytes))
    const sri = `sha256-${btoa(String.fromCharCode(...await digest(bytes)))}`
    integrities[name] = sri
    const suffix = name.endsWith('.html') ? options.htmlSuffix ?? '' : ''
    const url = path.posix.join(path.posix.dirname(name), `_immutable-${hash}-${path.posix.basename(name)}${suffix}`)
    await Deno.writeFile(path.join(out, decodeURIComponent(url)), bytes)
    imports[name] = url
    active.delete(name)
    return url
  }
  for (const name of [...files.keys()].sort()) await address(name)

  const dependencies = new Map<string, string[]>()
  for (const [name, bytes] of files) {
    if (!name.endsWith('.js')) continue
    const deps: string[] = []
    const ast = parse(decoder.decode(bytes), { ecmaVersion: 'latest', sourceType: 'module' })
    const take = (source: { value?: unknown } | null | undefined) => {
      if (typeof source?.value !== 'string') return
      const target = local(source.value, name)
      if (target !== null) {
        if (!imports[target]) throw new Error(`undeclared module ${source.value} imported by ${name}`)
        deps.push(target)
      }
    }
    simple(ast, {
      ImportDeclaration: node => take(node.source),
      ExportNamedDeclaration: node => take(node.source),
      ExportAllDeclaration: node => take(node.source),
    })
    dependencies.set(name, deps)
  }

  const cfg = JSON.parse(decoder.decode(files.get('/shell/shell.json')!)) as Release['cfg']
  // The strip a reader may meet: the served page's, or a signed-in person's.
  const stripTargets = hasStrip(cfg, null, servesGuests(cfg)) || Boolean(cfg.auth?.required)
    ? stripRoutes(cfg).map(r => r.screen ?? path.posix.basename(String(r.files.html), '.html'))
    : []
  const screens: Record<string, string[]> = {}
  for (const route of cfg.routes) {
    const name = route.screen ?? path.posix.basename(String(route.files.html), '.html')
    const htmlBytes = files.get(local(String(route.files.html), '/')!)
    const targets = htmlBytes ? skeletonRoutes(decoder.decode(htmlBytes)) : []
    screens[name] = [...new Set([...targets, ...stripTargets])].filter(target => target !== name)
  }

  const json = JSON.stringify({ imports, screens }).replace(/</g, '\\u003c')
  const scripts = new Set<string>()
  for (const name of entries) {
    const source = (await Deno.readTextFile(path.join(out, name))).replace(/\r\n?/g, '\n').replace(/\0/g, '�')
    const { document } = parseHTML(source)
    const base = local(document.querySelector('base[href]')?.getAttribute('href') ?? '/' + path.posix.dirname(name) + '/', '/')!
    const resolve = (value: string) => {
      const target = local(value, base)
      return target !== null && imports[target] ? imports[target] : null
    }
    const modules = new Set<string>()
    function closure(target: string) {
      if (modules.has(target)) return
      if (!imports[target]) throw new Error(`undeclared entry module: ${target}`)
      modules.add(target)
      for (const child of dependencies.get(target) ?? []) closure(child)
    }
    for (const node of document.querySelectorAll('script[type="module"][src], link[href]')) {
      const attr = node.tagName === 'SCRIPT' ? 'src' : 'href'
      const target = local(node.getAttribute(attr)!, base)
      if (target === null || !imports[target]) continue
      const rel = node.getAttribute('rel')
      if (attr === 'src' || rel === 'modulepreload') closure(target)
      node.setAttribute(attr, imports[target])
      if ((attr === 'src' || rel === 'modulepreload') && integrities[target]) {
        node.setAttribute('integrity', integrities[target])
      }
    }
    // A deferred boot names its boot module and its preloads as data, which it
    // turns into elements after first paint.
    const deferred = document.querySelector('script[data-pronto-boot]')
    if (deferred) {
      const rawBoot = deferred.getAttribute('data-pronto-boot')!
      const boot = resolve(rawBoot)
      if (!boot) throw new Error(`${name}: undeclared boot module ${rawBoot}`)
      deferred.setAttribute('data-pronto-boot', boot)
      const bootTarget = local(rawBoot, base)
      if (bootTarget && integrities[bootTarget]) {
        deferred.setAttribute('data-pronto-boot-integrity', integrities[bootTarget])
      }
      const ahead = JSON.parse(deferred.getAttribute('data-pronto-preloads') ?? '[]') as Record<string, string>[]
      deferred.setAttribute('data-pronto-preloads', JSON.stringify(ahead.map(link => {
        const linkTarget = link.href ? local(link.href, base) : null
        return {
          ...link,
          href: resolve(link.href) ?? link.href,
          ...(linkTarget && integrities[linkTarget] ? { integrity: integrities[linkTarget] } : {}),
        }
      })))
    } else {
      // Header modulepreloads can resolve dependencies before the map exists;
      // native modulepreloads after the map preserve both identity and scheduling.
      for (const node of document.querySelectorAll('link[rel="modulepreload"]')) node.remove()
      for (const target of modules) {
        const node = document.createElement('link')
        node.setAttribute('rel', 'modulepreload')
        node.setAttribute('href', imports[target])
        if (integrities[target]) node.setAttribute('integrity', integrities[target])
        document.head.append(node)
      }
    }
    for (const node of document.querySelectorAll('#pronto-assets, script[type="importmap"]')) node.remove()
    const map = document.createElement('script')
    map.setAttribute('type', 'importmap')
    map.setAttribute('id', 'pronto-assets')
    map.textContent = json
    document.head.prepend(map)
    const charset = document.querySelector('meta[charset]')
    if (charset) document.head.prepend(charset)
    const hashes = await Promise.all([...document.querySelectorAll('script:not([src])')].map(async script =>
      `'sha256-${btoa(String.fromCharCode(...await digest(encoder.encode(script.textContent!))))}'`))
    for (const hash of hashes) scripts.add(hash)
    const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')
    if (csp) {
      const policy = csp.getAttribute('content')!
      if (!/(?:^|;)\s*script-src\s/.test(policy)) throw new Error(`${name}: its CSP has no script-src`)
      csp.setAttribute('content', policy.replace(/((?:^|;)\s*script-src(?:-elem)?)\s/g, `$1 ${hashes.join(' ')} `))
      // The policy must be active before the import map is parsed.
      document.head.prepend(csp)
    }
    // What precedes the document is kept as written: a door's template
    // directive (pronto's prerendered documents bind the deployment's origin
    // there) is no node a parser keeps.
    const prolog = source.slice(0, source.search(/<!doctype|<html/i))
    await Deno.writeTextFile(path.join(out, name), prolog + '<!doctype html>\n' + document.documentElement.outerHTML + '\n')
  }
  return { imports, screens, entries: entries.sort(), scripts: [...scripts].sort(), cfg }
}

/** Copies the addresses `previous` holds into `out`, each checked against its
 * name: a tab still running an earlier release fetches them after `out` is
 * served. Returns the directories that hold any. */
export async function retainReleases(out: string, previous: string): Promise<Set<string>> {
  separateAssetDirectories(out, previous)
  const directories = new Set<string>()
  async function retain(dir: string) {
    for await (const entry of Deno.readDir(path.join(previous, dir))) {
      const name = path.join(dir, entry.name)
      if (entry.isDirectory) await retain(name)
      else if (entry.isFile && entry.name.startsWith('_immutable-')) {
        const expected = /^_immutable-([a-f0-9]{64})-/.exec(entry.name)?.[1]
        const bytes = await Deno.readFile(path.join(previous, name))
        if (hex(await digest(bytes)) !== expected) throw new Error(`retained asset identity mismatch: ${name}`)
        await Deno.mkdir(path.join(out, dir), { recursive: true })
        await Deno.writeFile(path.join(out, name), bytes)
        directories.add('/' + dir.split(path.sep).filter(Boolean).map(encodeURIComponent).join('/'))
      }
    }
  }
  await retain('')
  return directories
}

export function separateAssetDirectories(out: string, previous: string) {
  const overlaps = [path.relative(out, previous), path.relative(previous, out)].some(relative =>
    relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)))
  if (overlaps) throw new Error('previous assets and output must be separate directory trees')
}
