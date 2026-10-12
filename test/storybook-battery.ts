import { parseHTML } from "npm:linkedom@0.18.4";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FuelMeter } from "./fuel-meter.ts";
import {
  extractRegions,
  generateIsolatedFrames,
  generatePairwiseFrames,
  type PosedFrame,
} from "./storybook-injector.ts";
import type { Machine } from "./canonical.ts";

export type TableRows = Record<string, Record<string, unknown>[]>;

async function loadAppSeeds(appDir: string): Promise<TableRows> {
  const seedsPath = join(appDir, ".pronto", "seeds.json");
  try {
    const raw = await Deno.readTextFile(seedsPath);
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) {
      return parsed as TableRows;
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return {};
}
import {
  appMessages,
  appUnits,
  appRoutes,
  appI18n,
  topLayer,
  type Catalogs,
} from "./screen-harness.ts";
import { screenEnv } from "../interpreter/fragment.js";

export type BatteryAppReport = {
  app: string;
  screensChecked: number;
  machinesPosed: number;
  totalFrames: number;
  totalFuelSpent: number;
  mutationsDispatched: number;
  success: boolean;
  errors: string[];
};

export type BatteryOptions = {
  fuelLimitPerFrame?: number;
  maxScreens?: number;
  includePairwise?: boolean;
};

function makeProxyRow(
  base: Record<string, unknown>,
  table: string,
  seeds: TableRows,
): Record<string, unknown> {
  const seedRow = seeds[table]?.[0] ?? {};
  const merged: Record<string, unknown> = { ...seedRow, ...base };
  return new Proxy(merged, {
    get: (target, prop) => {
      if (typeof prop !== "string") return undefined;
      if (prop in target) return target[prop];
      if (prop === "id") return `${table}_0001`;
      if (prop === "locale" || prop.endsWith("_locale")) return "en";
      if (prop === "currency" || prop.endsWith("_currency")) return "USD";
      if (prop === "timeZone" || prop.endsWith("_timezone") || prop.endsWith("_tz")) return "UTC";
      if (prop.startsWith("cur_") || prop.startsWith("chk_") || prop.startsWith("exp_") || prop.startsWith("is_")) return "false";
      if (prop.endsWith("_date") || prop === "date" || prop.endsWith("_at") || prop === "at" || prop.endsWith("_time") || prop === "time") return "2026-09-24T00:00:00Z";
      return `Sample ${prop}`;
    },
    has: () => true,
  });
}

function createProxyMessages(
  discovered: Catalogs,
): Catalogs {
  const defaultCatalog = discovered.en ?? Object.values(discovered)[0] ?? {};
  const proxyCatalog = new Proxy(defaultCatalog, {
    get: (target, key) => {
      if (typeof key !== "string") return undefined;
      return target[key] ?? key;
    },
  });

  return new Proxy(discovered, {
    get: (target, locale) => {
      if (typeof locale !== "string") return undefined;
      if (locale in target) {
        return new Proxy(target[locale], {
          get: (cat, k) => (typeof k === "string" ? (cat[k] ?? proxyCatalog[k]) : undefined),
        });
      }
      return proxyCatalog;
    },
  });
}

export async function runStorybookBatteryForApp(
  appUrl: URL,
  options: BatteryOptions = {},
): Promise<BatteryAppReport> {
  const fuelLimit = options.fuelLimitPerFrame ?? 3000;
  const appDir = fileURLToPath(appUrl);
  const appName = basename(appDir);

  const report: BatteryAppReport = {
    app: appName,
    screensChecked: 0,
    machinesPosed: 0,
    totalFrames: 0,
    totalFuelSpent: 0,
    mutationsDispatched: 0,
    success: true,
    errors: [],
  };

  const seeds = await loadAppSeeds(appDir);

  const discoveredMessages = await appMessages(appUrl);
  const messages = createProxyMessages(discoveredMessages);
  const units = await appUnits(appUrl);
  const routes = await appRoutes(appUrl);
  const i18n = await appI18n(appUrl);

  const screensDir = join(appDir, "shell", "screens");
  const screenFiles: string[] = [];
  try {
    for await (const entry of Deno.readDir(screensDir)) {
      if (entry.isFile && entry.name.endsWith(".html")) {
        screenFiles.push(entry.name);
      }
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return report;
    throw err;
  }

  screenFiles.sort();

  const { interpretScreen } = await import("../interpreter/screen.js");

  for (const screenFile of screenFiles) {
    report.screensChecked++;
    const screenName = screenFile.replace(/\.html$/, "");
    const htmlPath = join(screensDir, screenFile);
    const cssPath = join(screensDir, `${screenName}.css`);

    const html = await Deno.readTextFile(htmlPath);

    let css = "";
    try {
      css = await Deno.readTextFile(cssPath);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }

    const { document: domDoc } = parseHTML(html);
    const machineEls = domDoc.querySelectorAll("[data-machine]");

    const paramMatches = [...html.matchAll(/\{param\.(\w+)\}/g)].map((m) => m[1]);
    const params = {
      id: "fixture-id",
      slug: "fixture-slug",
      code: "fixture-code",
      tag: "fixture-tag",
      ...Object.fromEntries(paramMatches.map((p) => [p, `fixture-${p}`])),
    };

    const framesToTest: { frame: PosedFrame; regionTable: string }[] = [];

    for (let elIdx = 0; elIdx < machineEls.length; elIdx++) {
      const el = machineEls[elIdx];
      const rawMachine = el.getAttribute("data-machine");
      if (!rawMachine) continue;

      let parsedMachine: Machine | Machine[];
      try {
        parsedMachine = JSON.parse(rawMachine);
      } catch (err) {
        throw new SyntaxError(`Corrupted data-machine attribute in ${htmlPath}: ${rawMachine}`, {
          cause: err,
        });
      }

      const machineList = Array.isArray(parsedMachine) ? parsedMachine : [parsedMachine];
      const machineContext: Record<string, unknown> = {};
      for (const m of machineList) {
        if (m.context && typeof m.context === "object") {
          Object.assign(machineContext, m.context);
        }
      }
      const table = el.getAttribute("data-live") ?? "item";
      const baseRow = { ...(seeds[table]?.[0] ?? { id: `${table}_0001` }), ...machineContext };

      for (const m of machineList) {
        report.machinesPosed++;
        const regions = extractRegions(m);

        const isolated = generateIsolatedFrames(regions, baseRow);
        for (const f of isolated) {
          const curKeys = Object.keys(f.row).filter((k) => k.startsWith("cur_"));
          if (curKeys.length > 0) {
            const activeCur = `cur_${f.state}`;
            if (curKeys.includes(activeCur)) {
              for (const k of curKeys) {
                f.row[k] = k === activeCur ? "true" : "false";
              }
            }
          }
          framesToTest.push({
            frame: f,
            regionTable: table,
          });
        }

        if (options.includePairwise && regions.length >= 2) {
          const pairwise = generatePairwiseFrames(regions[0], regions[1], baseRow);
          for (const f of pairwise) {
            framesToTest.push({
              frame: f,
              regionTable: table,
            });
          }
        }
      }
    }

    if (framesToTest.length === 0) {
      const states = ["populated", "empty", "loading"];
      for (const st of states) {
        framesToTest.push({
          frame: {
            name: `${screenName}-${st}`,
            targetRegion: "screen",
            state: st,
            row: { id: "seed_0001", state: st },
            visualInvariants: {},
          },
          regionTable: "item",
        });
      }
    }

    for (const { frame, regionTable } of framesToTest) {
      report.totalFrames++;

      const fuel = new FuelMeter({
        limit: fuelLimit,
        fireCost: 10,
        transitionCost: 25,
        mutationCost: 50,
      });

      const mutations: Record<string, unknown>[] = [];
      const testStore = {
        query: async (tbl: string, _order: unknown, opts: { singleton?: boolean }) => {
          fuel.spend("fire", 1, `query_${tbl}`);
          const tblSeeds = seeds[tbl] ?? [];
          const rows = tblSeeds.map((s: Record<string, unknown>) => makeProxyRow(s, tbl, seeds));

          if (tbl === regionTable && frame.row && typeof frame.row === "object") {
            const targetRow = makeProxyRow(frame.row, tbl, seeds);
            const list = [targetRow, ...rows];
            return opts?.singleton ? [list[0]] : list;
          }
          if (rows.length > 0) {
            return opts?.singleton ? [rows[0]] : rows;
          }
          const fallback = makeProxyRow({}, tbl, seeds);
          return [fallback];
        },
        subscribe: () => () => {},
        create: async (_tbl: string, row: Record<string, unknown>) => {
          report.mutationsDispatched++;
          mutations.push({ op: "create", row });
          throw new Error("storybook is read-only");
        },
        update: async (_tbl: string, row: Record<string, unknown>) => {
          report.mutationsDispatched++;
          mutations.push({ op: "update", row });
          throw new Error("storybook is read-only");
        },
        put: async (_tbl: string, row: Record<string, unknown>) => {
          report.mutationsDispatched++;
          mutations.push({ op: "put", row });
          throw new Error("storybook is read-only");
        },
        write: async () => {
          report.mutationsDispatched++;
          throw new Error("storybook is read-only");
        },
        drop: async () => {
          report.mutationsDispatched++;
          throw new Error("storybook is read-only");
        },
        patch: async () => {
          report.mutationsDispatched++;
          throw new Error("storybook is read-only");
        },
        remove: async () => {
          report.mutationsDispatched++;
          throw new Error("storybook is read-only");
        },
        removeWhere: async () => {
          report.mutationsDispatched++;
          throw new Error("storybook is read-only");
        },
      };

      const { document: frameDoc } = parseHTML(
        "<!doctype html><html><head></head><body><div id=shell></div></body></html>",
      );
      topLayer(frameDoc, (frameDoc.defaultView as unknown as { Event: new (t: string, i: object) => object }).Event);

      const prevDoc = (globalThis as Record<string, unknown>).document;
      const prevFetch = (globalThis as Record<string, unknown>).fetch;

      const mount = frameDoc.getElementById("shell");

      const route = {
        screen: screenName,
        path: `/${screenName}`,
        files: { html: `${screenName}.html`, css: `${screenName}.css`, handlers: [] },
        states: [frame.state],
      };

      let handle: { stop?: () => void } | undefined;
      try {
        (globalThis as Record<string, unknown>).document = frameDoc;
        (globalThis as Record<string, unknown>).fetch = (url: unknown) => {
          const u = String(url);
          if (u.endsWith(".html")) return Promise.resolve(new Response(html));
          if (u.endsWith(".css")) return Promise.resolve(new Response(css));
          return Promise.reject(new Error(`unexpected fetch ${u}`));
        };

        const env = screenEnv(
          {
            units,
            routes,
            i18n,
          },
          {
            handlers: false,
            fixtures: true,
            units,
            messages,
            routes,
            i18n,
            timeZone: "UTC",
          },
        );

        handle = await interpretScreen(mount, "http://localhost:8080/shell/", route, testStore, params, env);

        fuel.spend("transition", 1, `posed_${frame.name}`);
        report.totalFuelSpent += fuel.current;

        if (mutations.length > 0) {
          report.success = false;
          report.errors.push(
            `Frame "${frame.name}" in screen "${screenName}" dispatched ${mutations.length} mutations`,
          );
        }

        if (fuel.remaining <= 0) {
          report.success = false;
          report.errors.push(
            `Frame "${frame.name}" in screen "${screenName}" exceeded fuel budget (${fuel.current}/${fuel.limit})`,
          );
        }
      } catch (err) {
        report.success = false;
        report.errors.push(
          `Frame "${frame.name}" in screen "${screenName}" threw error: ${String(err)}`,
        );
      } finally {
        handle?.stop?.();
        (globalThis as Record<string, unknown>).document = prevDoc;
        (globalThis as Record<string, unknown>).fetch = prevFetch;
      }
    }
  }

  return report;
}
