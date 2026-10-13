import { inspect } from './inspector.ts';
const [
	endpoint = 'http://127.0.0.1:20218',
	inspector = 'http://127.0.0.1:20219',
	output = '/tmp/golaberto-native-measure.json',
] = Deno.args;
const { send, close } = await inspect(inspector);
const samples = [];
const before = await send('Runtime.getHeapUsage');
await send('Profiler.enable');
await send('Profiler.setSamplingInterval', { interval: 100 });
await send('Profiler.start');
for (let index = 0; index < 20; index++) {
	const start = performance.now();
	const response = await fetch(endpoint);
	const html = await response.text();
	if (
		!response.ok || !html.includes('Flamengo') || !html.includes('data-served')
	) throw new Error(`render failed: ${response.status}: ${html.slice(0, 200)}`);
	samples.push({
		wallMs: performance.now() - start,
		timing: response.headers.get('server-timing'),
		bytes: new TextEncoder().encode(html).length,
	});
}
const { profile } = await send('Profiler.stop');
const after = await send('Runtime.getHeapUsage');
const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
const byFunction = {};
let sampledActiveUs = 0;
for (let index = 0; index < profile.samples.length; index++) {
	const frame = nodes.get(profile.samples[index]).callFrame;
	const micros = profile.timeDeltas[index];
	if (frame.functionName === '(idle)') continue;
	sampledActiveUs += micros;
	const name = frame.functionName || '(anonymous)';
	byFunction[name] = (byFunction[name] ?? 0) + micros;
}
const sorted = samples.map((s) => s.wallMs).sort((a, b) => a - b);
const result = {
	endpoint,
	samples,
	medianWallMs: sorted[10],
	p95WallMs: sorted[18],
	heapBefore: before,
	heapAfter: after,
	sampledActiveMsPerRender: sampledActiveUs / 1000 / samples.length,
	note:
		'Local workerd; CDP sampling is an estimate, not Cloudflare billed CPU. JS heap is not total isolate memory. Data is a captured public snapshot; database and live sync excluded.',
	topSampledFunctions: Object.entries(byFunction).sort((a, b) => b[1] - a[1])
		.slice(0, 15),
};
await Deno.writeTextFile(output, JSON.stringify(result, null, 2));
await Deno.writeTextFile(output + '.cpuprofile', JSON.stringify(profile));
console.log(JSON.stringify(result));
close();
