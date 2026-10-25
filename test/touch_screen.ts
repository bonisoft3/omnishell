// A touch screen for the kinetic tests: the double attachTouch reads, in a
// document of its own.
import { attachTouch } from "../interpreter/kinetic.js";

/** A screen whose layout the test draws, in a document of its own: each
 * pointer id is over the zones the test says, and events reach the screen as
 * a finger's do. It counts what the tracker asks of it: hit tests, writes of
 * the held list, captures, and the stylesheets the document adopts. */
export function screen() {
  const attrs: Record<string, string> = {};
  const writes: string[] = [];
  const captured: number[] = [];
  const win = Object.assign(new EventTarget(), {
    CSSStyleSheet: class {
      css = "";
      replaceSync(css: string) {
        this.css = css;
      }
    },
  });
  const doc = Object.assign(new EventTarget(), { defaultView: win, hidden: false, adoptedStyleSheets: [] as { css: string }[] });
  const root = Object.assign(new EventTarget(), {
    ownerDocument: doc,
    dataset: {} as Record<string, string>,
    setAttribute: (name: string, value: string) => {
      attrs[name] = value;
      writes.push(value);
    },
    setPointerCapture: (id: number) => captured.push(id),
  });
  const under = new Map<number, string[]>();
  let hits = 0;
  const fire = (type: string, id: number) => {
    const ev = new Event(type, { cancelable: true }) as Event & { pointerId: number };
    ev.pointerId = id;
    root.dispatchEvent(ev);
    return ev;
  };
  const zonesAt = (ev: { pointerId: number }) => {
    hits++;
    return under.get(ev.pointerId) ?? [];
  };
  return {
    // The screen element, as far as the tracker reads one.
    root: root as unknown as Element,
    doc,
    win,
    attrs,
    writes,
    captured,
    zonesAt,
    get hits() {
      return hits;
    },
    track: () => attachTouch(root as unknown as Element, { zonesAt }),
    down(id: number, zones: string[]) {
      under.set(id, zones);
      return fire("pointerdown", id);
    },
    move(id: number, zones: string[]) {
      under.set(id, zones);
      fire("pointermove", id);
    },
    up(id: number) {
      fire("pointerup", id);
      under.delete(id);
    },
    fire,
  };
}
