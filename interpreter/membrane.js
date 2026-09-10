// A read-only Proxy over a DOM element: allowlisted queries pass through,
// every mutation vector throws, and traversal returns a membrane rather than
// the raw node. Nothing hands one to a compartment yet — it is exported and
// exercised only by membrane-smoke.js.

export function createReadOnlyMembrane(element) {
  if (element === null || element === undefined) return null;

  return new Proxy(element, {
    get(target, prop) {
      if (prop === "matches") {
        return (selector) => target.matches(selector);
      }

      if (prop === "id") return target.id;
      if (prop === "className") return target.className;
      if (prop === "tagName") return target.tagName;
      if (prop === "type") return target.type;
      if (prop === "value") return target.value;

      if (prop === "dataset") {
        // A copy, because the live DOMStringMap is a mutation handle.
        return Object.freeze({ ...target.dataset });
      }

      if (prop === "getAttribute") {
        return (attrName) => target.getAttribute(attrName);
      }

      if (prop === "hasAttribute") {
        return (attrName) => target.hasAttribute(attrName);
      }

      if (prop === "parentElement" || prop === "parentNode") {
        const parent = target.parentElement ?? target.parentNode;
        return parent && parent.nodeType === 1 ? createReadOnlyMembrane(parent) : null;
      }

      if (prop === "closest") {
        return (selector) => {
          const match = target.closest(selector);
          return match ? createReadOnlyMembrane(match) : null;
        };
      }

      // An un-allowlisted method throws, because a caller that reached for one
      // wants an effect and a silent no-op would read as success. An
      // un-allowlisted data property reads as absent instead, which is what a
      // property the element never had already does.
      if (typeof target[prop] === "function") {
        throw new Error(
          `[Membrane Violation] Execution of host method '${String(prop)}' is forbidden inside the SES compartment.`
        );
      }

      return undefined;
    },

    set(_target, prop) {
      throw new Error(
        `[Membrane Violation] Mutation of host DOM property '${String(prop)}' is strictly prohibited within the isolated compartment.`
      );
    },

    deleteProperty(_target, prop) {
      throw new Error(
        `[Membrane Violation] Deletion of host DOM property '${String(prop)}' is strictly prohibited within the isolated compartment.`
      );
    },
  });
}
