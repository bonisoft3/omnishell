import { parse } from "npm:acorn@8.14.0";
const [publicDir] = Deno.args;
if (!publicDir) throw new Error("app-prepare.ts <release-public-directory>");
const here = new URL(".", import.meta.url);
await Deno.stat(new URL(".generated/jessie-sync.js", here));
const assets = {};
async function walk(dir, prefix = "") {
	for await (const entry of Deno.readDir(dir)) {
		const name = prefix + "/" + entry.name;
		if (entry.isDirectory) await walk(dir + "/" + entry.name, name);
		else if (/\.(js|json|css|html|txt)$/.test(name)) {
			assets[name] = await Deno.readTextFile(dir + "/" + entry.name);
		}
	}
}
await walk(publicDir);
const cfg = JSON.parse(assets["/shell/shell.json"]);
const declarations = new Map();
for (const route of cfg.routes) {
	for (const kind of ["handlers", "renderers", "adapters"]) {
		for (const name of route.files[kind] ?? []) {
			declarations.set(kind + ":" + name, {
				name: "/" + name,
				role: kind.slice(0, -1),
			});
		}
	}
}
for (const table of Object.values(cfg.validations ?? {})) {
	for (const spec of Object.values(table)) {
		declarations.set("validation:" + spec.src, {
			name: "/" + spec.src,
			role: "validation",
		});
	}
}
const roles = [...declarations.values()].map(({ name, role }) => {
	const source = assets[name];
	if (typeof source !== "string") throw new Error(`missing role: ${name}`);
	const endowments = cfg.endowments?.[name.slice(1)] ?? [];
	const adapted = role === "renderer"
		? source.replace(/^[ \t]*export[ \t]+default[ \t]+/m, "")
		: source;
	const ast = parse(adapted, { ecmaVersion: "latest" });
	const last = ast.body.at(-1);
	if (last?.type !== "ExpressionStatement") {
		throw new Error(`role has no completion expression: ${name}`);
	}
	const factory = "(() => {\n" + adapted.slice(0, last.start) + "\nreturn (" +
		adapted.slice(last.expression.start, last.expression.end) + ");\n})";
	return { name, source, role, endowments, factory };
});
await Deno.writeTextFile(
	new URL(".generated/app-assets.json", here),
	JSON.stringify(assets),
);
await Deno.writeTextFile(
	new URL(".generated/app-roles.json", here),
	JSON.stringify(roles),
);
await Deno.writeTextFile(
	new URL(".generated/app-deno.json", here),
	JSON.stringify(
		{
			imports: {
				linkedom: "npm:linkedom@0.18.4",
				[new URL("../../interpreter/jessie.js", here).href]:
					new URL("app-roles.ts", here).href,
			},
		},
		null,
		2,
	),
);
console.log(
	JSON.stringify({ assets: Object.keys(assets).length, roles: roles.length }),
);
