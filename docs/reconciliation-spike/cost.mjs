import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const b = await chromium.launch();
const p = await b.newPage();
await p.setContent(`<article id=body></article>`);
await p.addScriptTag({ content: readFileSync(process.argv[2], "utf8"), type: "module" });
await p.waitForFunction(() => globalThis.spike !== undefined);
console.log(JSON.stringify(await p.evaluate(() => {
  const { parseMarkdown, buildNodes } = globalThis.spike;
  const live = document.getElementById("body");
  const src = Array.from({ length: 60 }, (_, i) =>
    `## Section ${i}\n\nParagraph ${i} with **bold** and \`code\` and [a link](https://e.example/${i}).\nA second line, wrapping on.\n\n- item one\n- item two\n`).join("\n");
  const time = (n, fn) => { const t = performance.now(); for (let i = 0; i < n; i++) fn(); return Number(((performance.now() - t) / n).toFixed(3)); };
  const N = 200;
  const nodes = parseMarkdown(src);
  buildNodes(nodes, live);                    // prime the memo
  return {
    blocks: nodes.length,
    domNodes: live.querySelectorAll("*").length,
    parse_ms: time(N, () => parseMarkdown(src)),
    stringify_ms: time(N, () => JSON.stringify(nodes)),
    // What a re-bind costs today with the body unchanged: parse + stringify,
    // then the memo short-circuits before any DOM work.
    rebind_unchanged_ms: time(N, () => buildNodes(parseMarkdown(src), live)),
    // What it would cost if the source string were compared before parsing.
    rebind_if_memo_on_source_ms: time(N, () => { const s = src; if (live._src === s) return; live._src = s; }),
  };
}, null)));
await b.close();
