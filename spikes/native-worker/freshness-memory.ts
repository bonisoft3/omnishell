import { inspect } from './inspector.ts';

const [endpoint, inspector, output] = Deno.args;
if (!output) {
	throw new Error('freshness-memory.ts <endpoint> <inspector> <output>');
}
const fixture = JSON.parse(
	await Deno.readTextFile(new URL('.generated/fixture.json', import.meta.url)),
);
const config = JSON.parse(
	await Deno.readTextFile(
		new URL('.generated/freshness-wrangler.json', import.meta.url),
	),
);
const { send, close } = await inspect(inspector);
const control = async (name, body?) => {
	const response = await fetch(endpoint + '/_spike/' + name, {
		method: body === undefined ? 'GET' : 'POST',
		headers: {
			authorization: `Bearer ${config.vars.TEST_TOKEN}`,
			'content-type': 'application/json',
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (!response.ok) throw new Error(await response.text());
	return response.json();
};
const samples = [];
try {
	const initial = await send('Runtime.getHeapUsage');
	let { revision } = await control('state');
	for (let batch = 0; batch < 10; batch++) {
		for (let index = 0; index < 20; index++) {
			({ revision } = await control('commit', {
				expected: revision,
				changes: fixture.queries,
			}));
			const response = await fetch(endpoint + fixture.pathname);
			const html = await response.text();
			if (
				!response.ok || !html.includes('Flamengo') ||
				response.headers.get('x-data-revision') !== String(revision)
			) {
				throw new Error(`incorrect render: ${response.status}`);
			}
		}
		samples.push({
			renders: (batch + 1) * 20,
			heap: await send('Runtime.getHeapUsage'),
		});
	}
	const report = {
		initial,
		samples,
		note:
			'Local workerd CDP JS heap sampled every 20 dirty renders with normal garbage collection. This neither measures total isolate memory nor establishes production 128 MiB enforcement.',
	};
	await Deno.writeTextFile(output, JSON.stringify(report, null, 2) + '\n');
	console.log(JSON.stringify(report));
} finally {
	close();
}
