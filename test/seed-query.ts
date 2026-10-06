import { parseEmbeds, parseFilter, parseLimit } from "../interpreter/fragment.js";
import type { Cluster, Row } from "./screen-harness.ts";

type Embed = { alias: string; rel: string; hints: string[]; spread: boolean; cols: string[]; embeds: Embed[] };
type Select = { cols: string[]; embeds: Embed[] };
type Query = { filter?: string; select?: string; order?: string | null };
type Predicate = (row: Row) => boolean;

/** Parameter planning needs a filter's values even when the authored read
 * omits them. Only its candidate projection adds those fields; its joins and
 * the mounted read's projection stay as declared. */
export function selectWithFields(select: string | undefined, columns: string[]): string {
  const tree = parseEmbeds(select) as Select | null;
  if (tree === null) throw new Error(`select outside the grammar: ${select}`);
  if (select === undefined) tree.cols.push("*");
  for (const column of columns) {
    const steps = column.split(".");
    const leaf = steps.pop()!;
    let node: Select = tree;
    for (const alias of steps) {
      const embedded = node.embeds.find((e) => e.alias === alias);
      if (embedded === undefined) throw new Error(`filter relationship "${column}" is not selected`);
      node = embedded;
    }
    if (!node.cols.includes("*") && !node.cols.includes(leaf)) node.cols.push(leaf);
  }
  const serialize = (node: Select): string => [
    ...node.cols,
    ...node.embeds.map((e) => `${e.spread ? "..." : e.alias === e.rel ? "" : `${e.alias}:`}${e.rel}${e.hints.map((h) => `!${h}`).join("")}(${serialize(e)})`),
  ].join(",");
  return serialize(tree);
}

/** The seed answers the server's declared to-one joins. A query this model
 * cannot resolve fails before looking at rows, including an empty seed. */
export function seedQuery(
  tables: Record<string, Row[]>,
  cluster: Cluster,
  table: string,
  query: Query = {},
  visible: (table: string, row: Row) => boolean = () => true,
): Row[] {
  const of = (name: string) => {
    if (tables[name] === undefined) throw new Error(`no table "${name}" in this store`);
    return tables[name];
  };
  const column = (name: string, col: string) => {
    if (!/^[a-z_][a-z0-9_]*$/i.test(col)) throw new Error(`column outside the grammar for ${name}: ${col}`);
    const fields = cluster.schema?.[name]?.fields;
    const known = fields === undefined
      ? col === (cluster.keys?.[name] ?? "id") || of(name).some((r) => Object.hasOwn(r, col))
      : fields.some((f) => f.name === col);
    if (!known) throw new Error(`unknown column ${name}.${col}`);
  };
  const parsed = parseEmbeds(query.select) as Select | null;
  if (parsed === null) throw new Error(`select outside the grammar for ${table}: ${query.select}`);
  const filters = new Map<string, Predicate[]>();
  for (const clause of (query.filter ? query.filter.split("&") : [])) {
    const match = /^([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*)=(.+)$/i.exec(clause);
    if (match === null) throw new Error(`filter outside the grammar for ${table}: ${query.filter}`);
    const path = match[1].split(".");
    const leaf = path.pop()!;
    if (path.length === 0 && (leaf === "limit" || leaf === "offset")) {
      if (!/^\d+$/.test(match[2])) throw new Error(`filter outside the grammar for ${table}: ${query.filter}`);
      continue;
    }
    const preds = parseFilter(`${leaf}=${match[2]}`) as Predicate[] | null;
    if (preds === null) throw new Error(`filter outside the grammar for ${table}: ${query.filter}`);
    const key = path.join(".");
    filters.set(key, [...(filters.get(key) ?? []), ...preds]);
  }
  const used = new Set<string>();
  const compile = (name: string, tree: Select, path: string): ((row: Row) => Row | null) => {
    of(name);
    for (const col of tree.cols) if (col !== "*") column(name, col);
    for (const clause of (query.filter ? query.filter.split("&") : [])) {
      const full = clause.slice(0, clause.indexOf("="));
      const parts = full.split(".");
      const leaf = parts.pop()!;
      if (parts.join(".") === path && !(path === "" && ["limit", "offset"].includes(leaf))) column(name, leaf);
    }
    used.add(path);
    const aliases = new Set<string>();
    const joins = tree.embeds.map((e) => {
      if (e.spread || e.hints.some((h) => h !== "inner") || e.hints.length > 1) {
        throw new Error(`select outside the grammar for ${name}: ${query.select}`);
      }
      if (aliases.has(e.alias)) throw new Error(`duplicate embed alias ${name}.${e.alias}`);
      aliases.add(e.alias);
      const refs = (cluster.schema?.[name]?.fields ?? []).filter((f) => f.ref !== undefined);
      const candidates = refs.filter((f) => f.name === e.rel || f.ref === e.rel);
      if (candidates.length !== 1) throw new Error(`embed "${e.rel}" on ${name} has ${candidates.length} declared relationships`);
      const ref = candidates[0];
      const target = ref.ref!;
      column(target, cluster.keys?.[target] ?? "id");
      const project = compile(target, e, path === "" ? e.alias : `${path}.${e.alias}`);
      return { e, ref, target, project };
    });
    return (row) => {
      if (!visible(name, row) || !(filters.get(path) ?? []).every((p) => p(row))) return null;
      const out = tree.cols.includes("*") || (path === "" && query.select === undefined)
        ? { ...row }
        : Object.fromEntries(tree.cols.map((c) => [c, row[c]]));
      for (const { e, ref, target, project } of joins) {
        const key = cluster.keys?.[target] ?? "id";
        const found = row[ref.name] == null ? undefined : of(target).find((r) => r[key] != null && String(r[key]) === String(row[ref.name]));
        const joined = found === undefined ? null : project(found);
        if (joined === null && e.hints.includes("inner")) return null;
        out[e.alias] = joined;
      }
      return out;
    };
  };
  const project = compile(table, parsed, "");
  for (const path of filters.keys()) {
    if (!used.has(path)) throw new Error(`filter relationship "${path}" is not selected on ${table}`);
  }
  const order = (query.order ?? "").split(",").filter(Boolean).map((term) => {
    const match = /^([a-z_][a-z0-9_]*)(?:\.(asc|desc))?(?:\.(nullsfirst|nullslast))?$/i.exec(term);
    if (match === null) throw new Error(`order outside the grammar for ${table}: ${query.order}`);
    column(table, match[1]);
    return { col: match[1], sign: match[2] === "desc" ? -1 : 1, nulls: match[3] };
  });
  const rows = of(table).map((row) => ({ row, out: project(row) })).filter((r) => r.out !== null);
  rows.sort((a, b) => {
    for (const { col, sign, nulls } of order) {
      const x = a.row[col] as never, y = b.row[col] as never;
      if (x == null && y == null) continue;
      const missing = nulls === "nullsfirst" ? -1 : nulls === "nullslast" ? 1 : sign;
      if (x == null) return missing;
      if (y == null) return -missing;
      if (x < y) return -sign;
      if (x > y) return sign;
    }
    return 0;
  });
  const offset = Number(/(?:^|&)offset=(\d+)(?:&|$)/.exec(query.filter ?? "")?.[1] ?? 0);
  const limit = parseLimit(query.filter);
  return rows.slice(offset, limit === undefined ? undefined : offset + limit).map(({ out }) => out!);
}
