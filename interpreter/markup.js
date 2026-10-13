// The policy only parses into an inert template. Nodes leave it after the
// browser has decoded attributes and the same refusal used by markup lint.
const policies = new WeakMap();
const URL_ATTRIBUTES = new Set(["href", "xlink:href", "src", "action", "formaction", "data", "poster"]);
const ACTIVE = new Set(["script", "object", "embed", "base", "meta"]);

export function markupViolations(root) {
  const errors = [];
  const visit = (node) => {
    if (node.nodeType === 1) {
      const tag = node.localName.toLowerCase();
      if (ACTIVE.has(tag)) errors.push(`<${tag}> is executable or document-scoped markup`);
      for (const attr of node.attributes) {
        const name = attr.name.toLowerCase();
        if (name.startsWith("on")) errors.push(`${name} is an inline event handler`);
        if (name === "srcdoc") errors.push("srcdoc is an undeclared document");
        if (URL_ATTRIBUTES.has(name) && /^(?:javascript|vbscript):/i.test(attr.value.replace(/[\u0000-\u0020\u007f]/g, ""))) {
          errors.push(`${name} contains an executable URL`);
        }
      }
      if (tag === "template") visit(node.content);
    }
    for (const child of node.childNodes) visit(child);
  };
  visit(root);
  return errors;
}

export function parseMarkup(document, text) {
  const template = document.createElement("template");
  const factory = document.defaultView?.trustedTypes;
  let policy;
  if (factory) {
    policy = policies.get(factory);
    if (!policy) {
      policy = factory.createPolicy("omnishell-markup", { createHTML: (value) => value });
      policies.set(factory, policy);
    }
  }
  template.innerHTML = policy ? policy.createHTML(text) : text;
  const errors = markupViolations(template.content);
  if (errors.length) throw new Error(`markup refused: ${errors.join("; ")}`);
  return template.content;
}
