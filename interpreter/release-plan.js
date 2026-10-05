const screenPaths = (release) => Object.keys(release.screens ?? {}).sort();

export function planRelease(current, next) {
  if (current?.format !== 1 || next?.format !== 1 ||
      typeof current.contract !== "string" || typeof next.contract !== "string" ||
      typeof current.id !== "string" || typeof next.id !== "string") {
    throw new Error("invalid app release manifest");
  }
  if (current.id === next.id) return { kind: "unchanged" };
  if (current.contract !== next.contract ||
      JSON.stringify(screenPaths(current)) !== JSON.stringify(screenPaths(next))) {
    return { kind: "restart" };
  }
  const screens = screenPaths(next).filter((path) =>
    current.screens[path].html !== next.screens[path].html ||
    current.screens[path].css !== next.screens[path].css
  );
  return screens.length > 0 ? { kind: "morph", screens } : { kind: "restart" };
}
