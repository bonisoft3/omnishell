import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const b = await chromium.launch();
const bundle = readFileSync(process.argv[2], "utf8");
const run = async (how) => {
  const p = await b.newPage();
  await p.setContent(`<ul id=list></ul>`);
  await p.addScriptTag({ content: bundle, type: "module" });
  await p.waitForFunction(() => globalThis.rows !== undefined);
  const r = await p.evaluate((how) => {
    const { udomdiff } = globalThis.rows;
    const list = document.getElementById("list");
    window.loads = 0;
    window.addEventListener("message", (e) => { if (e.data === "l") window.loads++; });
    const pool = new Map();
    const nodeFor = (id) => {
      if (!pool.has(id)) {
        const li = document.createElement("li"); li.dataset.id = id;
        const f = document.createElement("iframe");
        f.setAttribute("sandbox", "allow-scripts");
        f.src = "data:text/html,<script>parent.postMessage('l','*')<\/script>";
        li.append(f); pool.set(id, li);
      }
      return pool.get(id);
    };
    const ids = Array.from({ length: 20 }, (_, i) => `r${i}`);
    for (const id of ids) list.appendChild(nodeFor(id));
    const to = ids.slice(); [to[3], to[16]] = [to[16], to[3]];
    return new Promise((res) => setTimeout(() => {
      const before = window.loads;
      const order = to.map(nodeFor);
      if (how === "udomdiff") udomdiff(list, [...list.childNodes], order, (n) => n, null);
      else {
        let cursor = list.firstElementChild;
        for (const node of order) {
          if (cursor === node) { cursor = cursor.nextElementSibling; continue; }
          how === "moveBefore" ? list.moveBefore(node, cursor) : list.insertBefore(node, cursor);
        }
      }
      setTimeout(() => res({ how, loadsBefore: before, loadsAfter: window.loads,
        reloads: window.loads - before,
        correct: JSON.stringify([...list.children].map((l) => l.dataset.id)) === JSON.stringify(to) }), 600);
    }, 600));
  }, how);
  await p.close();
  return r;
};
for (const how of ["insertBefore", "moveBefore", "udomdiff"]) console.log(JSON.stringify(await run(how)));
await b.close();
