/** Ends the holding, and hands back what it held. The shell calls this however the mount went:
 * a page that kept holding would answer nothing again, and say nothing of why. */
export function takeEarlyGestures() {
  globalThis.__prontoLive = true;
  return globalThis.__prontoEarlyGestures?.() ?? [];
}

/** Hands what early-gestures.js held to the document, now that it can answer, each
 * gesture settled before the next as a reader's would be. Its default already
 * happened, and a second one would close the popover it opened, or leave the
 * page by a link that is on its way out. */
export async function replayEarlyGestures(doc, settle) {
  for (const gesture of takeEarlyGestures()) {
    const { target, type, value, key, shiftKey, altKey, ctrlKey, metaKey } = gesture;
    if (!target.isConnected) continue;
    if (type === "click" && target.closest("a[href]")) continue;
    // The binding that adopted this control wrote the row's value over it. A file input's value
    // is not the browser's to take back, and its files stayed.
    if ((type === "input" || type === "change") && typeof value === "string" && target.type !== "file") target.value = value;
    target.addEventListener(type, (e) => e.preventDefault(), { capture: true, once: true });
    target.dispatchEvent(Object.assign(new (doc.defaultView.Event)(type, { bubbles: true, cancelable: true }), { key, shiftKey, altKey, ctrlKey, metaKey }));
    await settle();
  }
}
