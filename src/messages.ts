// Message catalogue compilation: parses every ICU MessageFormat string at build
// time with @formatjs/icu-messageformat-parser, so the zero-dependency evaluator
// in SES receives an AST for anything that binds and the unescaped text for
// anything that does not — one apostrophe rule for both.

import { parse, TYPE } from "npm:@formatjs/icu-messageformat-parser@3.5.20";

export type LiteralNode = { type: 0; value: string };
export type ArgumentNode = { type: 1; value: string };
export type SelectNode = {
  type: 5;
  value: string;
  options: Record<string, { value: MessageNode[] }>;
};
export type PluralNode = {
  type: 6;
  value: string;
  offset: number;
  options: Record<string, { value: MessageNode[] }>;
  pluralType: string;
};
export type PoundNode = { type: 7 };

export type MessageNode =
  | LiteralNode
  | ArgumentNode
  | SelectNode
  | PluralNode
  | PoundNode;

export type MessageAst = MessageNode[];

const SUPPORTED_TYPES = new Set([
  TYPE.literal, // 0
  TYPE.argument, // 1
  TYPE.select, // 5
  TYPE.plural, // 6
  TYPE.pound, // 7
]);

function validateNodes(nodes: MessageNode[]): void {
  for (const node of nodes) {
    if (!SUPPORTED_TYPES.has(node.type as number)) {
      throw new Error(`unsupported ICU node type: ${node.type}`);
    }
    if (node.type === TYPE.select || node.type === TYPE.plural) {
      for (const [name, option] of Object.entries(node.options ?? {})) {
        if (!option || !Array.isArray(option.value)) {
          throw new Error(`option "${name}" has no value array`);
        }
        validateNodes(option.value as MessageNode[]);
      }
    }
  }
}

// A string the interpreter receives is substituted verbatim, so any node that
// binds — an argument as much as a plural — must reach it as an AST.
function isLiteral(nodes: MessageNode[]): boolean {
  return nodes.every((node) => node.type === TYPE.literal);
}

// An odd run of apostrophes before a brace is ICU quoting: "d'{name}" would
// print the braces instead of binding them, and on a settled screen braces are
// a bug. An even run is escaped apostrophes: "d''{name}" renders "d'Name".
const QUOTED_BRACE = /(?<!')'(?:'')*[{}]/;

export function parseMessage(raw: string): string | MessageAst {
  if (typeof raw !== "string") {
    throw new Error(`message must be a string, got ${typeof raw}`);
  }
  if (QUOTED_BRACE.test(raw)) {
    throw new Error(`apostrophe before a brace quotes it in ICU: write ’ (U+2019) in ${JSON.stringify(raw)}`);
  }
  // Catalogue text is not markup: "Press <kbd>Enter</kbd>" or "a<b" stays literal.
  const ast = parse(raw, { ignoreTag: true }) as unknown as MessageNode[];
  validateNodes(ast);
  if (isLiteral(ast)) return ast.map((node) => (node as LiteralNode).value).join("");
  return ast;
}

export function compileCatalog(
  catalog: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(catalog)) {
    if (typeof val === "string") {
      try {
        out[key] = parseMessage(val);
      } catch (err) {
        throw new Error(`key "${key}": ${(err as Error).message}`);
      }
    } else {
      out[key] = val;
    }
  }
  return out;
}
