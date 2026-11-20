// Sign-in for the terminal: the session a page holds and how it came by it —
// the device's session taken up from its cookie, a guest minted or adopted,
// the passkey ceremonies, the accounts this device signed in to — and the
// nav's chip and panel that offer them. shell.js wires them to the page.
import { parseMarkup } from "./markup.js";
import { accountBox, nameOf, offersSignin, ownName, providerHref, providerKey, signinBox, supportsPasskeys } from "./chrome.js";
import { authPosture } from "./cortex-navigation.js";
import { signal, signalName } from "./passkey-signals.js";

export const recoveryKey = "pronto-release-recovery";
export const sessionOwner = (session) => {
  if (session === null) return null;
  const subject = claimsOf(session.token)?.sub ?? session.user?.id;
  return JSON.stringify(subject === undefined ? ["token", session.token] : ["subject", subject]);
};
/** A guest that wrote, whose work a sign-in elsewhere would leave behind. */
export const keepsWork = (session) => Boolean(session?.user?.guest && session.committed);
export const forgetSession = () => {
  sessionStorage.removeItem(recoveryKey);
  localStorage.removeItem("pronto-token");
};
export const storedSessionOwner = () => {
  try {
    return sessionOwner(JSON.parse(localStorage.getItem("pronto-token") ?? "null"));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    forgetSession();
    return undefined;
  }
};

/** Whether the account a stored token names still exists.
 *
 * Deliberately fails OPEN: a cluster that cannot be reached is a cluster that
 * cannot answer the question, and signing somebody out because their wifi
 * dropped would be a worse bug than the one this prevents. Only a definite
 * empty answer — the request succeeded and the row is not there — ends the
 * session.
 */
export async function accountLives(session) {
  const sub = claimsOf(session.token)?.sub;
  if (!sub) return true;
  try {
    const res = await fetch(`/crud/app_user?id=eq.${encodeURIComponent(sub)}&select=id&limit=1`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    // A refused token is a dead session, however live its account.
    if (res.status === 401) return false;
    if (!res.ok) return true;
    return (await res.json()).length > 0;
  } catch {
    return true;
  }
}

// The auth service leaves this readable cookie beside the HttpOnly session
// one (mecha's services/auth/README.md), so a tab that has none never asks
// for a session it does not have.
const SESSION_HINT = "mecha_session_hint";
const sessionHinted = () => (globalThis.document?.cookie ?? "").split(";").some((c) => c.trim().startsWith(`${SESSION_HINT}=`));

/** The device's session from its cookie, or null. A redirect cannot write
 * localStorage, so a provider's return lands here, and a bearer expired or
 * cleared is taken up again without a ceremony. A live non-guest session
 * keeps its identity. A guest's sign-in whose account is another's comes
 * back `{taken}`, that account, for the reader to take or leave. Fails open
 * as accountLives does: offline, the tab boots as it would have. */
export async function adoptDeviceSession(cfg) {
  if (!cfg.auth?.service || !sessionHinted()) return null;
  let held = null;
  try {
    held = JSON.parse(localStorage.getItem("pronto-token") ?? "null");
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  if (held !== null && !held.user?.guest && await accountLives(held)) return null;
  let res;
  try {
    res = await fetch(`${cfg.auth.service}/session`, { method: "POST", credentials: "same-origin" });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return null;
  }
  // Signed out elsewhere, or the link revoked: the hint is stale, and the
  // next boot need not ask.
  if (res.status === 401) {
    document.cookie = `${SESSION_HINT}=; Path=/; Max-Age=0`;
    return null;
  }
  if (res.status === 409) {
    const { user, offer } = await res.json();
    return { taken: { user, offer } };
  }
  if (!res.ok) throw new Error(`${res.status} POST ${cfg.auth.service}/session`);
  const fresh = await res.json();
  const same = sessionOwner(fresh) === sessionOwner(held);
  if (!same) sessionStorage.removeItem(recoveryKey);
  // What the device knows of its own guest — that it wrote, that it was
  // shown — is no claim the cookie carries, and outlives a fresh token.
  const session = same ? { ...fresh, ...(held.committed ? { committed: true } : {}), ...(held.shown ? { shown: true } : {}) } : fresh;
  localStorage.setItem("pronto-token", JSON.stringify(session));
  return session;
}

/** A guest an earlier release kept in this tab's sessionStorage, from before
 * sessions said how they were signed in, taken up once as the device's
 * session, so moving the session to localStorage leaves no guest's work
 * behind. Offline, it waits for the next boot. */
export async function upgradeEarlierGuest(cfg) {
  const kept = sessionStorage.getItem("pronto-token");
  if (kept === null || !cfg.auth?.service) return;
  let earlier = null;
  try {
    earlier = JSON.parse(kept);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  const token = earlier?.user?.guest ? earlier.token : null;
  if (token === null || claimsOf(token)?.acr !== undefined || localStorage.getItem("pronto-token") !== null) {
    sessionStorage.removeItem("pronto-token");
    return;
  }
  let res;
  try {
    res = await fetch(`${cfg.auth.service}/session/adopt`, { method: "POST", credentials: "same-origin", headers: { Authorization: `Bearer ${token}` } });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return;
  }
  if (res.status >= 500) throw new Error(`${res.status} POST ${cfg.auth.service}/session/adopt`);
  sessionStorage.removeItem("pronto-token");
  // A guest that outlived a release has had the time to write.
  if (res.ok) localStorage.setItem("pronto-token", JSON.stringify({ ...(await res.json()), committed: true }));
}

/** A guest minted ahead of the reader made the device's session, unless the
 * device has one: a sign-in that finished first. */
export async function adoptGuest(cfg, s) {
  if (!cfg.auth?.service) return;
  const res = await fetch(`${cfg.auth.service}/session/adopt`, { method: "POST", credentials: "same-origin", headers: { Authorization: `Bearer ${s.token}` } });
  if (!res.ok && res.status !== 409) throw new Error(`${res.status} POST ${cfg.auth.service}/session/adopt`);
}

/** A guest session from the auth service. A served or kept document on show
 * (`reading`) stays the page while no answer can arrive — a tab opened offline
 * paints what the worker kept, and holds no session yet, since one lives in
 * the tab — so the mint is asked again once the browser is back online, or a
 * backoff has passed. With nothing on show, there is nothing to keep. */
export async function mintGuest(cfg, reading, device = true) {
  for (let wait = 2000; ; wait = Math.min(wait * 2, 15000)) {
    let res;
    try {
      res = await fetch(`${cfg.auth?.service ?? "/auth"}/guest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(device ? {} : { cookie: false }),
      });
    } catch (err) {
      // fetch rejects with a TypeError when no answer arrived at all.
      if (!reading || !(err instanceof TypeError)) throw err;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, wait);
        addEventListener("online", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      continue;
    }
    if (!res.ok) throw new Error(`Guest auth failed with status ${res.status}: ${await res.text()}`);
    return res.json();
  }
}

/** The JWT payload, or null if it is not one. */
function claimsOf(token) {
  try {
    const part = String(token).split(".")[1];
    return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

/** The accounts this device signed in to with a passkey, the most recent
 * first: what Passkey shows as faces, each asked for by its own passkey so
 * no browser list opens. A list the device keeps for itself — Forget takes an
 * account off it, never the account or its passkey, which the browser's list
 * still offers. */
const DEVICE_ACCOUNTS = "pronto-device-accounts";
const DEVICE_ACCOUNTS_KEPT = 8;
export function deviceAccounts() {
  try {
    return JSON.parse(localStorage.getItem(DEVICE_ACCOUNTS) ?? "[]");
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    localStorage.removeItem(DEVICE_ACCOUNTS);
    return [];
  }
}
const keepDeviceAccounts = (accounts) => localStorage.setItem(DEVICE_ACCOUNTS, JSON.stringify(accounts.slice(0, DEVICE_ACCOUNTS_KEPT)));
/** A person's passkey session puts its account first; a guest is no face. */
export function rememberAccount(session, credential) {
  if (session.user.guest || !credential) return;
  keepDeviceAccounts([{ id: session.user.id, handle: session.user.handle, credential }, ...deviceAccounts().filter((a) => a.id !== session.user.id)]);
}
export const renameAccount = (id, handle) => keepDeviceAccounts(deviceAccounts().map((a) => (a.id === id ? { ...a, handle } : a)));
export const forgetAccount = (pred) => keepDeviceAccounts(deviceAccounts().filter((a) => !pred(a)));

// WebAuthn wire format: the auth service speaks @simplewebauthn JSON
// (base64url strings) while navigator.credentials wants ArrayBuffers.
const bufFromB64u = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)).buffer;
const b64uFromBuf = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export async function postJson(url, body, token) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    const error = new Error(`${res.status} POST ${url}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    error.status = res.status;
    if (res.headers.get("content-type")?.startsWith("application/json")) error.body = JSON.parse(detail);
    throw error;
  }
  return res.json();
}

const rpIdOf = (options) => options?.rpId ?? options?.rp?.id ?? globalThis.location?.hostname;

// Both ceremonies are usernameless by terminal doctrine (identity is generated
// server-side): POST {service}/<kind>/start {} → the WebAuthn options object
// flat, plus `state` (the server's stateless challenge JWT, echoed back
// verbatim); then POST {service}/<kind>/verify {state, response} →
// {token, user, passkey}. A register started with a guest's token gives that
// guest's identity the passkey rather than minting a new one. A sign-in sent
// with a guest's token finds the passkey another account's as 409
// `login_required`, carrying that account's session for the reader to take or
// leave; one on a device with nothing saved says so (`empty`), and the device's
// way in goes on to create the account there (the session chart).
export async function registerCeremony(service, token, name) {
  const { state, ...options } = await postJson(`${service}/register/start`, name ? { name } : {}, token);
  const cred = await navigator.credentials.create({
    publicKey: {
      ...options,
      // The browser leads with this device rather than first asking where
      // to keep the passkey; a phone or a security key is still offered.
      hints: ["client-device"],
      challenge: bufFromB64u(options.challenge),
      user: { ...options.user, id: bufFromB64u(options.user.id) },
      excludeCredentials: (options.excludeCredentials ?? []).map((c) => ({
        ...c,
        id: bufFromB64u(c.id),
      })),
    },
  });
  const session = await postJson(`${service}/register/verify`, {
    state,
    response: {
      id: cred.id,
      rawId: b64uFromBuf(cred.rawId),
      type: cred.type,
      clientExtensionResults: cred.getClientExtensionResults(),
      authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
      response: {
        clientDataJSON: b64uFromBuf(cred.response.clientDataJSON),
        attestationObject: b64uFromBuf(cred.response.attestationObject),
        transports: cred.response.getTransports?.() ?? [],
      },
    },
  });
  signalName(session, nameOf(session.user.handle));
  rememberAccount(session, cred.id);
  return session;
}

/** What the device is called, for a reader who gives no name of their own:
 * the kind of device, as its browser says it. None where it says nothing
 * known, and the account keeps the name it has. */
export function deviceName() {
  const said = `${globalThis.navigator?.userAgentData?.platform ?? ""} ${globalThis.navigator?.userAgent ?? ""}`;
  // A phone's agent names the desktop it imitates too, so it is asked first.
  for (const [test, name] of [[/iPhone/, "iPhone"], [/iPad/, "iPad"], [/Android/, "Android"], [/CrOS|Chrome OS/, "Chromebook"], [/Mac/, "Mac"], [/Win/, "Windows"], [/Linux/, "Linux"]]) {
    if (test.test(said)) return name;
  }
  return "";
}

/** The name the account is made under, asked once the device answered that
 * it holds nothing of this app's: one field the browser fills with the
 * reader's first name in a tap, and Continue, which makes the account and is
 * the click the device's dialog needs. An empty field takes the device's
 * name. `answer` resolves with the name, `back` returns to the ways in. */
export function nameForm(chrome) {
  const form = document.createElement("form");
  form.className = "shell-name-form";
  form.append(parseMarkup(document, `<button type="button" class="shell-name-back"><svg class="shell-back-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg></button>
    <label class="shell-name-label" for="shell-name-input"></label>
    <input id="shell-name-input" name="given-name" autocomplete="given-name">
    <p class="shell-auth-error" role="alert" hidden></p>
    <button type="submit" class="shell-name-continue"><svg class="shell-device-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/></svg><span></span></button>`));
  form.querySelector(".shell-name-back").setAttribute("aria-label", chrome("chrome_back"));
  form.querySelector(".shell-name-label").textContent = chrome("chrome_name_title");
  form.querySelector("input").setAttribute("placeholder", chrome("chrome_name_label"));
  form.querySelector(".shell-name-continue span").textContent = chrome("chrome_continue");
  const error = form.querySelector(".shell-auth-error");
  return {
    form,
    name: () => form.querySelector("input").value.trim() || deviceName() || undefined,
    say(key) {
      error.textContent = chrome(key);
      error.hidden = false;
    },
  };
}
export const nameTaken = (err) => err?.status === 409 && err.body?.error === "name taken";

/** Whether this browser asks the device alone, answering at once and with no
 * dialog when nothing is saved on it (WebAuthn's immediate UI mode). Learnt
 * when the page starts (learnDeviceAlone): immediate mode needs the click's
 * activation still live when it asks, so the click spends none of it here. */
let deviceAlone = false;
let deviceAloneLearnt = Promise.resolve(false);
export function learnDeviceAlone() {
  deviceAlone = false;
  const asked = globalThis.PublicKeyCredential?.getClientCapabilities?.();
  if (asked === undefined) deviceAloneLearnt = Promise.resolve(false);
  else deviceAloneLearnt = asked.then((capabilities) => (deviceAlone = capabilities?.immediateGet === true));
}

/** A sign-in's challenge, asked for as soon as a way in is on screen
 * (askAhead). One challenge serves one ceremony, so taking it asks for the
 * next; one older than the server's 300 s state is asked for again. An answer
 * that failed fails the sign-in that takes it, and the next asks afresh. */
const CHALLENGE_FRESH_MS = 240_000;
let ahead = null;
/** A challenge is the shell's that asked for it, against its own service. */
export const dropAhead = () => {
  ahead = null;
};
export function askAhead(service) {
  const at = Date.now();
  const entry = { settled: null };
  entry.answer = postJson(`${service}/login/start`, {}).then(
    (options) => (entry.settled = { options, at }),
    (error) => (entry.settled = { error, at }),
  );
  ahead = entry;
}
/** Whether a fresh challenge is in hand this moment, with no wait before the
 * device is asked. */
const challengeInHand = () =>
  ahead?.settled?.options !== undefined && Date.now() - ahead.settled.at < CHALLENGE_FRESH_MS;
export async function challenge(service) {
  const taken = ahead;
  askAhead(service);
  const got = taken === null ? null : await taken.answer;
  if (got?.error) throw got.error;
  if (got !== null && Date.now() - got.at < CHALLENGE_FRESH_MS) return got.options;
  return postJson(`${service}/login/start`, {});
}

// `how` "device" asks the device alone where the browser can, so a device
// with nothing saved says so without a dialog offering other devices;
// `{credential}` asks for that one passkey, a face of Passkey's;
// `{conditional}` (an AbortSignal) waits on the browser's autofill of the
// field marked `webauthn` for whichever passkey the reader picks there; any
// other sign-in reaches a phone too. Asking alone needs the click's
// activation live when the device is asked, so it is asked alone only with a
// challenge already in hand; one still on its way is waited for, and the
// device is then asked as usual, which needs no activation and offers a
// phone besides — never read as a device with nothing saved.
export async function loginCeremony(service, how, hint = null) {
  const immediate = how === "device" && deviceAlone && challengeInHand();
  const { state, ...options } = await challenge(service);
  const rpId = rpIdOf(options);
  let cred;
  try {
    cred = await navigator.credentials.get({
      ...(immediate ? { uiMode: "immediate" } : {}),
      ...(how?.conditional ? { mediation: "conditional", signal: how.conditional } : {}),
      publicKey: {
        ...options,
        challenge: bufFromB64u(options.challenge),
        allowCredentials: (how?.credential ? [{ type: "public-key", id: how.credential }] : options.allowCredentials ?? []).map((c) => ({
          ...c,
          id: bufFromB64u(c.id),
        })),
      },
    });
  } catch (err) {
    // Asked alone, the device refuses at once when nothing is saved on it;
    // asked otherwise, a refusal is the reader's dismissal, and says nothing
    // about the device.
    if (immediate && err?.name === "NotAllowedError") err.empty = true;
    throw err;
  }
  try {
    const session = await postJson(`${service}/login/verify`, {
      state,
      response: {
        id: cred.id,
        rawId: b64uFromBuf(cred.rawId),
        type: cred.type,
        clientExtensionResults: cred.getClientExtensionResults(),
        response: {
          clientDataJSON: b64uFromBuf(cred.response.clientDataJSON),
          authenticatorData: b64uFromBuf(cred.response.authenticatorData),
          signature: b64uFromBuf(cred.response.signature),
          userHandle: cred.response.userHandle ? b64uFromBuf(cred.response.userHandle) : undefined,
        },
      },
    }, hint);
    signalName(session, nameOf(session.user.handle));
    rememberAccount(session, cred.id);
    return session;
  } catch (err) {
    // A passkey the server no longer holds — its account or database gone —
    // is dropped from the device, so it is not offered first next time, and
    // the device holds nothing of this app's.
    if (err?.status === 401 && err.body?.unknownCredential === true) {
      signal("signalUnknownCredential", { rpId, credentialId: cred.id });
      forgetAccount((a) => a.credential === cred.id);
      err.empty = true;
    }
    if (err?.status === 409 && err.body?.error === "login_required") {
      err.taken = { user: err.body.user, credential: cred.id, offer: err.body.offer };
    }
    throw err;
  }
}

// Resolves {token, user} once a ceremony succeeds; failures surface inline
// and leave the form live for another attempt. `chrome` answers the terminal's
// own copy in the reader's language.
export function renderLogin(mount, cfg, chrome) {
  const wrap = document.createElement("div");
  wrap.className = "shell-login";
  // Every word is written in after the template rather than interpolated into
  // it: a catalogue is app data, and data spliced into markup is an injection
  // seam where a literal was none.
  wrap.append(parseMarkup(document, `<header class="login-intro">
    <span class="login-mark" aria-hidden="true"></span>
    <h1 id="shell-login-title"></h1>
    <p class="login-hint" id="shell-login-hint"></p>
  </header><form aria-labelledby="shell-login-title" aria-describedby="shell-login-hint">
    <div class="login-error" role="alert" hidden>
      <p class="login-error-text"></p>
    </div>
    <div class="login-actions">
      <button type="submit" class="login-passkey"></button>
      <button type="button" class="login-guest"></button>
    </div>
  </form>`));
  // A provider's way in leaves the page, so it is a link, not a button: the
  // provider brings the reader back to this address, where the boot adopts
  // the session (adoptDeviceSession).
  const here = `${location.pathname ?? "/"}${location.search ?? ""}`;
  for (const provider of cfg.auth.providers ?? []) {
    const a = document.createElement("a");
    a.className = "login-provider";
    a.dataset.provider = provider;
    a.href = providerHref(cfg.auth.service, provider, here);
    a.textContent = chrome(providerKey(provider));
    wrap.querySelector(".login-passkey").before(a);
  }
  wrap.querySelector("h1").textContent = cfg.app;
  wrap.querySelector(".login-mark").textContent = [...cfg.app][0]?.toLocaleUpperCase() ?? "";
  wrap.querySelector(".login-hint").textContent = chrome("chrome_signin_hint");
  wrap.querySelector("button[type=submit]").textContent = chrome("chrome_signin");
  wrap.querySelector(".login-guest").textContent = chrome("chrome_signin_guest");
  mount.replaceChildren(wrap);
  askAhead(cfg.auth.service);
  return new Promise((resolve) => {
    const form = wrap.querySelector("form");
    const error = wrap.querySelector(".login-error");
    const errorText = wrap.querySelector(".login-error-text");
    // A device with nothing saved is where the account is made, under the
    // name the reader gives.
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      error.setAttribute("hidden", "");
      loginCeremony(cfg.auth.service, "device").then(resolve, (err) => {
        if (err?.empty !== true) {
          // What failed is the platform's own sentence, in whatever language
          // the browser threw it in and about a ceremony the reader did not
          // ask to know the shape of. It goes to the console, where it is
          // diagnosable; the reader is told, in theirs, that it did not work.
          console.error(err);
          errorText.textContent = chrome("chrome_signin_failed");
          error.removeAttribute("hidden");
          return;
        }
        const named = nameForm(chrome);
        form.hidden = true;
        form.after(named.form);
        named.form.querySelector("input").focus();
        named.form.querySelector(".shell-name-back").addEventListener("click", () => {
          named.form.remove();
          form.hidden = false;
        });
        named.form.addEventListener("submit", async (submitted) => {
          submitted.preventDefault();
          try {
            resolve(await registerCeremony(cfg.auth.service, null, named.name()));
          } catch (failed) {
            console.error(failed);
            named.say(nameTaken(failed) ? "chrome_name_taken" : "chrome_signin_failed");
          }
        });
      });
    });
    // Guest is terminal doctrine, rendered unconditionally: passkey ceremonies
    // verify the server-pinned WEBAUTHN_ORIGIN, so on any other origin this is
    // the only door that opens. Each click mints a fresh generated identity.
    wrap.querySelector(".login-guest").addEventListener("click", async () => {
      error.setAttribute("hidden", "");
      try {
        const s = await postJson(`${cfg.auth.service}/guest`, {});
        s.committed = true;
        resolve(s);
      } catch (err) {
        console.error(err);
        errorText.textContent = chrome("chrome_signin_failed");
        error.removeAttribute("hidden");
      }
    });
  });
}

export function syncAuthDOM(nav, session, opts = {}) {
  if (opts.lifecycle && opts.lifecycle.session() !== session) {
    opts.lifecycle.setSession(session);
  }
  const auth = opts.lifecycle ? opts.lifecycle.posture() : authPosture(session);
  if (document.body) document.body.dataset.auth = auth;
  const box = nav?.querySelector(":scope > .shell-me");
  if (box) box.dataset.auth = auth;
  for (const el of document.querySelectorAll("[data-auth-field]")) {
    const field = el.dataset.authField;
    if (auth === "anonymous") {
      delete el._prontoAuthOverride;
      if (el._prontoAuthAnonymous !== undefined) {
        el.textContent = el._prontoAuthAnonymous;
        delete el._prontoAuthAnonymous;
      }
    } else if (field === "handle" || field === "name") {
      if (el._prontoAuthAnonymous === undefined) el._prontoAuthAnonymous = el.textContent ?? "";
      const val = field === "name" ? (session?.user?.name ?? session?.user?.handle ?? "") : (session?.user?.handle ?? "");
      el._prontoAuthOverride = val;
      el.textContent = val;
    }
  }
}

/** The nav's Sign in, or a kept guest's chip, bound to the panel it opens
 * and closes in place. A served document's nav already holds a visitor's box
 * (document.js), and it is the one bound. Passkey shows where the browser
 * has passkeys. A visitor offered no way in at all has nothing to open. */
export function renderSignin(cfg, served = null, session = null) {
  const auth = authPosture(session);
  const guest = auth === "guest" ? session.user : null;
  // A document another deploy rendered may hold an older box: only one
  // with this panel and its Passkey is this box.
  const box = guest === null && served?.querySelector(':scope > .shell-signin-panel [data-auth-action="accounts"]') ? served : signinBox(document, cfg, guest);
  box.dataset.auth = auth;
  if (document.body) document.body.dataset.auth = auth;
  const open = box.querySelector(":scope > .shell-signin");
  const panel = box.querySelector(":scope > .shell-signin-panel");
  const device = panel.querySelector('[data-auth-action="accounts"]');
  device.hidden = !supportsPasskeys();
  open.hidden = guest === null && panel.querySelector(".shell-provider, .shell-passkey:not([hidden])") === null;
  // A device asked alone needs a challenge already in hand, for this way in
  // and any an app places in its own markup.
  deviceAloneLearnt.then((alone) => {
    if (alone && !device.hidden) askAhead(cfg.auth.service);
  });
  wirePanel(box);
  return box;
}

/** A step the panel goes on to — Passkey's accounts, the name a new one
 * is made under — in place of what it showed, which `uncover` brings back. */
export function cover(panel, step) {
  step.dataset.step = "";
  step._covered = [...panel.children].filter((el) => !el.hidden);
  for (const el of step._covered) el.hidden = true;
  panel.append(step);
}
export function uncover(step) {
  step._release?.();
  step.remove();
  for (const el of step._covered) el.hidden = false;
}

/** The chip opens its panel in place and closes it again, as do the panel's
 * close button and Escape; closed, it opens next on its first step. */
function wirePanel(box) {
  const open = box.querySelector(":scope > :is(.shell-signin, .shell-person)");
  const panel = box.querySelector(":scope > .shell-signin-panel");
  const show = (expanded) => {
    open.setAttribute("aria-expanded", String(expanded));
    panel.hidden = !expanded;
    if (!expanded) panel.querySelector(".shell-delete")?.removeAttribute("data-confirm");
    if (!expanded) for (const step of [...panel.querySelectorAll(":scope > [data-step]")].reverse()) uncover(step);
  };
  open.addEventListener("click", () => show(panel.hidden));
  panel.querySelector(".shell-signin-close")?.addEventListener("click", () => {
    show(false);
    open.focus();
  });
  box.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || panel.hidden) return;
    show(false);
    open.focus();
  });
}
export function renderSession(session, cfg, store, chrome, served = null) {
  // A guest is shown once it has written — before that it is a visitor's
  // Sign in — and only where the app declares a way in: without one there is
  // nothing to keep it with, and signing out only mints another.
  if (session.user.guest) {
    if (offersSignin(cfg)) return renderSignin(cfg, served, session);
    const none = document.createElement("span");
    none.className = "shell-me";
    return none;
  }

  // Under the handle, the address a provider vouched for, else how this
  // device signed in.
  const label = session.user.email ? { text: session.user.email } : session.passkey ? { key: "chrome_device" } : { text: "" };
  const box = accountBox(document, cfg, session.user, label);
  box.dataset.auth = "user";
  if (document.body) document.body.dataset.auth = "user";
  // Written here as well as by localizeStrip, which runs from show(), past a
  // currentRoute() that throws on an address the app has no route for, while
  // the strip outlives that banner beside the mount: the only way out of a
  // session may not be a control with no word on it.
  for (const el of box.querySelectorAll("[data-key]")) el.textContent = chrome(el.getAttribute("data-key"), cfg.i18n?.default);
  wirePanel(box);

  // The strip is one of the places a person appears, so a rename has to reach
  // it the way it reaches a byline: read live, not stamped from the token,
  // whose claims are fixed for the session.
  const self = cfg.auth?.self;
  if (self?.name !== undefined) {
    const paint = async () => {
      const [row] = await store.query(self.name.table, undefined, {
        filter: `id=eq.${session.user.id}`,
      });
      const called = row?.[self.name.column];
      if (!called) return;
      box.querySelector(".shell-chip-who .handle").replaceWith(ownName(document, session.user.handle, called));
      // The passkey manager shows the name the person chose, not the handle
      // their passkey was made under.
      signalName(session, called);
    };
    store.subscribe(self.name.table, paint);
    paint();
  }
  return box;
}
