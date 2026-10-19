// How a page takes a release: the difference between the map it runs
// (#pronto-assets, logical path → content address) and the one served now.
// A screen's template and style and a catalogue are taken in place; anything
// else — a handler, the config, a shared stylesheet, the interpreter — is
// code the page is running, and the page restarts into the new entry.
export function planRelease(current, next, screens) {
  const names = new Set([...Object.keys(current), ...Object.keys(next)]);
  const changed = [...names].filter((name) => current[name] !== next[name]);
  if (changed.length === 0) return { kind: "unchanged" };
  const moved = screens.filter((s) => changed.includes(s.html) || changed.includes(s.css));
  const catalogues = changed.filter((name) => name.startsWith("/messages/"));
  const taken = new Set([...moved.flatMap((s) => [s.html, s.css]), ...catalogues]);
  if (changed.some((name) => !taken.has(name))) return { kind: "restart" };
  return { kind: "morph", screens: moved.map((s) => s.html), catalogues };
}
