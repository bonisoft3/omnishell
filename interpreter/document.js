// A route's whole document, rendered anywhere a DOM exists: the app's entry
// page with the screen already in its mount, the strip already beside it and
// the head already saying what the page is. What a reader's browser paints
// before a script has run, and what a crawler reads.
//
// The screen is the interpreter's own render, so the document and the screen
// the shell mounts are one rendering of one template, and the head says which
// (`pronto-cas`, screen.js templateHash): the shell takes this screen over in
// place, morphing it first only when its template has moved on (screen.js
// adoptTree, shell.js show).
//
// The interpreter reads the ambient `document`, so a render owns it for its
// duration and one process renders one document at a time.

import { describe, drawStrip, guestBox, hasStrip, localizeStrip, offersGuest } from "./chrome.js";
import { screenEnv } from "./fragment.js";
import { hasOnMutation, interpretScreen } from "./screen.js";
import { assetURL, preloadScreen } from "./preloads.js";

/** Whether a reader of this app arrives as a guest: the session every app with
 * a table of its own hands out, unless it walls itself behind a sign-in. A
 * document is drawn for no one in particular, so that guest is who it is drawn
 * for. */
export const servesGuests = (cfg) => !cfg.auth?.required && (cfg.tables?.length ?? 0) > 0;

/**
 * One document. `rows` says whether the store answers with the world: a
 * document rendered before any request (no rows to be had) is the screen as it
 * stands before its first read lands, `data-state="loading"`, and says nothing
 * about rows it has not seen — no empty note claims a list is empty.
 *
 * `origin` is what the head's canonical, alternates, og:url and a card image
 * named from the root are spelled against: the deployment's, or, for a
 * document rendered before any request, whatever stands for it where the
 * document is served. `here` is
 * the document's path, which the strip marks as the current page.
 *
 * Answers the html, whether the address names nothing (gone, below), and the
 * interpreter's handle, still standing: the caller stops it, and one that
 * keeps the document can first listen to the reads that drew it.
 *
 * @param {{
 *   entry: string, parse: (html: string) => any, cfg: any, appBase: any, route: any,
 *   params?: object, locale?: string, written?: string, store: any, messages: any,
 *   rows: boolean, origin: string, here?: string,
 * }} options
 */
export async function renderDocument({
  entry,
  parse,
  cfg,
  appBase,
  route,
  params = {},
  locale,
  written,
  store,
  messages,
  rows,
  origin,
  here,
  onHead,
  onChunk,
}) {
  if (typeof origin !== "string") throw new Error("a document's links are absolute, and no origin was given to spell them against");
  const doc = parse(entry);
  const ambient = globalThis.document;
  globalThis.document = doc;
  const decorateDoc = (screen, cas) => {
    if (hasStrip(cfg, null, servesGuests(cfg))) {
      const nav = drawStrip(doc, cfg);
      if (servesGuests(cfg) && offersGuest(cfg)) nav.append(guestBox(doc, cfg));
      localizeStrip(nav, cfg, { locale, here, messages, explicitLocale: Boolean(cfg.i18n && locale === cfg.i18n.default && params?.locale === locale) });
      doc.getElementById("app").before(nav);
    }
    describe(doc, cfg, { route, params, locale, written, el: screen, origin });
    openGraph(doc, { locale, origin });
    const witness = doc.createElement("meta");
    witness.setAttribute("name", "pronto-cas");
    witness.setAttribute("content", cas);
    doc.head.append(witness);
    preloadScreen(doc, appBase, route);
    deferBoot(doc);
  };
  const uncomment = (node) => {
    for (let child = node.firstChild; child !== null;) {
      const next = child.nextSibling;
      if (child.nodeType === 8) child.remove();
      else if (child.nodeType === 1) uncomment(child);
      child = next;
    }
  };
  try {
    const mount = doc.getElementById("app");
    if (mount === null) throw new Error("the entry page has no #app to render into");
    const slot = doc.createElement("div");
    slot.className = "shell-screen";
    // Said, so the shell that boots over it, and anything waiting on the
    // screen a reader can use, can tell the two apart.
    slot.setAttribute("data-served", "");
    mount.append(slot);
    let headGone = false;
    let decorated = false;
    let resolveSettled;
    let rejectSettled;
    const settled = new Promise((resolve, reject) => {
      resolveSettled = resolve;
      rejectSettled = reject;
    });
    settled.catch(() => {});
    let streamPromise = null;
    const handle = await interpretScreen(slot, appBase, route, store, params, screenEnv(cfg, {
      messages,
      locale,
      // A moment is drawn in one zone for every reader, and UTC is the one no
      // reader's machine decides; the shell's render re-draws it in theirs.
      timeZone: "UTC",
      // Nothing is mounted where nothing runs: a unit's frame or worker
      // belongs to the shell, which mounts it into the screen it takes over.
      mountUnits: false,
      mountHostDom: false,
      navigate: () => {
        throw new Error("a rendered document navigates by its links");
      },
      ...(rows && onChunk
        ? {
            onHeadReady: (screen, cas) => {
              const startStream = () => {
                store.assertHealthy?.();
                headGone = gone(screen, cfg);
                if (!headGone) {
                  decorateDoc(screen, cas);
                  decorated = true;
                }
                onHead?.({ status: headGone ? 404 : 200, gone: headGone });
                if (!headGone) {
                  return streamDocument(doc, settled, onChunk);
                }
              };
              if (hasOnMutation(screen)) {
                streamPromise = settled.then(startStream);
                return;
              }
              streamPromise = startStream() ?? null;
            },
          }
        : {}),
      ...(rows ? {} : { handlers: false, fixtures: true }),
    }));
    // Whatever throws from here leaves the handle standing with no caller to
    // stop it, and its regions listening to a store for a document nobody holds.
    let drawn = false;
    try {
      if (rows) {
        try {
          await handle.settle();
          store.assertHealthy?.();
          resolveSettled();
        } catch (err) {
          rejectSettled(err);
          await streamPromise?.catch(() => {});
          throw err;
        }
      } else {
        resolveSettled();
      }
      if (streamPromise !== null) await streamPromise;
      const screen = slot.firstElementChild;
      if (!rows) {
        for (const region of screen.querySelectorAll("[data-live]")) region._prontoEmpty?.remove();
        screen.setAttribute("data-state", "loading");
      }

      if (!decorated) {
        decorateDoc(screen, handle.cas);
      }

      // The entry's comments explain the entry to whoever edits it, and the
      // screen's explain the screen; a document is read by a browser and a
      // crawler, neither of whom can act on them.
      uncomment(doc.documentElement);
      const isGone = rows && (decorated ? headGone : gone(screen, cfg));
      const html = serialize(doc);
      if (onChunk && isGone) onChunk(html);
      const answer = { html, handle, gone: isGone };
      drawn = true;
      return answer;
    } finally {
      if (!drawn) handle.stop();
    }
  } finally {
    globalThis.document = ambient;
  }
}

const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

function openTagOf(el) {
  const outer = el.cloneNode(false).outerHTML;
  if (VOID_ELEMENTS.has(el.localName)) return outer;
  const close = `</${el.localName}>`;
  if (outer.endsWith(close)) return outer.slice(0, -close.length);
  if (outer.endsWith("/>")) return `${outer.slice(0, -2).trimEnd()}>`;
  return outer;
}

async function streamDocument(doc, settled, onChunk) {
  let buf = "<!doctype html>\n";
  const flush = () => {
    if (buf.length > 0) {
      onChunk(buf);
      buf = "";
    }
  };
  flush();
  const screenNeedsSettled = hasOnMutation(doc.documentElement);
  const walkChildren = (parent, children = [...parent.childNodes], index = 0) => {
    for (let i = index; i < children.length; i++) {
      const child = children[i];
      if (child.parentNode !== parent) {
        throw new Error("streamed DOM node was detached before completion");
      }
      const p = walk(child);
      if (p !== undefined) {
        return (async () => {
          await p;
          if (child.parentNode !== parent) {
            throw new Error("streamed DOM node was detached before completion");
          }
          const next = walkChildren(parent, children, i + 1);
          if (next !== undefined) await next;
        })();
      }
    }
    return undefined;
  };
  const finishElement = (node) => {
    if (node.localName === "body") {
      flush();
      return settled.then(() => {
        onChunk("", { beforeBodyClose: true });
        buf += `</${node.localName}>`;
      });
    }
    buf += `</${node.localName}>`;
    return undefined;
  };
  const walkBody = (node) => {
    buf += openTagOf(node);
    if (VOID_ELEMENTS.has(node.localName)) return undefined;
    const p = walkChildren(node);
    if (p !== undefined) return p.then(() => finishElement(node));
    return finishElement(node);
  };
  const walk = (node) => {
    if (node.nodeType === 8) return undefined;
    if (node.nodeType === 3) {
      const parentTag = node.parentNode?.localName;
      if (parentTag === "script" || parentTag === "style") {
        buf += node.data;
      } else if (parentTag === "title" || parentTag === "textarea") {
        buf += node.data.replace(/&/g, "&amp;").replace(/</g, "&lt;");
      } else {
        buf += node.cloneNode(false).toString();
      }
      return undefined;
    }
    if (node.nodeType !== 1) return undefined;
    if (node.localName === "template") {
      buf += node.outerHTML;
      return undefined;
    }
    if (node.hasAttribute("data-live")) {
      if (screenNeedsSettled || hasOnMutation(node)) {
        flush();
        return settled.then(() => walkBody(node));
      }
      if (node.hasAttribute("data-hydrating")) {
        flush();
        return Promise.race([
          node._prontoOwnReady,
          settled.then(() => Promise.resolve()).then(() => {
            if (node.hasAttribute("data-hydrating")) {
              throw new Error("region stayed hydrating after screen settled");
            }
          }),
        ]).then(() => walkBody(node));
      }
    }
    return walkBody(node);
  };
  await walk(doc.documentElement);
  buf += "\n";
  flush();
}

/** The document as HTML. linkedom writes the text of a `<title>` or a
 * `<textarea>` as it stands, where the HTML serializer escapes it, and both
 * read character references back: a row's `</title>` would otherwise end the
 * title and the rest of its text be parsed as markup. */
export function serialize(doc) {
  for (const el of doc.querySelectorAll("title, textarea")) {
    el.textContent = el.textContent.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  }
  return `<!doctype html>\n${doc.documentElement.outerHTML}\n`;
}

/** Whether the rows an address names do not exist: the screen settled in its
 * `gone` state, which a slot that lost its row sets, or every top-level region
 * the address's :params select from a server table rendered no row. A list
 * has no gone state of its own, and the screen's state is whichever region
 * settled last, so the regions are asked rather than the state alone: a game
 * with no comments yet is a game, and a game id nothing holds is not. */
function gone(screen, cfg) {
  if (screen.getAttribute("data-state") === "gone") return true;
  const tables = new Set(cfg.tables ?? []);
  const subjects = [...screen.querySelectorAll("[data-live]")].filter((region) =>
    !region.parentElement.closest("[data-live]") &&
    tables.has(region.getAttribute("data-live")) &&
    /\{param\./.test(region.getAttribute("data-filter") ?? "")
  );
  return subjects.length > 0 && subjects.every((region) =>
    ((region._prontoItemTemplates?.length ?? 0) > 0 || region.hasAttribute("data-template")) &&
    region.querySelector(":scope > [data-id]") === null
  );
}

/** What a link to the page shows where it is shared: the title the head
 * already carries, its canonical address, and the language it is in. The entry
 * carries an app's social card (pronto's #socialPlan) when it declares one,
 * spelled for the app as a whole: what names this page replaces it, what
 * describes the app stands, and an og:url with no canonical to follow is the
 * app's address, never this one's, so it goes. A card image the entry names
 * from the root is absolute here, as a scraper requires. */
function openGraph(doc, { locale, origin }) {
  const meta = (attr, key, content) => {
    let node = doc.head.querySelector(`meta[${attr}="${key}"]`);
    if (node === null) {
      node = doc.createElement("meta");
      node.setAttribute(attr, key);
      doc.head.append(node);
    }
    node.setAttribute("content", content);
  };
  if (doc.head.querySelector('meta[property="og:type"]') === null) meta("property", "og:type", "website");
  const title = doc.querySelector("title").textContent;
  meta("property", "og:title", title);
  if (doc.head.querySelector('meta[name="twitter:title"]') !== null) meta("name", "twitter:title", title);
  const canonical = doc.head.querySelector('link[rel="canonical"]');
  if (canonical !== null) meta("property", "og:url", canonical.getAttribute("href"));
  else doc.head.querySelector('meta[property="og:url"]')?.remove();
  if (locale !== undefined) meta("property", "og:locale", locale.replace("-", "_"));
  for (const image of doc.head.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]')) {
    const at = image.getAttribute("content");
    if (at.startsWith("/") && !at.startsWith("//")) image.setAttribute("content", `${origin}${at}`);
  }
}

/** The entry asks for the terminal's modules the moment it is parsed, because
 * without them it paints nothing. A document paints without them, so it asks
 * once it has: until then the page's own bytes have the link to themselves.
 * The first contentful paint is the moment, observed rather than guessed at
 * with a frame callback, which runs before the frame it names is presented and
 * so lets a module graph of hundreds of KiB race the paint it was to follow.
 * The preloads go out together, so the graph still loads at once rather than
 * one import at a time. */
function deferBoot(doc) {
  const ahead = [];
  for (const link of doc.head.querySelectorAll('link[rel="modulepreload"], link[rel="preload"]')) {
    ahead.push(Object.fromEntries([...link.attributes].map((a) => [a.name, a.value])));
    link.remove();
  }
  const boot = doc.querySelector("script[type=module][src]");
  if (boot === null) throw new Error("the entry page boots no module");
  const loader = doc.createElement("script");
  loader.setAttribute("type", "module");
  loader.setAttribute("src", assetURL("/omnishell/interpreter/deferred-boot.js", doc).pathname);
  loader.setAttribute("data-pronto-boot", boot.getAttribute("src"));
  loader.setAttribute("data-pronto-preloads", JSON.stringify(ahead));
  const map = doc.getElementById("pronto-assets");
  if (map !== null) boot.before(map);
  boot.replaceWith(loader);
}
