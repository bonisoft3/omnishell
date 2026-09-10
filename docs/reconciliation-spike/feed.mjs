// Social-feed workload for screen.js's region row reconciliation.
//
// The earlier spike measured a blog: a body that either does not change or
// changes wholesale. A feed is the opposite — head inserts, mid-list removes,
// reorders, counter ticks, and comments appending under one post while the
// rest sit still — so this harness drives that space instead.
//
//   bun docs/reconciliation-spike/feed.mjs <bundled-feed-entry.js>
//
// See README.md for how to produce the bundle.
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";

const bundle = readFileSync(process.argv[2], "utf8");
const browser = await chromium.launch();

// One row = one feed post: two counters that tick, an unsent comment draft, a
// provider embed, a running animation, and a nested comment region.
// The same item markup in two formattings. Morphlex refuses to MATCH
// inter-element whitespace but still inserts the target's copy of it, so how
// the emitted HTML is indented changes its op count — measure both rather than
// indict it for the author's newlines.
const ITEM = {
  pretty: `
    <h3 data-text="{title}"></h3>
    <p data-text="{body}"></p>
    <span class="rx" data-text="{reactions}"></span>
    <span class="cc" data-text="{comment_count}"></span>
    <form><input name="draft"></form>
    <iframe sandbox="allow-scripts" src="data:text/html,<script>parent.postMessage('loaded','*')<\/script>"></iframe>
    <div class="spin"></div>
    <ol class="comments" data-live="comments"></ol>
  `,
};
ITEM.compact = ITEM.pretty.replace(/>\s+</g, "><").trim();

const PAGE = (item) => `
<style>
  @keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
  .spin { animation: spin 4s linear infinite; width: 4px; height: 4px }
</style>
<ol id="region" data-live="posts"></ol>
<template id="item"><li>${item}</li></template>`;

const FORMAT = process.argv[3] ?? "pretty";
// "data-id" withholds the id attribute, which is what a pronto region's rows
// actually carry — the libraries key on `id`, screen.js keys on its own Map.
const KEYING = process.argv[4] ?? "id";

const N = Number(process.argv[5] ?? 20);
const feed = (ids, bump = 0) =>
  ids.map((id) => ({
    id,
    title: `Post ${id}`,
    body: `Body of post ${id}.`,
    reactions: 10 + bump,
    comment_count: 3 + bump,
  }));

const ids = Array.from({ length: N }, (_, i) => `p${i}`);

const scenarios = {
  "insert at head": { to: ["new", ...ids] },
  "insert in middle": { to: [...ids.slice(0, 10), "new", ...ids.slice(10)] },
  "remove from middle": { to: ids.filter((x) => x !== "p10") },
  reverse: { to: [...ids].reverse() },
  // The cursor loop's known pathological shape: two rows exchanging distant
  // positions cascades every row between them. If a longest-increasing-
  // subsequence differ pays anywhere, it pays here.
  "swap two distant rows": {
    to: (() => {
      const a = [...ids];
      [a[3], a[16]] = [a[16], a[3]];
      return a;
    })(),
  },
  "shuffle (seeded)": {
    to: (() => {
      const a = [...ids];
      let seed = 7;
      for (let i = a.length - 1; i > 0; i--) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        const j = seed % (i + 1);
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    })(),
  },
  "near-sorted (one moved far)": {
    to: (() => {
      const a = [...ids];
      a.splice(2, 0, a.splice(15, 1)[0]);
      return a;
    })(),
  },
  "batch text update (no reorder)": { to: ids, bump: 1 },
  "nested region appends": { to: ids, nested: true },
};

// The arms. handRolled is screen.js's loop transcribed; the three libraries
// are driven the way they are meant to be driven — a freshly built target
// tree, morphed into the live one.
const ARMS = ["handRolled", "morphlex", "idiomorph", "morphdom"];

async function run(arm, name, scenario, opts = {}) {
  const page = await browser.newPage();
  await page.setContent(PAGE(ITEM[FORMAT]));
  await page.addScriptTag({ content: bundle, type: "module" });
  await page.waitForFunction(() => globalThis.libs !== undefined);

  const result = await page.evaluate(
    async ([arm, scenario, opts, N]) => {
      const { morphInner, Idiomorph, morphdom } = globalThis.libs;
      const region = document.getElementById("region");
      const template = document.getElementById("item");
      const PLACEHOLDER = /\{([\w.]+)\}/g;
      const HAS_MOVE_BEFORE = typeof Element.prototype.moveBefore === "function";

      const feed = (ids, bump = 0) =>
        ids.map((id) => ({
          id,
          title: `Post ${id}`,
          body: `Body of post ${id}.`,
          reactions: 10 + bump,
          comment_count: 3 + bump,
        }));
      const baseIds = Array.from({ length: N }, (_, i) => `p${i}`);

      // screen.js's ownedBy: a nested region's bindings belong to its own
      // hydrator, never the parent's pass.
      const ownedBy = (el, scope) => {
        for (let n = el; n && n !== scope; n = n.parentElement) {
          if (n.matches?.("[data-live]")) return false;
        }
        return true;
      };
      const bindTexts = (scope, row) => {
        for (const el of scope.querySelectorAll("[data-text]")) {
          if (!ownedBy(el, scope)) continue;
          el.textContent = el.dataset.text.replace(PLACEHOLDER, (_, k) => String(row[k] ?? ""));
        }
      };
      const stamp = (row) => {
        const node = template.content.firstElementChild.cloneNode(true);
        node.dataset.id = row.id;
        // All three libraries key on the `id` ATTRIBUTE; a region's rows carry
        // data-id. Withholding id measures the impedance, granting it measures
        // the libraries at their best.
        if (opts.keying === "id") node.id = `post-${row.id}`;
        bindTexts(node, row);
        return node;
      };
      const isNested = (el) => el !== region && el.matches?.("[data-live]");

      // ---- op counting: only mutations that land on the live document ----
      let ops = 0;
      const byMethod = {};
      const wrap = (obj, name) => {
        const real = obj[name];
        if (typeof real !== "function") return;
        obj[name] = function (...a) {
          if (this.isConnected) {
            ops++;
            byMethod[name] = (byMethod[name] ?? 0) + 1;
          }
          return real.apply(this, a);
        };
      };
      for (const n of ["insertBefore", "appendChild", "removeChild", "replaceChild"]) wrap(Node.prototype, n);
      for (const n of ["moveBefore", "remove", "replaceWith", "before", "after"]) wrap(Element.prototype, n);
      for (const n of ["append", "prepend", "replaceChildren"]) wrap(Element.prototype, n);

      // ---- arms ----
      const live = new Map();
      const handRolled = (rows) => {
        const order = [];
        const seen = new Set();
        for (const row of rows) {
          const key = String(row.id);
          seen.add(key);
          let entry = live.get(key);
          if (entry === undefined) {
            entry = { node: stamp(row) };
            live.set(key, entry);
          } else bindTexts(entry.node, row);
          order.push(entry.node);
        }
        for (const [key, entry] of live) {
          if (seen.has(key)) continue;
          entry.node.remove();
          live.delete(key);
        }
        let cursor = region.firstElementChild;
        for (const node of order) {
          if (cursor === node) {
            cursor = cursor.nextElementSibling;
            continue;
          }
          if (HAS_MOVE_BEFORE && node.isConnected) region.moveBefore(node, cursor);
          else region.insertBefore(node, cursor);
        }
      };

      const target = (rows) => {
        const holder = document.createElement("ol");
        for (const row of rows) holder.append(stamp(row));
        return holder;
      };

      // Every library needs the same two things taught to it: do not descend
      // into a nested region (its rows are another hydrator's output, absent
      // from the target tree), and do not overwrite an unsent draft.
      const viaMorphlex = (rows) =>
        morphInner(region, target(rows), {
          preserveChanges: true,
          beforeChildrenVisited: (el) => !isNested(el),
        });
      const viaIdiomorph = (rows) =>
        // normalizeParent() wraps a lone Element, so handing it the target <ol>
        // makes the whole list one child. Its childNodes are the content.
        Idiomorph.morph(region, target(rows).childNodes, {
          morphStyle: "innerHTML",
          ignoreActiveValue: true,
          callbacks: {
            // ignoreActiveValue only shields the FOCUSED control. An unsent
            // draft in a row the reader has since clicked away from needs the
            // same guard screen.js's _prontoDirty gives it.
            beforeNodeMorphed: (o) =>
              !isNested(o) && !(o.localName === "input" && o.value !== o.defaultValue),
          },
        });
      const viaMorphdom = (rows) =>
        morphdom(region, target(rows), {
          childrenOnly: true,
          onBeforeElChildrenUpdated: (from) => !isNested(from),
          onBeforeElUpdated: (from, to) => {
            // morphdom's own recipe for not clobbering user input.
            if (from.localName === "input" && from.value !== from.defaultValue) {
              to.setAttribute("value", from.value);
              return true;
            }
            return true;
          },
        });
      const apply = { handRolled, morphlex: viaMorphlex, idiomorph: viaIdiomorph, morphdom: viaMorphdom }[arm];

      // ---- initial paint ----
      window.loads = 0;
      window.addEventListener("message", (e) => {
        if (e.data === "loaded") window.loads++;
      });
      apply(feed(baseIds));
      if (region.children.length !== N) {
        return { error: `first paint produced ${region.children.length} rows, wanted ${N}` };
      }

      // A comment already sitting in one nested region, put there by that
      // region's own hydrator — the parent pass must never see or touch it.
      const nestedHost = region.children[3].querySelector(".comments");
      const seededComment = document.createElement("li");
      seededComment.textContent = "an existing comment";
      nestedHost.append(seededComment);

      await new Promise((r) => setTimeout(r, 600));

      // ---- state a reader is holding ----
      const watched = region.children[5];
      const draftInput = watched.querySelector("input");
      draftInput.value = "half-written reply";
      const focusInput = region.children[7].querySelector("input");
      focusInput.focus();
      const spinner = region.children[9].querySelector(".spin");
      const beforeAnim = spinner.getAnimations()[0]?.currentTime ?? null;
      const watchedRef = watched;
      const watchedId = watched.dataset.id;
      const watchedTitle = watched.querySelector("h3").textContent;
      const loadsBefore = window.loads;

      // ---- the edit under test ----
      const rows = feed(scenario.to, scenario.bump ?? 0);
      if (scenario.nested) {
        // A comment arrives under post 3 while the parent list re-binds — the
        // shape of a live feed, and the one the earlier evaluation had no case
        // for.
        const extra = document.createElement("li");
        extra.textContent = "a new comment";
        nestedHost.append(extra);
      }
      ops = 0;
      for (const k of Object.keys(byMethod)) delete byMethod[k];
      const t0 = performance.now();
      apply(rows);
      const ms = performance.now() - t0;

      await new Promise((r) => setTimeout(r, 600));

      const order = [...region.children].map((li) => li.dataset.id);
      const afterAnim = spinner.isConnected ? (spinner.getAnimations()[0]?.currentTime ?? null) : null;
      return {
        ops,
        byMethod: {...byMethod},
        ms: Number(ms.toFixed(2)),
        correct: JSON.stringify(order) === JSON.stringify(scenario.to),
        // Node-state survival — the metric the earlier evaluation established
        // as the one that matters.
        identity: watchedRef.isConnected,
        // The failure a surviving node hides: the node stayed, and the morph
        // rewrote it to a DIFFERENT row. The reader's half-written reply is
        // now hanging off somebody else's post, and every op count and
        // survival flag above still reads clean.
        sameRow:
          watchedRef.dataset.id === watchedId &&
          watchedRef.querySelector("h3").textContent === watchedTitle,
        draft: watchedRef.querySelector("input")?.value === "half-written reply",
        focus: document.activeElement === focusInput,
        // An identity-preserving relocation keeps the animation running; a
        // re-created node restarts it at zero.
        animation: beforeAnim !== null && afterAnim !== null && afterAnim >= beforeAnim,
        iframeReloads: window.loads - loadsBefore,
        nestedKept: nestedHost.isConnected && nestedHost.children.length,
      };
    },
    [arm, scenario, { keying: KEYING }, N],
  );

  await page.close();
  return result;
}

const table = {};
for (const [name, scenario] of Object.entries(scenarios)) {
  table[name] = {};
  for (const arm of ARMS) table[name][arm] = await run(arm, name, scenario);
}
console.log(JSON.stringify(table, null, 1));
await browser.close();
