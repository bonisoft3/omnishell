// How a page takes a release: the difference between the map it runs
// (#pronto-assets, logical path → content address) and the one served now.
// What the page only links to changes nothing it runs. A screen's template and
// style, a catalogue and a handler, a pure function looked up as it is called,
// are taken in place; anything else — a renderer, the config, a shared
// stylesheet, the interpreter — is code the page is running, and the page
// restarts into the new entry.
const unrun = (name) => name.startsWith("/docs/") || /\.(md|txt|xml|png|jpe?g|webp|gif|svg|ico)$/.test(name);

/** Every file the two maps disagree on, one the new release dropped among them. */
export const filesMoved = (current, next) =>
  [...new Set([...Object.keys(current), ...Object.keys(next)])].filter((name) => current[name] !== next[name]);

export function planRelease(current, next, screens) {
  const differ = filesMoved(current, next);
  if (differ.length === 0) return { kind: "unchanged" };
  // Still taken: the map names the addresses a later fetch asks for, and a release retires old ones.
  const changed = differ.filter((name) => !unrun(name));
  const moved = screens.filter((s) => changed.includes(s.html) || changed.includes(s.css));
  const catalogues = changed.filter((name) => name.startsWith("/messages/"));
  // In both maps: a handler that arrives or goes changes what a screen can name.
  const handlers = [...new Set(screens.flatMap((s) => s.handlers ?? []))]
    .filter((name) => changed.includes(name) && current[name] !== undefined && next[name] !== undefined);
  const taken = new Set([...moved.flatMap((s) => [s.html, s.css]), ...catalogues, ...handlers]);
  if (changed.some((name) => !taken.has(name))) return { kind: "restart" };
  return { kind: "morph", screens: moved.map((s) => s.html), catalogues, handlers };
}
