// linkedom's missing form-control properties, installed on its prototypes.
// Nothing runs at import, so a checker can take these without the harness's
// lockdown.

/** A number or range input's parsed value, which linkedom models nowhere:
 * without it the allowlist advertises a field this tier can never deliver, and
 * a machine reading it works in every browser and refuses under test. */
function valueAsNumber(document: unknown): void {
  type Input = { type?: string; value?: string; getAttribute(name: string): string | null };
  const proto = Object.getPrototypeOf(
    (document as { createElement(tag: string): object }).createElement("input"),
  ) as object;
  if (Object.getOwnPropertyDescriptor(proto, "valueAsNumber") !== undefined) return;
  Object.defineProperty(proto, "valueAsNumber", {
    configurable: true,
    get(this: Input) {
      if (this.type !== "number" && this.type !== "range") return Number.NaN;
      // An empty number field is NaN, not zero: the interpreter drops the field
      // when it is NaN, and a test asserting a cleared field writes 0 would
      // pass while the browser wrote nothing at all.
      const raw = (this.value ?? "").trim();
      if (raw === "") return Number.NaN;
      const n = Number(raw);
      // A range CLAMPS to its own bounds, and a screen may rest a safety
      // argument on that. Returning the raw number would let a test claim a
      // clamp the browser performs and this tier does not.
      if (this.type !== "range" || Number.isNaN(n)) return n;
      const lo = Number(this.getAttribute("min") ?? "0");
      const hi = Number(this.getAttribute("max") ?? "100");
      return Math.min(Math.max(n, Number.isNaN(lo) ? n : lo), Number.isNaN(hi) ? n : hi);
    },
  });
}

/** A button's `value`, which the DOM gives every one of them and linkedom gives
 * none.
 *
 * The interpreter reads a control's leaves off the ELEMENT — `value` off the
 * closest input, select, textarea or BUTTON — so in a browser every click
 * carries `value: ""` from the button it came from, where here it carried
 * nothing at all. A guard or an assign reading the event's value then answers
 * one way under test and the other way in front of a reader, which is the whole
 * class this shim closes: a questionnaire's Back arrow read an empty string as
 * an unanswered question and blocked a step the reader had already answered. */
function buttonValue(document: unknown): void {
  const proto = Object.getPrototypeOf(
    (document as { createElement(tag: string): object }).createElement("button"),
  ) as object;
  if (Object.getOwnPropertyDescriptor(proto, "value") !== undefined) return;
  Object.defineProperty(proto, "value", {
    configurable: true,
    get(this: { getAttribute(name: string): string | null }) {
      return this.getAttribute("value") ?? "";
    },
    set(this: { setAttribute(name: string, v: string): void }, v: string) {
      this.setAttribute("value", String(v));
    },
  });
}

/** A select's `value` setter, which linkedom omits: its select answers `value`
 * off the `selected` attribute and refuses an assignment, so a `data-value`
 * binding on a select threw at mount here while working in every browser.
 *
 * The setter is the browser's: the first option whose value matches becomes the
 * selected one and every other option stops being selected. A value no option
 * offers selects nothing, and the select then reads back as the empty string —
 * never the first option, which would show a choice the row never made. */
function selectValue(document: unknown): void {
  type Option = {
    textContent: string | null;
    getAttribute(name: string): string | null;
    hasAttribute(name: string): boolean;
    setAttribute(name: string, v: string): void;
    removeAttribute(name: string): void;
  };
  type Select = { querySelectorAll(sel: string): Option[]; _prontoNoMatch?: boolean };
  let proto = Object.getPrototypeOf(
    (document as { createElement(tag: string): object }).createElement("select"),
  ) as object | null;
  let found: PropertyDescriptor | undefined;
  while (proto !== null && found === undefined) {
    found = Object.getOwnPropertyDescriptor(proto, "value");
    if (found === undefined) proto = Object.getPrototypeOf(proto);
  }
  if (proto === null || found?.get === undefined) {
    throw new Error("linkedom's select no longer answers value; this shim has nothing to extend");
  }
  if (found.set !== undefined) return;
  const read = found.get;
  const optionValue = (o: Option) => o.getAttribute("value") ?? (o.textContent ?? "").trim();
  Object.defineProperty(proto, "value", {
    configurable: true,
    get(this: Select) {
      // A selected option answers for itself, whoever selected it — choose()
      // moves the attribute directly.
      const picked = [...this.querySelectorAll("option")].find((o) => o.hasAttribute("selected"));
      if (picked !== undefined) return optionValue(picked);
      return this._prontoNoMatch === true ? "" : read.call(this);
    },
    set(this: Select, v: string) {
      const options = [...this.querySelectorAll("option")];
      const match = options.find((o) => optionValue(o) === String(v));
      for (const o of options) if (o !== match) o.removeAttribute("selected");
      if (match !== undefined) match.setAttribute("selected", "");
      this._prontoNoMatch = match === undefined;
    },
  });
}

/** The control properties linkedom declares nowhere. `checked` is the state a
 * radio or checkbox submits — the attribute is that state here, as it is for
 * value, and a radio's group clears when one of its own is set. */
export function controlProperties(document: unknown) {
  type Input = {
    type?: string;
    name?: string;
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
    closest(selector: string): { querySelectorAll(sel: string): Input[] } | null;
  };
  valueAsNumber(document);
  buttonValue(document);
  selectValue(document);
  const proto = Object.getPrototypeOf(
    (document as { createElement(tag: string): object }).createElement("input"),
  ) as object;
  if (Object.getOwnPropertyDescriptor(proto, "checked") !== undefined) return;

  Object.defineProperty(proto, "checked", {
    configurable: true,
    get(this: Input) {
      return this.getAttribute("checked") !== null;
    },
    set(this: Input, on: boolean) {
      if (!on) {
        this.removeAttribute("checked");
        return;
      }
      if (this.type === "radio" && this.name !== undefined) {
        const scope = this.closest("form");
        for (const peer of scope?.querySelectorAll(`input[type=radio][name="${this.name}"]`) ?? []) {
          peer.removeAttribute("checked");
        }
      }
      this.setAttribute("checked", "");
    },
  });
}
