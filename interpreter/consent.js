// The reader's consent to advertising: the app's tags storing and sending for
// ads, Consent Mode's ad_storage, ad_user_data and ad_personalization. Google's
// analytics_storage follows it, so nothing of Google's is stored unless
// advertising is granted; the app's own measurement is never asked. The
// declaration is shell.json's `consent` (pronto's #Consent): every reader is
// asked alike, in a bar on the first view, or, under mode "none", nobody is
// and `none.advertising` holds for everyone.

import { drawIcon } from "./chrome.js";

export const CONSENT_KEY = "pronto-consent";

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

/** The bar: a sentence with the policy link, and Reject and Accept as one
 * control twice; and the control that reopens it. Both hidden until shown;
 * `choose` hears "granted" or "denied". */
export function drawConsent(doc, { text, policy, choose }) {
  const bar = doc.createElement("section");
  bar.className = "shell-consent";
  bar.hidden = true;
  bar.setAttribute("role", "region");
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
  bar.append(body, actions);

  const open = doc.createElement("button");
  open.type = "button";
  open.className = "shell-consent-open";
  open.hidden = true;
  open.append(drawIcon(doc, "shield"));

  bar.setAttribute("aria-label", text("chrome_consent_title"));
  words.textContent = text("chrome_consent_body");
  link.textContent = text("chrome_consent_policy");
  reject.textContent = text("chrome_consent_reject");
  accept.textContent = text("chrome_consent_accept");
  open.setAttribute("aria-label", text("chrome_consent_choices"));
  open.title = text("chrome_consent_choices");
  return { bar, open };
}

/** States the reader's advertising signals through `gtag` before anything
 * else can: what they chose, else denied. On a host whose tags consent
 * governs, once `ready` (the catalogues) resolves, it draws the bar into
 * `doc.body`, shown on every view until answered. Ignoring it is a refusal,
 * and a Reject, or Global Privacy Control, is not asked again: the reopening
 * control stands in for the bar until the reader opens it. An explicit Accept
 * outranks Global Privacy Control. */
export async function startConsent({ consent, doc, storage, navigator, location, gtag, text, ready, now }) {
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
  const show = (focus) => {
    for (const b of screen.bar.querySelectorAll("button[data-consent]")) {
      b.setAttribute("aria-pressed", String(held?.advertising === b.dataset.consent));
    }
    screen.bar.hidden = false;
    screen.open.hidden = true;
    if (focus) screen.bar.querySelector("button[data-consent]").focus();
  };
  const hide = () => {
    const within = screen.bar.contains(doc.activeElement);
    screen.bar.hidden = true;
    screen.open.hidden = false;
    if (within) screen.open.focus();
  };
  const screen = drawConsent(doc, {
    text,
    policy: consent.policy.url,
    choose: (advertising) => {
      held = { version: consent.policy.version, advertising, at: new Date(now()).toISOString() };
      storage.setItem(CONSENT_KEY, JSON.stringify(held));
      gtag("consent", "update", signalsOf(advertising));
      hide();
    },
  });
  screen.open.addEventListener("click", () => show(true));
  screen.bar.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && (held !== null || gpc)) hide();
  });
  // First in the body, so the first Tab reaches it before the page.
  doc.body.prepend(screen.bar, screen.open);
  if (held === null && !gpc) show(false);
  else hide();
  return screen;
}
