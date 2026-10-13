const fixtureDir = Deno.args[0];
if (!fixtureDir) throw new Error('floor-prepare.ts <capture-directory>; run prepare.ts first');
const here = new URL('.', import.meta.url);
const generated = new URL('.generated/', here);
const source = new URL('../../interpreter/', here);
const modules = new Set(['screen.js', 'document.js', 'markup.js']);
function replaceOnce(text, from, to) {
  if (text.split(from).length !== 2) throw new Error(`source changed: ${from}`);
  return text.replace(from, to);
}
for (const name of modules) {
  let text = await Deno.readTextFile(new URL(name, source));
  // These intentionally incorrect variants live only in the local spike.
  // Absolute imports keep every unmodified dependency on its original path.
  const resolve = (path) => {
    const url = path === 'jessie.js' ? new URL('roles.ts', here)
      : modules.has(path) ? new URL('floor-' + path, generated) : new URL(path, source);
    return JSON.stringify(url.pathname);
  };
  text = text.replace(/from "\.\/([^"\n]+)"/g, (_, path) => `from ${resolve(path)}`)
    .replace(/import\("\.\/([^"\n]+)"\)/g, (_, path) => `import(${resolve(path)})`);
  if (name === 'screen.js') {
    for (const signature of ['function wireKeysIn(scope) {', 'function bindHatches(scope, ctx) {']) {
      text = replaceOnce(text, signature, signature + '\nif (globalThis.__floor?.wiring) return;');
    }
    const signature = 'function wireEvents(region, items, getRows, handlers, ctx) {';
    text = replaceOnce(text, signature, signature + '\nif (globalThis.__floor?.wiring) return { deliver: async () => {}, apply: () => {} };');
    text = replaceOnce(text, 'function bindElementAttributes(el, ctx) {', 'function bindElementAttributes(el, ctx) {\nif (globalThis.__floor?.attributes) return;');
    text = replaceOnce(text, 'else renderInto(render, interpolate(el.dataset.text, ctx), el);', 'else if (!globalThis.__floor?.charts) renderInto(render, interpolate(el.dataset.text, ctx), el);');
  }
  if (name === 'markup.js') {
    text = 'const floorTemplates = new Map();\n' + text;
    text = replaceOnce(text, 'export function parseMarkup(document, text) {', 'export function parseMarkup(document, text) {\nif (globalThis.__floor?.templates && floorTemplates.has(text)) return floorTemplates.get(text).cloneNode(true);');
    text = replaceOnce(text, 'const errors = markupViolations(template.content);', 'const errors = globalThis.__floor?.validation ? [] : markupViolations(template.content);');
    text = replaceOnce(text, 'return template.content;', 'if (globalThis.__floor?.templates) floorTemplates.set(text, template.content.cloneNode(true));\nreturn template.content;');
  }
  if (name === 'document.js') {
    text = replaceOnce(text, 'html: serialize(doc)', 'html: globalThis.__floor?.serialization ? "assembly-only" : serialize(doc)');
  }
  await Deno.writeTextFile(new URL('floor-' + name, generated), text);
}
const cfg = JSON.parse(await Deno.readTextFile(new URL('wrangler.json', generated)));
cfg.main = '../floor-worker.ts';
cfg.name = 'golaberto-native-ssr-floor';
cfg.alias['../../interpreter/document.js'] = new URL('floor-document.js', generated).pathname;
await Deno.writeTextFile(new URL('floor-wrangler.json', generated), JSON.stringify(cfg, null, 2));
await Deno.writeTextFile(new URL('reference.json', generated), JSON.stringify(await Deno.readTextFile(fixtureDir + '/reference.html')));
