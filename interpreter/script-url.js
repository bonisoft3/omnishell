let policy;

// Callers supply platform modules, a unit's declared src, or a blob: URL the
// terminal made of a unit's fetched bytes, whose origin is this one. A remote
// URL can never become executable code in the terminal's realm.
export function scriptURL(value, base = globalThis.location?.href) {
  const url = new URL(value, base);
  if (base && url.origin !== new URL(base).origin) throw new TypeError(`script URL crosses origins: ${url}`);
  if (!["https:", "http:", "blob:"].includes(url.protocol)) throw new TypeError(`script URL scheme refused: ${url.protocol}`);
  if (!globalThis.trustedTypes) return url.href;
  policy ??= trustedTypes.createPolicy("omnishell-url", { createScriptURL: (src) => src });
  return policy.createScriptURL(url.href);
}
