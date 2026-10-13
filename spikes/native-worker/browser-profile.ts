import { chromium } from "npm:playwright@1.61.1";
import { parseHTML } from "npm:linkedom@0.18.4";

const [url, output, slowdown = "4"] = Deno.args;
if (!url || !output) {
	throw new Error("browser-profile.ts <url> <output-prefix> [CPU-slowdown]");
}
const rate = Number(slowdown);
if (!Number.isFinite(rate) || rate < 1) {
	throw new Error("CPU slowdown must be at least 1");
}
const browser = await chromium.launch();
try {
	const context = await browser.newContext({
		ignoreHTTPSErrors: true,
		serviceWorkers: "block",
		locale: "pt-BR",
		viewport: { width: 412, height: 823 },
		deviceScaleFactor: 1.75,
		isMobile: true,
	});
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const cdp = await context.newCDPSession(page);
	await cdp.send("Network.enable");
	await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
	await cdp.send("Emulation.setCPUThrottlingRate", { rate });
	const network = new Map<string, Record<string, unknown>>();
	cdp.on("Network.requestWillBeSent", (event) => {
		network.set(event.requestId, {
			url: event.request.url,
			type: event.type,
			start: event.timestamp,
		});
	});
	cdp.on("Network.responseReceived", (event) => {
		Object.assign(network.get(event.requestId) ?? {}, {
			status: event.response.status,
			response: event.timestamp,
		});
	});
	cdp.on("Network.loadingFinished", (event) => {
		Object.assign(network.get(event.requestId) ?? {}, {
			end: event.timestamp,
			bytes: event.encodedDataLength,
		});
	});
	await page.addInitScript(() => {
		const state = globalThis.__renderProfile = {
			longTasks: [],
			paints: [],
			lcp: [],
			events: {},
			rows: [],
			heading: null,
		};
		for (
			const [type, key] of [["longtask", "longTasks"], ["paint", "paints"], [
				"largest-contentful-paint",
				"lcp",
			]]
		) {
			new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) state[key].push(entry.toJSON());
			}).observe({ type, buffered: true });
		}
		let parsed = false, served = null;
		const observer = new MutationObserver(() => {
			if (
				!state.events.heading &&
				document.querySelector(".team-membership-heading h1")
			) state.events.heading = performance.now();
			if (
				!state.events.chart &&
				document.querySelector(".position-odds-graph svg")
			) state.events.chart = performance.now();
			if (
				served && !served.hasAttribute("data-served") && !state.events.adopted
			) state.events.adopted = performance.now();
			if (parsed && state.events.chart && (!served || state.events.adopted)) {
				observer.disconnect();
			}
		});
		observer.observe(document, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["data-served"],
		});
		document.addEventListener("DOMContentLoaded", () => {
			parsed = true;
			served = document.querySelector(".shell-screen[data-served]");
			if (served) {
				state.heading = served.querySelector(".team-membership-heading h1");
				state.rows = [...served.querySelectorAll("[data-id]")];
				state.events.served = performance.now();
			}
		}, { once: true });
	});
	await cdp.send("Profiler.enable");
	await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
	await cdp.send("Profiler.start");
	const response = await page.goto(url, {
		waitUntil: "domcontentloaded",
		timeout: 60000,
	});
	if (response?.status() !== 200) {
		throw new Error(`navigation returned ${response?.status()}`);
	}
	const html = await response.text();
	await page.waitForFunction(
		() =>
			document.querySelector(
				".shell-screen:not([data-served]) .position-odds-graph svg",
			),
		undefined,
		{ timeout: 60000 },
	);
	// Include the immediate follow-up work without waiting for live streams to close.
	await page.waitForTimeout(2000);
	const { profile } = await cdp.send("Profiler.stop");
	const timing = await page.evaluate(() => {
		const s = globalThis.__renderProfile;
		return {
			events: s.events,
			longTasks: s.longTasks,
			paints: s.paints,
			lcp: s.lcp,
			navigation: performance.getEntriesByType("navigation")[0].toJSON(),
			adoption: {
				headingRetained: s.heading !== null &&
					s.heading === document.querySelector(".team-membership-heading h1"),
				rowsRetained: s.rows.filter((node) => node.isConnected).length,
				rows: s.rows.length,
			},
		};
	});
	const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
	const totals = new Map<string, number>();
	for (let i = 0; i < profile.samples.length; i++) {
		const frame = nodes.get(profile.samples[i])!.callFrame;
		const key = JSON.stringify([
			frame.functionName || "(anonymous)",
			frame.url,
			frame.lineNumber + 1,
		]);
		totals.set(key, (totals.get(key) ?? 0) + profile.timeDeltas[i] / 1000);
	}
	const topSelf = [...totals].sort((a, b) => b[1] - a[1]).slice(0, 60)
		.map(([key, ms]) => ({ frame: JSON.parse(key), sampledMs: ms }));
	const fcp = timing.paints.find((paint) =>
		paint.name === "first-contentful-paint"
	)?.startTime;
	if (fcp === undefined) {
		throw new Error("first contentful paint was not observed");
	}
	const observedBlockingMs = timing.longTasks.reduce(
		(sum, task) =>
			sum +
			Math.max(
				0,
				task.startTime + task.duration - Math.max(fcp, task.startTime + 50),
			),
		0,
	);
	const report = {
		url,
		finalUrl: page.url(),
		date: new Date().toISOString(),
		browser: browser.version(),
		cpuSlowdown: rate,
		htmlBytes: new TextEncoder().encode(html).length,
		servedHtml: !!parseHTML(html).document.querySelector(
			".shell-screen[data-served]",
		),
		observedBlockingMs,
		timing,
		topSelf,
		network: [...network.values()],
		errors,
		scope:
			"Cold browser context, cache disabled, explicit CPU slowdown, unthrottled network, sampled main-thread CPU. Observed blocking covers FCP through two seconds after chart readiness, not Lighthouse TBT/TTI. The supplied origin determines the SSR data source; this browser profile alone does not establish freshness.",
	};
	await Deno.writeTextFile(
		output + ".json",
		JSON.stringify(report, null, 2) + "\n",
	);
	await Deno.writeTextFile(output + ".cpuprofile", JSON.stringify(profile));
	console.log(
		JSON.stringify(
			{
				output,
				servedHtml: report.servedHtml,
				observedBlockingMs,
				events: timing.events,
				adoption: timing.adoption,
				errors,
				topSelf: topSelf.slice(0, 12),
			},
			null,
			2,
		),
	);
	if (errors.length) {
		throw new AggregateError(errors, "browser errors during profile");
	}
	await context.close();
} finally {
	await browser.close();
}
