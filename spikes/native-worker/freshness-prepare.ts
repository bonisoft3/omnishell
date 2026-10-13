const here = new URL('.', import.meta.url);
const base = JSON.parse(
	await Deno.readTextFile(new URL('.generated/wrangler.json', here)),
);
// The caller's deployment identity must cover templates, catalogues, roles and renderer.
const release = Deno.args[0];
if (!release) throw new Error('freshness-prepare.ts <release-identity>');
const config = {
	...base,
	name: 'golaberto-fresh-ssr-spike',
	main: '../durable-worker.ts',
	vars: { RELEASE: release },
	durable_objects: {
		bindings: [{ name: 'RENDERER', class_name: 'RenderingAuthority' }],
	},
	migrations: [{ tag: 'v1', new_sqlite_classes: ['RenderingAuthority'] }],
};
await Deno.writeTextFile(
	new URL('.generated/durable-wrangler.json', here),
	JSON.stringify(config, null, 2),
);
await Deno.writeTextFile(
	new URL('.generated/freshness-wrangler.json', here),
	JSON.stringify(
		{
			...config,
			main: '../freshness-probe.ts',
			vars: { ...config.vars, TEST_TOKEN: crypto.randomUUID() },
		},
		null,
		2,
	),
);
