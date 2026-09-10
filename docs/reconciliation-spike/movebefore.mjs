import { chromium } from "@playwright/test";
const b = await chromium.launch();
const run = async (how) => {
  const p = await b.newPage();          // fresh context per arm: one listener, one counter
  await p.setContent(`<ul id=list></ul>`);
  const r = await p.evaluate((how) => {
    const list = document.getElementById("list");
    window.loads = 0;
    window.addEventListener("message", (e) => { if (e.data === "loaded") window.loads++; });
    for (const id of ["a", "b", "c"]) {
      const li = document.createElement("li");
      li.dataset.id = id;
      const f = document.createElement("iframe");
      f.setAttribute("sandbox", "allow-scripts");
      f.src = "data:text/html,<script>parent.postMessage('loaded','*')<\/script>";
      li.append(f);
      list.append(li);
    }
    return new Promise((res) => setTimeout(() => {
      const before = window.loads;
      for (const n of [...list.children].reverse()) {
        how === "moveBefore" ? list.moveBefore(n, list.firstChild) : list.insertBefore(n, list.firstChild);
      }
      setTimeout(() => res({ how, loadsBeforeReorder: before, loadsAfterReorder: window.loads,
        order: [...list.children].map((li) => li.dataset.id) }), 500);
    }, 500));
  }, how);
  await p.close();
  return r;
};
console.log(JSON.stringify(await run("insertBefore")));
console.log(JSON.stringify(await run("moveBefore")));
await b.close();
