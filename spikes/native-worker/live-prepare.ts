import { relative } from 'node:path';

const pglite = Deno.args[0];
if (!pglite) throw new Error('live-prepare.ts <pglite-workerd-package>');
const here = new URL('.', import.meta.url);
const generated = new URL('.generated/', here);
const rel = (file: string) => relative(generated.pathname, file);
const modules = {
	pgliteWasm: 'pglite.wasm',
	initdbWasm: 'initdb.wasm',
	pgliteData: 'pglite.data',
	icu: 'icu-root.tgz',
};
for (const name of Object.values(modules)) await Deno.stat(`${pglite}/${name}`);
await Deno.mkdir(generated, { recursive: true });
await Deno.writeTextFile(
	new URL('live-pglite.ts', generated),
	Object.entries(modules)
		.map(([key, file]) =>
			`import ${key} from ${JSON.stringify(rel(pglite + '/' + file))};`
		).join('\n') +
		'\nexport default { pgliteWasm, initdbWasm, pgliteData, icu };\n',
);
const renderer = 'golaberto-live-render-spike';
await Deno.writeTextFile(
	new URL('live-render-wrangler.json', generated),
	JSON.stringify(
		{
			name: renderer,
			main: '../live-render-worker.ts',
			compatibility_date: '2026-09-01',
			compatibility_flags: ['nodejs_compat'],
			workers_dev: false,
			keep_names: false,
			alias: { './jessie.js': new URL('roles.ts', here).pathname },
			vars: { RELEASE: 'live-spike-v1' },
			durable_objects: {
				bindings: [{ name: 'LOCAL_RENDERER', class_name: 'DocumentRenderer' }],
			},
			migrations: [{ tag: 'v1', new_sqlite_classes: ['DocumentRenderer'] }],
		},
		null,
		2,
	),
);
await Deno.writeTextFile(
	new URL('live-database-wrangler.json', generated),
	JSON.stringify(
		{
			name: 'golaberto-live-database-spike',
			main: '../live-database-worker.ts',
			compatibility_date: '2026-09-01',
			workers_dev: false,
			keep_names: false,
			vars: {
				JWT_SECRET: 'local-live-spike',
				IMPORT_TOKEN: 'local-live-import',
			},
			version_metadata: { binding: 'CF_VERSION_METADATA' },
			durable_objects: {
				bindings: [
					{ name: 'CLUSTER', class_name: 'Database' },
					{
						name: 'RENDERER',
						class_name: 'DocumentRenderer',
						script_name: renderer,
					},
				],
			},
			migrations: [{ tag: 'v1', new_sqlite_classes: ['Database'] }],
			rules: [{
				type: 'CompiledWasm',
				globs: ['**/*.wasm'],
				fallthrough: false,
			}, {
				type: 'Data',
				globs: ['**/*.data', '**/*.tgz'],
				fallthrough: false,
			}],
			alias: {
				'@electric-sql/pglite': rel(pglite + '/index.js'),
				'@electric-sql/pglite/basefs': rel(pglite + '/fs/base.js'),
				'@mecha/postgrest-js': rel(
					new URL(
						'../../../../libraries/mecha/packages/postgrest-js/src/index.ts',
						here,
					).pathname,
				),
			},
		},
		null,
		2,
	),
);
