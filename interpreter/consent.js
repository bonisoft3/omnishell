// The reader's consent to advertising: the app's tags storing and sending for
// ads, Consent Mode's ad_storage, ad_user_data and ad_personalization. Google's
// analytics_storage follows it, so nothing of Google's is stored unless
// advertising is granted; the app's own measurement is never asked. The
// declaration is shell.json's `consent` (pronto's #Consent): every reader is
// asked alike, in a bar on the first view, or, under mode "none", nobody is
// and `none.advertising` holds for everyone.

import { drawIcon } from "./chrome.js";

export const CONSENT_KEY = "pronto-consent";
export const CONSENT_DISMISSED_KEY = "pronto-consent-dismissed";
export const CONSENT_SHOW_DELAY_MS = 2500;

/** The four Consent Mode signals for an advertising choice. */
export const signalsOf = (advertising) => ({
  ad_storage: advertising,
  ad_user_data: advertising,
  ad_personalization: advertising,
  analytics_storage: advertising,
});

/** The choice this device holds under the declared policy version, or null:
 * a record under another version is asked again. */
export function storedChoice(storage, version) {
  const text = storage.getItem(CONSENT_KEY);
  if (text === null) return null;
  const record = JSON.parse(text);
  return record.version === version ? record : null;
}

/** The floating card: a title with close button, policy copy and link, Reject
 * and Accept side by side; and the control that reopens it. Both hidden until
 * shown; `choose` hears "granted" or "denied". */
export function drawConsent(doc, { text, policy, choose, dismiss }) {
  const bar = doc.createElement("section");
  bar.className = "shell-consent";
  bar.hidden = true;
  bar.setAttribute("role", "region");
  const head = doc.createElement("div");
  head.className = "shell-consent-head";
  const title = doc.createElement("strong");
  title.className = "shell-consent-title";
  const close = doc.createElement("button");
  close.type = "button";
  close.className = "shell-consent-close";
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M6 6l12 12M18 6L6 18");
  svg.append(path);
  close.append(svg);
  close.addEventListener("click", () => dismiss());
  head.append(title, close);
  const body = doc.createElement("p");
  const words = doc.createElement("span");
  const link = doc.createElement("a");
  link.href = policy;
  link.rel = "privacy-policy noopener";
  link.target = "_blank";
  body.append(words, " ", link);
  const actions = doc.createElement("div");
  actions.className = "shell-consent-actions";
  const button = (value) => {
    const b = doc.createElement("button");
    b.type = "button";
    b.dataset.consent = value;
    b.addEventListener("click", () => choose(value));
    return b;
  };
  const reject = button("denied");
  const accept = button("granted");
  actions.append(reject, accept);
  bar.append(head, body, actions);

  const open = doc.createElement("button");
  open.type = "button";
  open.className = "shell-consent-open";
  open.hidden = true;
  open.append(drawIcon(doc, "shield"));

  bar.setAttribute("aria-label", text("chrome_consent_title"));
  title.textContent = text("chrome_consent_title");
  words.textContent = text("chrome_consent_body");
  link.textContent = text("chrome_consent_policy");
  reject.textContent = text("chrome_consent_reject");
  accept.textContent = text("chrome_consent_accept");
  close.setAttribute("aria-label", text("chrome_consent_close"));
  close.title = text("chrome_consent_close");
  open.setAttribute("aria-label", text("chrome_consent_choices"));
  open.title = text("chrome_consent_choices");
  return { bar, open, close };
}

/**
 * States the reader's advertising signals through `gtag` before anything
 * else can: what they chose, else denied. On a host whose tags consent
 * governs, once `ready` (the catalogues) resolves, it mounts the bar hidden
 * beside the reopen shield and arms a first-interaction listener; after the
 * first trusted interaction and a short delay, it shows the bar unless the
 * reader already answered, has Global Privacy Control enabled, or dismissed
 * the bar for this tab.
 *
 * @param {object} opts
 * @param {any} opts.consent
 * @param {Document} opts.doc
 * @param {{ getItem(k: string): string | null, setItem(k: string, v: string): void, removeItem?(k: string): void }} opts.storage
 * @param {{ getItem(k: string): string | null, setItem(k: string, v: string): void, removeItem?(k: string): void } | null} [opts.sessionStorage]
 * @param {{ globalPrivacyControl?: boolean }} opts.navigator
 * @param {{ hostname: string }} opts.location
 * @param {(...args: unknown[]) => void} opts.gtag
 * @param {(key: string) => string} opts.text
 * @param {Promise<unknown>} opts.ready
 * @param {() => number} opts.now
 * @param {number} [opts.delayMs]
 * @param {(fn: () => void, ms: number) => any} [opts.schedule]
 * @param {(id: any) => void} [opts.cancel]
 */
export async function startConsent({
  consent,
  doc,
  storage,
  sessionStorage = null,
  navigator,
  location,
  gtag,
  text,
  ready,
  now,
  delayMs = CONSENT_SHOW_DELAY_MS,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (id) => clearTimeout(id),
}) {
  if (consent.mode === "none") {
    gtag("consent", "update", signalsOf(consent.none.advertising));
    return null;
  }
  const choice = storedChoice(storage, consent.policy.version);
  const gpc = navigator.globalPrivacyControl === true;
  gtag("consent", "update", signalsOf(choice?.advertising ?? "denied"));
  if (!consent.hosts.includes(location.hostname)) return null;
  await ready;

  let held = choice;
  let dismissed = sessionStorage?.getItem(CONSENT_DISMISSED_KEY) === consent.policy.version;
  let timer = null;
  let armed = false;
  const onInteract = (event) => {
    if (!event.isTrusted || screen.open.contains(event.target)) return;
    disarmListeners();
    timer = schedule(() => {
      timer = null;
      if (held === null && !dismissed && screen.bar.hidden) show(false);
    }, delayMs);
  };
  const disarmListeners = () => {
    if (!armed) return;
    armed = false;
    doc.removeEventListener("pointerdown", onInteract, true);
    doc.removeEventListener("keydown", onInteract, true);
  };
  const disarm = () => {
    disarmListeners();
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
  };
  const show = (focus) => {
    for (const b of screen.bar.querySelectorAll("button[data-consent]")) {
      b.setAttribute("aria-pressed", String(held?.advertising === b.dataset.consent));
    }
    screen.bar.hidden = false;
    screen.open.hidden = true;
    if (focus) screen.bar.querySelector("button[data-consent]").focus();
  };
  const hideBar = () => {
    const within = screen.bar.contains(doc.activeElement);
    screen.bar.hidden = true;
    screen.open.hidden = false;
    if (within) screen.open.focus();
  };
  const dismiss = () => {
    disarm();
    dismissed = true;
    sessionStorage?.setItem(CONSENT_DISMISSED_KEY, consent.policy.version);
    hideBar();
  };
  const screen = drawConsent(doc, {
    text,
    policy: consent.policy.url,
    choose: (advertising) => {
      disarm();
      dismissed = false;
      sessionStorage?.removeItem(CONSENT_DISMISSED_KEY);
      held = { version: consent.policy.version, advertising, at: new Date(now()).toISOString() };
      storage.setItem(CONSENT_KEY, JSON.stringify(held));
      gtag("consent", "update", signalsOf(advertising));
      hideBar();
    },
    dismiss,
  });
  screen.open.addEventListener("click", () => {
    disarm();
    show(true);
  });
  screen.bar.addEventListener("keydown", (event) => {
    if (event.key === "Escape") dismiss();
  });
  // First in the body, so the first Tab reaches it before the page.
  doc.body.prepend(screen.bar, screen.open);
  hideBar();
  if (held === null && !gpc && !dismissed) {
    armed = true;
    doc.addEventListener("pointerdown", onInteract, { capture: true, passive: true });
    doc.addEventListener("keydown", onInteract, { capture: true, passive: true });
  }
  return screen;
}
