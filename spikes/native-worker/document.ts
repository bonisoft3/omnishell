import { parseHTML } from 'linkedom';
import './roles.ts';
import { renderDocument } from '../../interpreter/document.js';
import { compileCatalog } from '../../interpreter/vendor/messages.js';
import { templateHash } from '../../interpreter/screen.js';
import { controlProperties } from '../../server/linkedom-controls.ts';
import fixture from './.generated/fixture.json';

const { origin, pathname, entry, cfg, found, tag, catalogue, assets } = fixture;
export { fixture };
globalThis.location = new URL(origin + '/');
globalThis.CSS = { escape: (value) => value };
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
globalThis.fetch = async (input) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	if (url.origin !== origin || !Object.hasOwn(assets, url.pathname)) {
		throw new Error(`uncaptured asset: ${url}`);
	}
	return new Response(assets[url.pathname]);
};
const messages = { [tag]: compileCatalog(JSON.parse(catalogue)) };
const words = { [tag]: templateHash(catalogue) };
const entryDocument = parseHTML(entry).document;
controlProperties(entryDocument);
export async function renderQueries(queries) {
	const store = {
		async query(...args) {
			const key = JSON.stringify(args);
			if (!Object.hasOwn(queries, key)) {
				throw new Error(`uncaptured query: ${key}`);
			}
			return structuredClone(queries[key]);
		},
		// Captured query results already contain the tab's derived rows.
		subscribe() {
			return () => {};
		},
		async upsert() {},
		async upsertBy() {},
		async dropWhere() {},
	};
	const result = await renderDocument({
		entry,
		parse: () => entryDocument.cloneNode(true),
		cfg,
		appBase: new URL(origin + '/'),
		...found,
		store,
		messages,
		words,
		rows: true,
		origin,
		here: pathname,
	});
	result.handle.stop();
	return { html: result.html, status: result.gone ? 404 : 200 };
}
