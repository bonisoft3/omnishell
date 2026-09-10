import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const b = await chromium.launch();
const p = await b.newPage();
await p.setContent(`<ul id=list></ul>`);
await p.addScriptTag({ content: readFileSync(process.argv[2], "utf8"), type: "module" });
await p.waitForFunction(() => globalThis.rows !== undefined);

console.log(JSON.stringify(await p.evaluate(() => {
  const { udomdiff } = globalThis.rows;
  const list = document.getElementById("list");
  const pool = new Map();
  const nodeFor = (id) => {
    if (!pool.has(id)) {
      const li = document.createElement("li");
      li.dataset.id = id;
      pool.set(id, li);
    }
    return pool.get(id);
  };

  // Count real DOM mutations, not wall time: this is what costs a reader
  // their focus, their scroll and their iframe.
  let ops = 0;
  const realInsert = Node.prototype.insertBefore;
  const realAppend = Node.prototype.appendChild;
  const realMove = Element.prototype.moveBefore;
  Node.prototype.insertBefore = function (...a) { ops++; return realInsert.apply(this, a); };
  Node.prototype.appendChild = function (...a) { ops++; return realAppend.apply(this, a); };
  Element.prototype.moveBefore = function (...a) { ops++; return realMove.apply(this, a); };

  // screen.js's current algorithm, transcribed.
  const handRolled = (order) => {
    let cursor = list.firstElementChild;
    for (const node of order) {
      if (cursor === node) { cursor = cursor.nextElementSibling; continue; }
      list.insertBefore(node, cursor);
    }
  };
  const handRolledMove = (order) => {
    let cursor = list.firstElementChild;
    for (const node of order) {
      if (cursor === node) { cursor = cursor.nextElementSibling; continue; }
      node.isConnected ? list.moveBefore(node, cursor) : list.insertBefore(node, cursor);
    }
  };
  const viaUdomdiff = (order) => {
    const prev = [...list.childNodes];
    udomdiff(list, prev, order, (n) => n, null);
  };

  const ids = (n) => Array.from({ length: n }, (_, i) => `r${i}`);
  const scenarios = {
    "reverse 20": [ids(20), ids(20).slice().reverse()],
    "swap two (20)": [ids(20), (() => { const a = ids(20); [a[3], a[16]] = [a[16], a[3]]; return a; })()],
    "prepend one (20)": [ids(20), ["new", ...ids(20)]],
    "delete middle (20)": [ids(20), ids(20).filter((x) => x !== "r10")],
    "move one to front (20)": [ids(20), (() => { const a = ids(20); a.unshift(a.splice(15, 1)[0]); return a; })()],
  };

  const out = {};
  for (const [name, [from, to]] of Object.entries(scenarios)) {
    out[name] = {};
    for (const [how, apply] of [["handRolled", handRolled], ["handRolled+moveBefore", handRolledMove], ["udomdiff", viaUdomdiff]]) {
      list.replaceChildren();
      pool.clear();
      for (const id of from) list.appendChild(nodeFor(id));
      // screen.js evicts departed rows before its move loop; model that, or
      // the comparison indicts a step the real algorithm does not take.
      const keep = new Set(to);
      for (const li of [...list.children]) if (!keep.has(li.dataset.id)) li.remove();
      ops = 0;
      apply(to.map(nodeFor));
      const got = [...list.children].map((li) => li.dataset.id);
      out[name][how] = { ops, correct: JSON.stringify(got) === JSON.stringify(to) };
    }
  }
  return out;
}, null), null, 1));
await b.close();
