// What a reader does to a served document before the terminal has its handlers
// on it. Loaded apart from the module graph, which waits for first paint, and
// classic so it asks for nothing. A gesture held here reaches no listener, so a
// half-wired screen cannot answer it and then hear it again; its native default
// still happens. early-replay.js takes the list once the screen is live.
(() => {
  // It arrives on its own schedule: a shell already live must not lose its page to it.
  if (globalThis.__prontoLive) return;
  const TYPES = ["click", "input", "change", "keydown", "submit"];
  const held = [];
  const hold = (e) => {
    // A form the terminal does not submit is the browser's to send.
    if (e.type === "submit" && !e.target.hasAttribute("data-action") && !e.target.hasAttribute("data-on-submit")) return;
    e.stopImmediatePropagation();
    if (e.type === "submit") e.preventDefault();
    // Only a named key can mean anything once its letter is in the field.
    if (e.type === "keydown" && e.key.length === 1) return;
    const last = held[held.length - 1];
    if (e.type === "input" && last?.type === "input" && last.target === e.target) held.pop();
    held.push({ type: e.type, target: e.target, value: e.target.value, key: e.key, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey });
  };
  for (const type of TYPES) document.addEventListener(type, hold, true);
  globalThis.__prontoEarlyGestures = () => {
    for (const type of TYPES) document.removeEventListener(type, hold, true);
    delete globalThis.__prontoEarlyGestures;
    return held;
  };
})();
