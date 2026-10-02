// Message catalogue compilation: parses ICU MessageFormat strings into JSON
// ASTs at build time using @formatjs/icu-messageformat-parser, keeping plain
// strings intact so the zero-dependency evaluator in SES receives pure ASTs.

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

function hasIcuComplex(nodes: MessageNode[]): boolean {
  for (const node of nodes) {
    if (
      node.type === TYPE.select ||
      node.type === TYPE.plural ||
      node.type === TYPE.pound
    ) {
      return true;
    }
  }
  return false;
}

export function parseMessage(raw: string): string | MessageAst {
  if (typeof raw !== "string") {
    throw new Error(`message must be a string, got ${typeof raw}`);
  }
  if (!raw.includes("{")) return raw;
  const ast = parse(raw) as unknown as MessageNode[];
  validateNodes(ast);
  if (!hasIcuComplex(ast)) return raw;
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

export function messagesSelfTest(): string[] {
  const failures: string[] = [];

  const plain = parseMessage("Hello world!");
  if (plain !== "Hello world!") {
    failures.push(`plain string failed: got ${JSON.stringify(plain)}`);
  }

  const argStr = parseMessage("Hello {name}!");
  if (argStr !== "Hello {name}!") {
    failures.push(`plain template failed: got ${JSON.stringify(argStr)}`);
  }

  const pluralAst = parseMessage("{count, plural, one {# item} other {# items}}") as MessageNode[];
  if (!Array.isArray(pluralAst) || pluralAst.length !== 1 || pluralAst[0].type !== 6) {
    failures.push(`plural AST failed: got ${JSON.stringify(pluralAst)}`);
  } else {
    const p = pluralAst[0] as PluralNode;
    if (p.value !== "count" || !p.options.one || !p.options.other) {
      failures.push(`plural options failed: got ${JSON.stringify(p)}`);
    }
  }

  const selectAst = parseMessage("{gender, select, female {ela} male {ele} other {elu}}") as MessageNode[];
  if (!Array.isArray(selectAst) || selectAst.length !== 1 || selectAst[0].type !== 5) {
    failures.push(`select AST failed: got ${JSON.stringify(selectAst)}`);
  }

  try {
    parseMessage("Hello {unclosed");
    failures.push("expected unclosed brace to throw");
  } catch {
    // Expected
  }

  try {
    parseMessage("Today is {d, date}");
    failures.push("expected date element to throw");
  } catch {
    // Expected
  }

  return failures;
}
