import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const bundle = readFileSync(process.argv[2], "utf8");
const b = await chromium.launch();
const p = await b.newPage();
await p.setContent(`<article id=body></article>`);
await p.addScriptTag({ content: bundle, type: "module" });
await p.waitForFunction(() => globalThis.spike !== undefined);

const out = await p.evaluate(() => {
  const { morphdom, parseMarkdown, buildNodes } = globalThis.spike;
  const live = document.getElementById("body");

  // A realistic Conduit article: 60 blocks of prose with inline markup.
  const article = (n, word) => Array.from({ length: 60 }, (_, i) =>
    `## Section ${i}\n\nParagraph ${i} with **bold** and \`code\` and [a link](https://e.example/${i}).\n` +
    `A second line, ${i === 30 ? word : "steady"}, wrapping on.\n\n- item one\n- item two\n`
  ).join("\n") + `\n\nEdit ${n}\n`;

  // morphdom never sees a string and never builds from a description: the
  // platform builder fills a detached tree, morphdom is handed two DOM trees.
  const viaMorph = (src) => {
    const scratch = document.createElement("article");
    buildNodes(parseMarkdown(src), scratch);
    morphdom(live, scratch, { childrenOnly: true });
  };
  const viaReplace = (src) => buildNodes(parseMarkdown(src), live);

  const measure = (label, apply, first, second) => {
    live.replaceChildren();
    delete live._prontoRendered;
    apply(first);
    const before = [...live.querySelectorAll("*")];
    const sel = live.querySelectorAll("p")[5];
    // A reader's selection inside an untouched paragraph.
    const range = document.createRange();
    range.selectNodeContents(sel);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    const selectedBefore = getSelection().toString().slice(0, 20);

    const t0 = performance.now();
    apply(second);
    const ms = performance.now() - t0;
    const after = new Set(live.querySelectorAll("*"));
    const survived = before.filter((n) => after.has(n)).length;
    return {
      label, nodes: before.length, survived,
      survivedPct: Math.round((survived / before.length) * 100),
      selectionKept: getSelection().toString().slice(0, 20) === selectedBefore,
      ms: Number(ms.toFixed(2)),
    };
  };

  const A = article(1, "steady"), B = article(2, "steady"), C = article(1, "CHANGED");
  const runs = [];
  // Unchanged body: what the existing memo already covers.
  runs.push(measure("unchanged (memo)", viaReplace, A, A));
  runs.push(measure("unchanged (morphdom)", viaMorph, A, A));
  // One word changed deep in the body — the case a differ exists for.
  runs.push(measure("one word changed (replaceChildren)", viaReplace, A, C));
  runs.push(measure("one word changed (morphdom)", viaMorph, A, C));
  // Trailing block appended.
  runs.push(measure("block appended (replaceChildren)", viaReplace, A, B));
  runs.push(measure("block appended (morphdom)", viaMorph, A, B));
  return runs;
});
for (const r of out) console.log(JSON.stringify(r));
await b.close();
