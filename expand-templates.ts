/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

export function expandTemplates(document: Document): { reference: string; reason: string; element: Element }[] {
  const named = new Map<string, Element[]>();
  const collect = (root: ParentNode) => {
    for (const child of [...root.children]) {
      if (child.hasAttribute("data-text-format")) continue;
      if (child.localName === "template") {
        if (!child.hasAttribute("data-item")) continue;
        const name = child.getAttribute("data-name");
        if (name !== null) named.set(name, [...(named.get(name) ?? []), child.cloneNode(true) as Element]);
      }
      collect(child);
    }
  };
  collect(document);
  const gaps: { reference: string; reason: string; element: Element }[] = [];
  const ownItems = (region: Element): Element[] => {
    const find = (root: ParentNode): Element[] => [...root.children].flatMap((child) => {
      if (child.hasAttribute("data-live") || child.hasAttribute("data-text-format")) return [];
      if (child.localName === "template") return child.hasAttribute("data-item") ? [child] : [];
      return find(child);
    });
    return find(region);
  };
  const visit = (root: ParentNode, stack: string[]) => {
    for (const child of [...root.children]) {
      if (child.hasAttribute("data-text-format")) continue;
      if (child.localName === "template") {
        const owner = child.parentElement?.closest("[data-live]");
        if (child.hasAttribute("data-item") && owner && !owner.hasAttribute("data-template")) {
          const item = child.firstElementChild!;
          child.replaceWith(item);
          visitItem(item, stack);
        } else child.remove();
        continue;
      }
      visitItem(child, stack);
    }
  };
  const visitItem = (child: Element, stack: string[]) => {
    if (child.hasAttribute("data-text-format")) return;
    if (child.hasAttribute("data-live")) {
      const items = ownItems(child);
      const reference = child.getAttribute("data-template");
      const reason = reference !== null && items.length ? "reference with inline items" : items.some((item) => item.children.length !== 1) ? "invalid inline item" : "";
      if (reason) {
        gaps.push({ reference: reference ?? "(inline)", reason, element: child });
        child.replaceChildren();
        return;
      }
    }
    if (child.hasAttribute("data-live") && child.hasAttribute("data-template")) {
      const reference = child.getAttribute("data-template")!;
      const matches = named.get(reference) ?? [];
      const reason = matches.length === 0 ? "unknown" : matches.length > 1 ? "ambiguous" : stack.includes(reference) ? "recursive" :
        matches[0].children.length !== 1 ? "invalid item" : "";
      child.replaceChildren();
      if (reason) gaps.push({ reference, reason, element: child });
      else {
        const item = matches[0].firstElementChild!.cloneNode(true) as Element;
        child.appendChild(item);
        visitItem(item, [...stack, reference]);
      }
    } else visit(child, stack);
  };
  visit(document, []);
  return gaps;
}
