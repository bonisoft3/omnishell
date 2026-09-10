import { parseHTML } from "npm:linkedom@0.18.4";
import { assert, assertRejects, assertThrows } from "jsr:@std/assert";
import "https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js";
import { createReadOnlyMembrane } from "./membrane.js";

if (!globalThis.__prontoLockdown) {
  globalThis.__prontoLockdown = true;
  lockdown({ errorTaming: "unsafe" });
}

function createDOM(html) {
  const { document } = parseHTML(html);
  return document;
}

Deno.test("membrane allows safe read-only queries", () => {
  const doc = createDOM(`
    <div id="container" class="box main" data-user-id="42" data-role="admin">
      <input id="username" type="text" value="alice" data-action="submit-form" />
    </div>
  `);

  const input = doc.querySelector("#username");
  const membrane = createReadOnlyMembrane(input);

  assert(membrane.id === "username");
  assert(membrane.tagName === "INPUT");
  assert(membrane.type === "text");
  assert(membrane.value === "alice");
  assert(membrane.dataset.action === "submit-form");
  assert(membrane.getAttribute("data-action") === "submit-form");
  assert(membrane.hasAttribute("data-action") === true);
  assert(membrane.matches('[data-action="submit-form"]') === true);
  assert(membrane.matches("#other") === false);
});

Deno.test("membrane parentElement and closest return wrapped membranes", () => {
  const doc = createDOM(`
    <div id="container" class="box main" data-scope="outer">
      <section class="wrapper">
        <button id="btn" data-action="trigger">Click</button>
      </section>
    </div>
  `);

  const btn = doc.querySelector("#btn");
  const btnMembrane = createReadOnlyMembrane(btn);

  const parentMembrane = btnMembrane.parentElement;
  assert(parentMembrane !== null);
  assert(parentMembrane.tagName === "SECTION");
  assert(parentMembrane.className === "wrapper");

  const closestContainer = btnMembrane.closest("#container");
  assert(closestContainer !== null);
  assert(closestContainer.id === "container");
  assert(closestContainer.dataset.scope === "outer");

  assertThrows(
    () => {
      closestContainer.id = "hacked";
    },
    Error,
    "[Membrane Violation]"
  );
});

Deno.test("membrane strictly rejects all mutation operations", () => {
  const doc = createDOM(`<button id="btn" data-action="trigger">Click</button>`);
  const btn = doc.querySelector("#btn");
  const membrane = createReadOnlyMembrane(btn);

  assertThrows(
    () => {
      membrane.id = "new-id";
    },
    Error,
    "[Membrane Violation]"
  );

  assertThrows(
    () => {
      delete membrane.id;
    },
    Error,
    "[Membrane Violation]"
  );

  assertThrows(
    () => {
      membrane.setAttribute("data-hacked", "true");
    },
    Error,
    "[Membrane Violation]"
  );

  assertThrows(
    () => {
      membrane.remove();
    },
    Error,
    "[Membrane Violation]"
  );
});

Deno.test("membrane functions safely inside an SES compartment", () => {
  const doc = createDOM(`
    <div id="app" data-view="dashboard">
      <button id="submit-btn" data-action="submit-form" data-user-id="99">Submit</button>
    </div>
  `);

  const btn = doc.querySelector("#submit-btn");
  const membrane = createReadOnlyMembrane(btn);

  const compartment = new Compartment({
    console: Object.freeze({ log: () => {} }),
  });

  const routerFn = compartment.evaluate(`
    (function routeEvent(membraneElement) {
      if (membraneElement.matches('[data-action="submit-form"]')) {
        return {
          type: "SUBMIT",
          userId: membraneElement.dataset.userId,
          scope: membraneElement.closest("#app").dataset.view
        };
      }
      return null;
    })
  `);

  const result = routerFn(membrane);
  assert(result.type === "SUBMIT");
  assert(result.userId === "99");
  assert(result.scope === "dashboard");

  const mutatorFn = compartment.evaluate(`
    (function tryMutate(membraneElement) {
      membraneElement.id = "hacked-inside-ses";
    })
  `);

  assertThrows(
    () => {
      mutatorFn(membrane);
    },
    Error,
    "[Membrane Violation]"
  );
});
