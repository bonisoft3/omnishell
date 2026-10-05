export async function releaseManifest(runtime: string, contents: ReadonlyMap<string, string | Uint8Array>) {
  const digest = async (text: string | Uint8Array) => {
    const bytes = await crypto.subtle.digest("SHA-256", typeof text === "string" ? new TextEncoder().encode(text) : new Uint8Array(text))
    return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  }
  const assets = Object.fromEntries(await Promise.all([...contents].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(async ([path, text]) => [path, await digest(text)])))
  const screens = Object.fromEntries(Object.entries(assets)
    .filter(([path]) => /^shell\/screens\/[^/]+\.html$/.test(path))
    .map(([path, html]) => [path, { html, css: assets[path.slice(0, -5) + ".css"] }]))
  const contract = await digest(JSON.stringify([runtime, Object.entries(assets).filter(([path]) =>
    !/^shell\/screens\/[^/]+\.(?:html|css)$/.test(path))]))
  const id = await digest(JSON.stringify([contract, Object.entries(screens)]))
  return { format: 1, id, runtime, contract, screens, assets }
}

// Linkedom has no resource loader; browser tests exercise native CSS loading.
export function simulateStylesheetLoads(document: any) {
  const { MutationObserver, Event } = document.defaultView
  const observer = new MutationObserver((changes: MutationRecord[]) => {
    for (const change of changes) for (const node of change.addedNodes) {
      if (node.nodeName === "STYLE") node.dispatchEvent(new Event("load"))
    }
  })
  observer.observe(document.head, { childList: true })
  return () => observer.disconnect()
}
