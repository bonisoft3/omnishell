// A presenter's worker, as both sides of its port see it: the protocol the
// seat (hatch-presenter.js) and the worker (presenter.js) speak, and what the
// worker keeps of its globals when it prunes them before the unit's first line.

export const INIT = "pronto:init";
export const READY = "pronto:ready";
export const FRAME = "pronto:frame";
export const PROPS = "pronto:props";
export const RESIZE = "pronto:resize";
export const READ = "pronto:read";

// The globals of a dedicated worker that are the language's, not the host's.
const INTRINSICS = new Set([
  "Object", "Function", "Array", "Number", "parseFloat", "parseInt", "Infinity", "NaN", "undefined", "Boolean", "String",
  "Symbol", "Date", "Promise", "RegExp", "Error", "AggregateError", "EvalError", "RangeError", "ReferenceError",
  "SyntaxError", "TypeError", "URIError", "globalThis", "JSON", "Math", "Intl", "ArrayBuffer", "Atomics", "Uint8Array",
  "Int8Array", "Uint16Array", "Int16Array", "Uint32Array", "Int32Array", "BigUint64Array", "BigInt64Array",
  "Uint8ClampedArray", "Float32Array", "Float64Array", "Float16Array", "DataView", "Map", "BigInt", "Set", "WeakMap",
  "WeakSet", "Proxy", "Reflect", "FinalizationRegistry", "WeakRef", "decodeURI", "decodeURIComponent", "encodeURI",
  "encodeURIComponent", "escape", "unescape", "eval", "isFinite", "isNaN", "Iterator", "SharedArrayBuffer",
  "DisposableStack", "AsyncDisposableStack", "SuppressedError",
]);

// What a painter needs past the language. Every entry reads, draws or is the
// one channel; none writes anywhere a later visit or another tab could see.
export const ALLOW = {
  self: "the global's own name, which UMD wrappers and feature checks read",
  navigator: "navigator.gpu, the adapter; its writers are deleted below",
  location: "the base URL module specifiers and loaders resolve against",
  console: "diagnostics, which go to the developer's console only",
  performance: "frame timing; it reaches pixels and nothing else",
  setTimeout: "deferred drawing work", clearTimeout: "", setInterval: "", clearInterval: "", queueMicrotask: "",
  requestAnimationFrame: "the frame loop", cancelAnimationFrame: "",
  structuredClone: "copies values within the worker",
  postMessage: "the one channel out, which the seat holds to this file's protocol",
  onmessage: "the seat's channel in", onmessageerror: "", onerror: "",
  addEventListener: "", removeEventListener: "", dispatchEvent: "",
  Event: "", EventTarget: "", MessageEvent: "", ErrorEvent: "", CustomEvent: "", DOMException: "",
  OffscreenCanvas: "the surface the terminal transferred",
  OffscreenCanvasRenderingContext2D: "2D drawing into textures",
  CanvasGradient: "", CanvasPattern: "", Path2D: "", DOMMatrix: "", DOMMatrixReadOnly: "", DOMPoint: "", DOMRect: "",
  ImageData: "texture uploads", ImageBitmap: "", ImageBitmapRenderingContext: "", createImageBitmap: "decoding bytes the seat handed in",
  WebGL2RenderingContext: "the WebGL2 path and WebGPU's feature probe", WebGLRenderingContext: "",
  TextDecoder: "decoding the pinned scripts and shader source", TextEncoder: "",
  Blob: "a loader wraps bytes it holds", File: "", URL: "parsing, and blob: URLs over bytes the worker holds",
  btoa: "base64 over bytes the worker holds", atob: "",
  crypto: "random values for identifiers; it reaches nothing outside",
  // The policy's connect-src is blob:, so these reach only bytes the worker
  // already holds: a loader's way to read them.
  fetch: "blob: only, by the policy", Request: "", Response: "", Headers: "", AbortController: "", AbortSignal: "",
  XMLHttpRequest: "blob: only, by the policy", XMLHttpRequestEventTarget: "", XMLHttpRequestUpload: "", ProgressEvent: "",
};

// What navigator offers that writes: storage, locks, beacons and devices.
const NAVIGATOR_WRITERS = ["storage", "locks", "serviceWorker", "permissions", "connection", "usb", "hid", "serial", "bluetooth", "wakeLock", "sendBeacon", "mediaCapabilities", "ml", "clipboard", "credentials"];

/** Deletes every global the worker was born with that is neither an intrinsic
 * nor allowed, down the global's prototype chain; `endowed` are the globals
 * the pinned scripts defined, which are the unit's to use. A global that
 * refuses deletion is named, so the test holding this file can say what stays. */
export function prune(global = globalThis, endowed = new Set()) {
  const kept = [];
  for (let o = global; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const key of Reflect.ownKeys(o)) {
      if (typeof key !== "string" || key === "constructor" || INTRINSICS.has(key) || key in ALLOW || endowed.has(key) || key.startsWith("GPU")) continue;
      if (!Reflect.deleteProperty(o, key)) kept.push(key);
    }
  }
  const nav = global.navigator;
  for (const key of NAVIGATOR_WRITERS) {
    for (let o = nav; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      if (Object.prototype.hasOwnProperty.call(o, key) && !Reflect.deleteProperty(o, key)) kept.push(`navigator.${key}`);
    }
  }
  return kept;
}
