// The terminal's own copy: the words the chrome says in its own voice, outside
// any screen's markup — the login gate, and the control that ends a session.
// They live here rather than in fragment.js because that leaf is the data
// plane's grammar and this is prose, and here rather than in shell.js because
// check-i18n grades an app against this table and must read it without a DOM.
//
// An app carrying catalogues answers these keys like any other, and check-i18n
// makes a missing one an error. The strings below are what the terminal says
// standalone, and what every app declaring no catalogue at all shows.

// The gate's copy, reachable only where the app requires a sign-in.
const LOGIN = {
  chrome_signin_hint: "One tap with your passkey — new here, one is created for you.",
  chrome_signin: "Continue",
  chrome_signin_guest: "Continue as guest",
  chrome_signin_failed: "That did not go through. Try again.",
};

// The strip's, drawn wherever a session exists — behind a gate, or as the guest
// every app with a table of its own is handed.
const SESSION = {
  chrome_signout: "sign out",
};

/** Which copy a reader can reach, by the surface that shows it: an app is asked
 * for the group its own declaration puts on screen, never for the rest. */
export const CHROME_KEYS = { login: Object.keys(LOGIN), session: Object.keys(SESSION) };

export const CHROME = { ...LOGIN, ...SESSION };

/** What the chrome says, in the language the page is in. A key no group holds
 * is the terminal asking for copy it never wrote, which no catalogue can
 * answer. */
export function chromeText(key, { messages, locale } = {}) {
  if (!Object.hasOwn(CHROME, key)) throw new Error(`no chrome copy named "${key}"`);
  return messages?.[locale]?.[key] ?? CHROME[key];
}
