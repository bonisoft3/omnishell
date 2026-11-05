/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import { roles, elementRoles } from "npm:aria-query@5.3.2";

export type AriaObligation = {
  id: string; path: string; property: string;
  status: "satisfied" | "violation" | "unchecked";
  reason: string; evidence: string[]; assumptions: string[];
  oracleClass: "policy" | "completeness";
  coverageRoute: "default";
  authority: string;
};
export type AriaOptions = { path: string; phase: "declaration" | "execution"; completeDocument?: boolean; opaque?: boolean; nativeProperties?: "browser" | "adapter" | "serialized" };
const authority = "https://www.w3.org/TR/wai-aria-1.2/";
type RoleDefinition = { abstract: boolean; requiredContextRole: string[]; requiredOwnedElements: string[][] };
const roleDefinition = (name: string) => roles.get(name) as RoleDefinition | undefined;
const nativeConcepts = [...elementRoles.entries()] as [{ name: string; attributes?: { name: string; value?: string; constraints?: string[] }[]; constraints?: string[] }, Set<string>][];
const conceptsByTag = new Map<string, typeof nativeConcepts>();
for (const concept of nativeConcepts) conceptsByTag.set(concept[0].name, [...(conceptsByTag.get(concept[0].name) ?? []), concept]);
const role = (el: Element): string => {
  for (const name of (el.getAttribute("role") ?? "").trim().split(/\s+/)) {
    const definition = roleDefinition(name);
    if (definition && !definition.abstract) return name;
  }
  const matches = (conceptsByTag.get(el.localName) ?? []).filter(([concept]) => !concept.constraints?.length &&
    (concept.attributes ?? []).every((attr) => !attr.constraints?.length && !dynamic(el.getAttribute(attr.name)) &&
      (attr.value === undefined ? el.hasAttribute(attr.name) : el.getAttribute(attr.name) === attr.value)));
  const names = new Set(matches.flatMap(([, names]) => [...names]));
  return names.size === 1 ? [...names][0] : "";
};
const dynamic = (value: string | null) => value !== null && /\{[^}]+\}/.test(value);
const label = (el: Element) => el.id || el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 80) || el.localName;
const current = (value: string | null) => value !== null && value !== "" && value !== "false";
const exposure = (el: Element): boolean | undefined => {
  let uncertain = false;
  for (let node: Element | null = el; node; node = node.parentElement) {
    const hidden = node.getAttribute("hidden");
    const aria = node.getAttribute("aria-hidden");
    if (node.hasAttribute("hidden") && !dynamic(hidden) || aria === "true") return false;
    if (dynamic(hidden) || dynamic(aria)) uncertain = true;
  }
  return uncertain ? undefined : true;
};
const composites = new Set(["tablist", "listbox", "tree", "radiogroup"]);
const compositeOwner = (el: Element): Element | null => {
  for (let parent = el.parentElement; parent; parent = parent.parentElement) {
    if (composites.has(role(parent))) return parent;
  }
  return null;
};
const set = (el: Element) => ["ul", "ol"].includes(el.localName) || ["list", "group"].includes(role(el));

/** Only live DOM descendants participate; inert template contents are declarations, not members. */
export function checkAria(root: ParentNode, opts: AriaOptions): AriaObligation[] {
  const all = [...root.querySelectorAll("*")].filter((el) => !el.closest("template"));
  if ((root as Element).nodeType === 1) all.unshift(root as Element);
  const obligations: AriaObligation[] = [];
  const byId = new Map<string, Element[]>();
  const ownersById = new Map<string, Element[]>();
  let dynamicOwnership = false;
  for (const el of all) {
    if (el.id) byId.set(el.id, [...(byId.get(el.id) ?? []), el]);
    const owned = el.getAttribute("aria-owns");
    if (dynamic(owned)) dynamicOwnership = true;
    else for (const id of owned?.trim().split(/\s+/).filter(Boolean) ?? []) ownersById.set(id, [...(ownersById.get(id) ?? []), el]);
  }
  const add = (el: Element, property: string, status: AriaObligation["status"], reason: string, evidence: string[], assumptions: string[] = [], source = authority) => {
    obligations.push({ id: `${opts.path}#aria:${all.indexOf(el)}:${property}`, path: opts.path, property, status, reason,
      evidence, assumptions: [...assumptions, `${opts.phase} snapshot; CSS layout and inaccessible renderer internals are not evaluated.`], oracleClass: property.startsWith("aria-reference") || property.startsWith("aria-required") ? "completeness" : "policy", coverageRoute: "default", authority: source });
  };
  const groups = new Map<Element, Element[]>();
  for (const el of all.filter((el) => el.hasAttribute("aria-current") && exposure(el) !== false)) {
    let owner = el.parentElement;
    while (owner && !set(owner)) {
      // Direct navigation links form a set; nested unclassified containers do not identify one.
      if ((owner.localName === "nav" || role(owner) === "navigation") && el.parentElement === owner) break;
      owner = owner.parentElement;
    }
    if (!owner || !all.includes(owner)) {
      add(el, "aria-current-cardinality", "unchecked", "The related set is not identified by a list, group or direct navigation membership.", [label(el)]);
    } else groups.set(owner, [...(groups.get(owner) ?? []), el]);
  }
  for (const [owner, members] of groups) {
    const unknown = owner.hasAttribute("aria-owns") || dynamicOwnership || members.some((el) => dynamic(el.getAttribute("aria-current")) || exposure(el) === undefined || ownersById.has(el.id)) || opts.opaque;
    const active = members.filter((el) => !dynamicOwnership && !ownersById.has(el.id) && exposure(el) === true && !dynamic(el.getAttribute("aria-current")) && current(el.getAttribute("aria-current")));
    const status = active.length > 1 ? "violation" : unknown ? "unchecked" : "satisfied";
    add(owner, "aria-current-cardinality", status, active.length > 1 ? "More than one member of this related set is current." : unknown ? "Dynamic current values or opaque output prevent a complete cardinality check." : "At most one declared member of this related set is current.", active.map(label),
      ["The nearest declared list/group, or direct navigation links, identifies the related set.", "ARIA's SHOULD recommendation is enforced as an Omnishell policy; this does not establish destination agreement."]);
  }
  for (const owner of all.filter((el) => composites.has(role(el)) && exposure(el) !== false)) {
    const roles = role(owner) === "tablist" ? ["tab"] : role(owner) === "listbox" ? ["option"] : role(owner) === "tree" ? ["treeitem"] : ["radio"];
    const attr = role(owner) === "radiogroup" ? "aria-checked" : "aria-selected";
    const members = all.filter((el) => roles.includes(role(el)) && exposure(el) !== false && compositeOwner(el) === owner);
    const multi = owner.getAttribute("aria-multiselectable");
    if (multi === "true" && attr === "aria-selected") continue;
    const active = members.filter((el) => !dynamicOwnership && !ownersById.has(el.id) && exposure(el) === true && el.getAttribute(attr) === "true");
    const unknown = dynamic(multi) || dynamicOwnership || owner.hasAttribute("aria-owns") || members.some((el) => dynamic(el.getAttribute(attr)) || exposure(el) === undefined || ownersById.has(el.id)) || opts.opaque;
    add(owner, "aria-selection-cardinality", dynamic(multi) ? "unchecked" : active.length > 1 ? "violation" : unknown ? "unchecked" : "satisfied",
      dynamic(multi) ? "Selection multiplicity is dynamically bound." : active.length > 1 ? "A single-selection composite has multiple selected members." : unknown ? "Dynamic selection, external ownership or opaque output prevents complete inventory." : "At most one member of this single-selection composite is selected.", active.map(label),
      ["Only DOM-contained members are counted; aria-owns relationships remain unchecked.", "No selection is allowed; required selection is not inferred."]);
  }
  const radios = new Map<string, Element[]>();
  for (const el of all.filter((el) => el.localName === "input" && el.getAttribute("type")?.toLowerCase() === "radio")) {
    const name = el.getAttribute("name");
    if (!name) continue;
    const explicitForm = el.getAttribute("form");
    const forms = explicitForm === null ? [] : (byId.get(explicitForm) ?? []).filter((candidate) => candidate.localName === "form");
    if (dynamic(name) || dynamic(explicitForm) || explicitForm !== null && forms.length !== 1) {
      add(el, "native-radio-cardinality", "unchecked", "The radio name or form owner is unresolved.", [name]);
      continue;
    }
    const form = explicitForm === null ? el.closest("form") : forms[0];
    const key = `${form ? all.indexOf(form) : "$document"}:${name}`;
    radios.set(key, [...(radios.get(key) ?? []), el]);
  }
  const nativeCardinality = (el: Element, members: Element[], property: "checked" | "selected", kind: string, complete = true) => {
    const values = members.map((member) => (member as unknown as Record<string, unknown>)[property]);
    const uncertain = !complete || opts.phase !== "execution" || opts.nativeProperties !== "browser" || members.some((member) => dynamic(member.getAttribute(property))) || values.some((value) => typeof value !== "boolean");
    const active = members.filter((_, index) => values[index] === true);
    add(el, kind, uncertain ? "unchecked" : active.length > 1 ? "violation" : "satisfied",
      uncertain ? "Native selectedness requires recorded browser properties and a complete grouping scope; serialized markup and in-process adapter properties do not establish browser normalization." : active.length > 1 ? "Live native control properties violate single-selection semantics." : "Live native control properties have at most one selected member.", active.map(label),
      ["Only normalized browser properties establish native single-selection semantics; defaults and adapter values remain unchecked."],
      "https://html.spec.whatwg.org/multipage/form-elements.html");
  };
  for (const members of radios.values()) nativeCardinality(members[0], members, "checked", "native-radio-cardinality", opts.completeDocument === true);
  for (const el of all.filter((el) => el.localName === "select")) {
    if (dynamic(el.getAttribute("multiple"))) {
      add(el, "native-select-cardinality", "unchecked", "Selection multiplicity is dynamically bound.", [label(el)]);
    } else if (!el.hasAttribute("multiple")) {
      nativeCardinality(el, all.filter((candidate) => candidate.localName === "option" && candidate.closest("select") === el), "selected", "native-select-cardinality");
    }
  }
  const busy = (el: Element) => {
    for (let parent: Element | null = el; parent; parent = parent.parentElement) {
      const value = parent.getAttribute("aria-busy");
      if (value === "true" || dynamic(value)) return true;
    }
    return false;
  };
  const declaredOwner = (el: Element): Element | undefined => {
    if (!el.id || dynamic(el.id)) return undefined;
    const owners = ownersById.get(el.id) ?? [];
    return owners.length === 1 ? owners[0] : undefined;
  };
  const ancestryCache = new Map<Element, Element[]>();
  const ancestry = (el: Element) => {
    const cached = ancestryCache.get(el);
    if (cached) return cached;
    const result: Element[] = [];
    const seen = new Set<Element>([el]);
    for (let parent = declaredOwner(el) ?? el.parentElement; parent && !seen.has(parent); parent = declaredOwner(parent) ?? parent.parentElement) {
      result.push(parent);
      seen.add(parent);
    }
    ancestryCache.set(el, result);
    return result;
  };
  for (const el of all.filter((el) => el.hasAttribute("role") && exposure(el) !== false)) {
    const name = role(el);
    const definition = roleDefinition(name);
    if (!definition || dynamic(el.getAttribute("role"))) {
      add(el, "aria-role-coverage", "unchecked", "The declared role has no resolved supported semantics.", [el.getAttribute("role") ?? ""]);
      continue;
    }
    if (!definition.requiredContextRole.length && !definition.requiredOwnedElements.length) continue;
    const uncertainOwnership = opts.opaque || dynamic(el.id) || exposure(el) === undefined ||
      dynamicOwnership ||
      !!el.id && (ownersById.get(el.id)?.length ?? 0) > 1;
    const contexts = definition.requiredContextRole;
    if (contexts.length) {
      const parents = ancestry(el);
      const matched = parents.find((parent) => contexts.includes(role(parent)));
      const uncertain = uncertainOwnership || busy(el) || parents.some((parent) => dynamic(parent.getAttribute("role")));
      add(el, "aria-required-context", uncertain ? "unchecked" : matched ? "satisfied" : opts.completeDocument ? "violation" : "unchecked",
        uncertain ? "Dynamic ownership, exposure or loading prevents context resolution." : matched ? "The required context role is present in the ownership ancestry." : "No required context role is present in this inventory; fragment ancestors remain unresolved.", [name, ...contexts]);
    }
    const paths = definition.requiredOwnedElements;
    if (paths.length) {
      const candidates = all.filter((candidate) => candidate !== el && exposure(candidate) === true && ancestry(candidate).includes(el));
      const matched = paths.some((path) => candidates.some((candidate) => {
        if (role(candidate) !== path[0]) return false;
        const parents = ancestry(candidate);
        const within = parents.slice(0, parents.indexOf(el));
        if (within.some((parent) => role(parent) === name)) return false;
        let cursor = 0;
        for (const expected of path.slice(1)) {
          const offset = within.slice(cursor).findIndex((parent) => role(parent) === expected);
          if (offset === -1) return false;
          cursor += offset + 1;
        }
        return true;
      }));
      const uncertain = uncertainOwnership || busy(el) || el.hasAttribute("aria-owns") && !matched ||
        [...el.querySelectorAll("*")].some((child) => child.localName === "template" || dynamic(child.getAttribute("role")) || exposure(child) === undefined);
      add(el, "aria-required-owned", uncertain ? "unchecked" : matched ? "satisfied" : "violation",
        uncertain ? "Loading, dynamic children or unresolved ownership prevents a complete child-role check." : matched ? "At least one required owned-role path is present." : "The composite has no required owned-role path and is not marked busy.", [name, ...paths.map((path) => path.join(" <- "))]);
    }
  }
  for (const el of all) {
    for (const attr of ["aria-labelledby", "aria-describedby", "aria-controls", "aria-owns", "aria-activedescendant", "aria-details", "aria-errormessage"]) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      if (dynamic(value)) {
        add(el, `aria-reference:${attr}`, "unchecked", "The ID reference is dynamically bound.", [attr, value]);
        continue;
      }
      for (const id of value.trim().split(/\s+/)) {
        const matches = byId.get(id) ?? [];
        const status = matches.length === 1 ? "satisfied" : matches.length > 1 ? "violation" : opts.completeDocument && !opts.opaque ? "violation" : "unchecked";
        add(el, `aria-reference:${attr}:${id}`, status, matches.length === 1 ? "The ID reference resolves uniquely in this inventory." : matches.length > 1 ? "The ID reference is ambiguous." : "The referenced element is absent; a fragment or opaque renderer may supply it unless the document is complete.", [attr, id]);
      }
    }
  }
  return obligations;
}
