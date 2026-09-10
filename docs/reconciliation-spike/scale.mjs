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
  const nodeFor = (id) => { if (!pool.has(id)) { const li = document.createElement("li"); li.dataset.id = id; li.textContent = id; pool.set(id, li); } return pool.get(id); };
  let ops = 0;
  const ri = Node.prototype.insertBefore, rm = Element.prototype.moveBefore;
  Node.prototype.insertBefore = function (...a) { ops++; return ri.apply(this, a); };
  Element.prototype.moveBefore = function (...a) { ops++; return rm.apply(this, a); };
  const out = [];
  for (const n of [20, 200, 1000]) {
    const ids = Array.from({ length: n }, (_, i) => `r${i}`);
    const to = ids.slice(); [to[1], to[n - 2]] = [to[n - 2], to[1]];   // swap first-ish and last-ish
    const row = { rows: n };
    for (const how of ["insertBefore", "moveBefore", "udomdiff"]) {
      list.replaceChildren(); pool.clear();
      for (const id of ids) list.appendChild(nodeFor(id));
      const order = to.map(nodeFor);
      ops = 0;
      const t0 = performance.now();
      if (how === "udomdiff") udomdiff(list, [...list.childNodes], order, (x) => x, null);
      else { let c = list.firstElementChild; for (const nd of order) { if (c === nd) { c = c.nextElementSibling; continue; } how === "moveBefore" ? list.moveBefore(nd, c) : list.insertBefore(nd, c); } }
      row[how] = { ops, ms: Number((performance.now() - t0).toFixed(2)) };
    }
    out.push(row);
  }
  return out;
}, null), null, 1));
await b.close();
