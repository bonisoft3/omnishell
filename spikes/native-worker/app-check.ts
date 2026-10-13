const [capture, output] = Deno.args;
if (!capture || !output) {
	throw new Error("app-check.ts <capture-directory> <output-html>");
}
const fixture = JSON.parse(await Deno.readTextFile(capture + "/fixture.json"));
const key = (pathname, params) =>
	pathname + "?" + [...params]
		.sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + "=" + v).join(
			"&",
		);
const rows = new Map();
for (const [query, value] of Object.entries(fixture.queries)) {
	const [table, order, opts] = JSON.parse(query);
	if (fixture.cfg.local[table]) continue;
	const params = new URLSearchParams(opts.filter);
	params.set("select", opts.select ?? "*");
	if (order ?? opts.order) params.set("order", order ?? opts.order);
	rows.set(key("/" + table, params), value);
}
const reads = new Set();
const reader = {
	async read(path) {
		reads.add(path);
		const url = new URL(path, "https://snapshot.test");
		const found = rows.get(key(url.pathname, url.searchParams));
		if (!found) throw new Error("uncaptured query: " + path);
		return structuredClone(found);
	},
};
// SES installs rejection reporting; keep a failing harness's exit status explicit.
try {
	const { renderApp } = await import("./app-document.ts");
	const start = performance.now();
	const result = await renderApp(fixture.pathname, reader);
	if (result.status !== 200 || !result.html.includes("data-served")) {
		throw new Error("expected a served document");
	}
	await Deno.writeTextFile(output, result.html);
	console.log(
		JSON.stringify({
			ms: performance.now() - start,
			bytes: result.html.length,
			reads: reads.size,
		}),
	);
	Deno.exit(0);
} catch (error) {
	console.error(error);
	Deno.exit(1);
}
