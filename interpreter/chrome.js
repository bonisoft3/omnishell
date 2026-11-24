// The terminal's own chrome: the words it says in its own voice, outside any
// screen's markup — the login gate, and the control that ends a session — and
// the two things it draws around a screen, the nav strip and the document's
// head. They live here rather than in fragment.js because that leaf is the data
// plane's grammar and this is the page, and here rather than in shell.js
// because a page is drawn in more than one place: the shell draws it live, and
// a document rendered anywhere a DOM exists (document.js) draws the same one
// before any script runs. Nothing here reads an ambient document or location:
// check-i18n grades an app against the copy without a DOM, and a server draws
// many documents in one process.
//
// An app carrying catalogues answers these keys like any other, and check-i18n
// makes a missing one an error. The strings below are what the terminal says
// standalone, and what every app declaring no catalogue at all shows.

import { directionOf, localeTable, requiredParams, routeHref, routeParams } from "./fragment.js";

// The gate's copy, reachable only where the app requires a sign-in.
const LOGIN = {
  chrome_signin_hint: "Face ID, fingerprint or screen lock — no password.",
  chrome_signin_guest: "Continue as guest",
  chrome_signin_failed: "That did not go through. Try again.",
};

// The nav's, drawn wherever a session exists — behind a gate, or as the guest
// every app with a table of its own is handed.
const SESSION = {
  chrome_signout: "sign out",
};

// The ways in, drawn for anyone not signed in as a person wherever the app
// declares auth: the gate's, and the nav's Sign in, which opens one panel —
// "Continue with" each provider, then Passkey. Passkey opens onto the
// accounts this device signed in with, and one field: the browser's own
// autofill offers every passkey it holds for the site, and a new name makes
// one. A guest is "Guest" to itself, signed in on this device; its panel
// keeps its work the same ways and ends in a quiet Sign out, which no sign-in
// brings back; its sign-in into another account offers that account or the
// guest. A person's chip opens onto their page, Rename, their ways to sign
// in — Remove beside each while another stays, Add a way below, Set up
// recovery above when asked — and Sign out. Nobody
// sees their own handle's suffix or a guest's generated name: those are for
// others.
const SIGNIN = {
  chrome_passkey: "Sign in",
  chrome_signin: "Continue with this device",
  chrome_signin_with: "Continue with",
  chrome_device: "Passkey",
  chrome_close: "Close",
  chrome_guest: "Guest",
  chrome_guest_signout_hint: "Its work can't be recovered",
  chrome_passkey_failed: "Sign-in did not go through",
  chrome_taken: "Already an account",
  chrome_switch: "Switch to it",
  chrome_stay: "Stay here",
  chrome_name_title: "What should we call you?",
  chrome_continue: "Continue",
  chrome_back: "Back",
  chrome_profile: "My page",
  chrome_rename: "Rename",
  chrome_name_label: "Your name",
  chrome_save: "Save",
  chrome_name_taken: "Another account here has that name",
  chrome_keep: "Keep it with",
  chrome_forget: "Forget on this device",
  chrome_this_device: "This device",
  chrome_signed_in_guest: "Signed in as guest",
  chrome_create_passkey: "Create a passkey",
  chrome_delete_account: "Delete account",
  chrome_delete_confirm: "Delete for good",
  chrome_ways: "Ways to sign in",
  chrome_way_add: "Add a way",
  chrome_way_remove: "Remove",
  chrome_way_taken: "That one already signs in to another account.",
  chrome_ways_stale: "Sign in again to change these.",
  chrome_recovery: "Set up recovery",
  chrome_recovery_hint: "Add another way to sign in, so you can get back in if you lose this one.",
  chrome_later: "Not now",
};

// A provider's way in, one sentence per provider the auth service knows
// (auth.providers): the gate's link, and the name the panel's button is read
// by. What the button shows is the provider's own name, which no language
// translates.
const PROVIDERS = {
  chrome_signin_google: "Continue with Google",
  chrome_signin_apple: "Continue with Apple",
  chrome_signin_bluesky: "Continue with Bluesky",
};
const PROVIDER_NAMES = { google: "Google", apple: "Apple", bluesky: "Bluesky" };
/** A provider as the panel names it: its own name, which no language translates. */
export const providerName = (provider) => PROVIDER_NAMES[provider] ?? provider;

/** The key a provider's way in is spoken under. */
export const providerKey = (provider) => `chrome_signin_${provider}`;

// The consent bar's (consent.js), wherever the app asks for consent.
const CONSENT = {
  chrome_consent_title: "Advertising cookies",
  chrome_consent_body: "May we and Google use cookies to measure our ads and show them to people who visited? The app works the same either way.",
  chrome_consent_policy: "Privacy policy",
  chrome_consent_reject: "Reject",
  chrome_consent_accept: "Accept",
  chrome_consent_choices: "Privacy choices",
};

/** Which copy a reader can reach, by the surface that shows it: an app is asked
 * for the group its own declaration puts on screen, never for the rest. */
export const CHROME_KEYS = { login: Object.keys(LOGIN), session: Object.keys(SESSION), signin: Object.keys(SIGNIN), providers: Object.keys(PROVIDERS), consent: Object.keys(CONSENT) };

export const CHROME = { ...LOGIN, ...SESSION, ...SIGNIN, ...PROVIDERS, ...CONSENT };

const SVG_NS = "http://www.w3.org/2000/svg";

/** Named stroke icons available to strip routes (`nav.icon`), modeled as Lucide
 * 24x24 geometry tuples rather than raw SVG strings so `drawStrip` constructs
 * nodes via `createElementNS` under `require-trusted-types-for 'script'` and
 * linkedom SSR alike. `#NavIcon` in `plugins/pronto/schema.cue` is held equal
 * to this key set by `login-design.test.ts`. */
export const CHROME_ICONS = {
  // Navigation & discovery
  home: [["path", { d: "M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" }], ["path", { d: "M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" }]],
  compass: [["circle", { cx: "12", cy: "12", r: "10" }], ["polygon", { points: "16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" }]],
  search: [["circle", { cx: "11", cy: "11", r: "8" }], ["path", { d: "m21 21-4.3-4.3" }]],
  sparkles: [["path", { d: "M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" }], ["path", { d: "M20 3v4" }], ["path", { d: "M22 5h-4" }]],
  globe: [["circle", { cx: "12", cy: "12", r: "10" }], ["path", { d: "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" }], ["path", { d: "M2 12h20" }]],
  "map-pin": [["path", { d: "M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" }], ["circle", { cx: "12", cy: "10", r: "3" }]],
  // Views, boards & grids
  "layout-grid": [["rect", { width: "7", height: "7", x: "3", y: "3", rx: "1" }], ["rect", { width: "7", height: "7", x: "14", y: "3", rx: "1" }], ["rect", { width: "7", height: "7", x: "14", y: "14", rx: "1" }], ["rect", { width: "7", height: "7", x: "3", y: "14", rx: "1" }]],
  "grid-3x3": [["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }], ["path", { d: "M3 9h18" }], ["path", { d: "M3 15h18" }], ["path", { d: "M9 3v18" }], ["path", { d: "M15 3v18" }]],
  list: [["path", { d: "M8 6h13" }], ["path", { d: "M8 12h13" }], ["path", { d: "M8 18h13" }], ["path", { d: "M3 6h.01" }], ["path", { d: "M3 12h.01" }], ["path", { d: "M3 18h.01" }]],
  kanban: [["path", { d: "M6 5v11" }], ["path", { d: "M12 5v6" }], ["path", { d: "M18 5v14" }]],
  layers: [["path", { d: "m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" }], ["path", { d: "m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" }], ["path", { d: "m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" }]],
  table: [["path", { d: "M12 3v18" }], ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }], ["path", { d: "M3 9h18" }], ["path", { d: "M3 15h18" }]],
  // Time & planning
  calendar: [["path", { d: "M8 2v4" }], ["path", { d: "M16 2v4" }], ["rect", { width: "18", height: "18", x: "3", y: "4", rx: "2" }], ["path", { d: "M3 10h18" }]],
  clock: [["circle", { cx: "12", cy: "12", r: "10" }], ["polyline", { points: "12 6 12 12 16 14" }]],
  history: [["path", { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" }], ["path", { d: "M3 3v5h5" }], ["path", { d: "M12 7v5l4 2" }]],
  // Analytics & finance
  "chart-bar": [["path", { d: "M12 20V10" }], ["path", { d: "M18 20V4" }], ["path", { d: "M6 20v-6" }]],
  "chart-line": [["path", { d: "M3 3v16a2 2 0 0 0 2 2h16" }], ["path", { d: "m19 9-5 5-4-4-3 3" }]],
  "chart-pie": [["path", { d: "M21 12c.552 0 1.005-.449.95-.998a10 10 0 0 0-8.953-8.951c-.55-.055-.998.398-.998.95v8a1 1 0 0 0 1 1z" }], ["path", { d: "M21.21 15.89A10 10 0 1 1 8 2.83" }]],
  "trending-up": [["polyline", { points: "22 7 13.5 15.5 8.5 10.5 2 17" }], ["polyline", { points: "16 7 22 7 22 13" }]],
  wallet: [["path", { d: "M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" }], ["path", { d: "M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" }]],
  "credit-card": [["rect", { width: "20", height: "14", x: "2", y: "5", rx: "2" }], ["line", { x1: "2", x2: "22", y1: "10", y2: "10" }]],
  receipt: [["path", { d: "M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" }], ["path", { d: "M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" }], ["path", { d: "M12 17.5v-11" }]],
  "shopping-bag": [["path", { d: "M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z" }], ["path", { d: "M3 6h18" }], ["path", { d: "M16 10a4 4 0 0 1-8 0" }]],
  // Reading, docs & knowledge
  "book-open": [["path", { d: "M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" }], ["path", { d: "M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" }]],
  "file-text": [["path", { d: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" }], ["path", { d: "M14 2v4a2 2 0 0 0 2 2h4" }], ["path", { d: "M10 9H8" }], ["path", { d: "M16 13H8" }], ["path", { d: "M16 17H8" }]],
  newspaper: [["path", { d: "M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2" }], ["path", { d: "M18 14h-8" }], ["path", { d: "M15 18h-5" }], ["path", { d: "M10 6h8v4h-8V6Z" }]],
  scroll: [["path", { d: "M8 21h12a2 2 0 0 0 2-2v-2H10v2a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v3h4" }], ["path", { d: "M19 17V5a2 2 0 0 0-2-2H4" }]],
  "circle-help": [["circle", { cx: "12", cy: "12", r: "10" }], ["path", { d: "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" }], ["path", { d: "M12 17h.01" }]],
  info: [["circle", { cx: "12", cy: "12", r: "10" }], ["path", { d: "M12 16v-4" }], ["path", { d: "M12 8h.01" }]],
  bookmark: [["path", { d: "m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" }]],
  tag: [["path", { d: "M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" }], ["circle", { cx: "7.5", cy: "7.5", r: ".5", fill: "currentColor" }]],
  folder: [["path", { d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" }]],
  // People, social & communication
  "message-square": [["path", { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" }]],
  mail: [["rect", { width: "20", height: "16", x: "2", y: "4", rx: "2" }], ["path", { d: "m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" }]],
  inbox: [["polyline", { points: "22 12 16 12 14 15 10 15 8 12 2 12" }], ["path", { d: "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" }]],
  bell: [["path", { d: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" }], ["path", { d: "M10.3 21a1.94 1.94 0 0 0 3.4 0" }]],
  users: [["path", { d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" }], ["circle", { cx: "9", cy: "7", r: "4" }], ["path", { d: "M22 21v-2a4 4 0 0 0-3-3.87" }], ["path", { d: "M16 3.13a4 4 0 0 1 0 7.75" }]],
  user: [["path", { d: "M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" }], ["circle", { cx: "12", cy: "7", r: "4" }]],
  heart: [["path", { d: "M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" }]],
  share: [["circle", { cx: "18", cy: "5", r: "3" }], ["circle", { cx: "6", cy: "12", r: "3" }], ["circle", { cx: "18", cy: "19", r: "3" }], ["line", { x1: "8.59", x2: "15.42", y1: "13.51", y2: "17.49" }], ["line", { x1: "15.41", x2: "8.59", y1: "6.51", y2: "10.49" }]],
  // Games, media & activity
  gamepad: [["line", { x1: "6", x2: "10", y1: "12", y2: "12" }], ["line", { x1: "8", x2: "8", y1: "10", y2: "14" }], ["line", { x1: "15", x2: "15.01", y1: "13", y2: "13" }], ["line", { x1: "18", x2: "18.01", y1: "11", y2: "11" }], ["rect", { width: "20", height: "12", x: "2", y: "6", rx: "2" }]],
  trophy: [["path", { d: "M6 9H4.5a2.5 2.5 0 0 1 0-5H6" }], ["path", { d: "M18 9h1.5a2.5 2.5 0 0 0 0-5H18" }], ["path", { d: "M4 22h16" }], ["path", { d: "M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" }], ["path", { d: "M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" }], ["path", { d: "M18 2H6v7a6 6 0 0 0 12 0V2Z" }]],
  award: [["path", { d: "m15.477 12.89 1.515 8.526a.5.5 0 0 1-.81.47l-3.58-2.687a1 1 0 0 0-1.197 0l-3.586 2.686a.5.5 0 0 1-.81-.469l1.514-8.526" }], ["circle", { cx: "12", cy: "8", r: "6" }]],
  flame: [["path", { d: "M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" }]],
  zap: [["path", { d: "M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" }]],
  play: [["polygon", { points: "6 3 20 12 6 21 6 3" }]],
  music: [["path", { d: "M9 18V5l12-2v13" }], ["circle", { cx: "6", cy: "18", r: "3" }], ["circle", { cx: "18", cy: "16", r: "3" }]],
  image: [["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", ry: "2" }], ["circle", { cx: "9", cy: "9", r: "2" }], ["path", { d: "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" }]],
  // Actions, status & developer
  "plus-circle": [["circle", { cx: "12", cy: "12", r: "10" }], ["path", { d: "M8 12h8" }], ["path", { d: "M12 8v8" }]],
  "check-circle": [["circle", { cx: "12", cy: "12", r: "10" }], ["path", { d: "m9 12 2 2 4-4" }]],
  sliders: [["line", { x1: "4", x2: "4", y1: "21", y2: "14" }], ["line", { x1: "4", x2: "4", y1: "10", y2: "3" }], ["line", { x1: "12", x2: "12", y1: "21", y2: "12" }], ["line", { x1: "12", x2: "12", y1: "8", y2: "3" }], ["line", { x1: "20", x2: "20", y1: "21", y2: "16" }], ["line", { x1: "20", x2: "20", y1: "12", y2: "3" }], ["line", { x1: "2", x2: "6", y1: "14", y2: "14" }], ["line", { x1: "10", x2: "14", y1: "8", y2: "8" }], ["line", { x1: "18", x2: "22", y1: "16", y2: "16" }]],
  settings: [["path", { d: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" }], ["circle", { cx: "12", cy: "12", r: "3" }]],
  shield: [["path", { d: "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" }]],
  code: [["polyline", { points: "16 18 22 12 16 6" }], ["polyline", { points: "8 6 2 12 8 18" }]],
  terminal: [["polyline", { points: "4 17 10 11 4 5" }], ["line", { x1: "12", x2: "20", y1: "19", y2: "19" }]],
};

export function drawIcon(doc, name) {
  if (!name || !Object.hasOwn(CHROME_ICONS, name)) return null;
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "shell-nav-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.85");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const [tag, attrs] of CHROME_ICONS[name]) {
    const shape = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) shape.setAttribute(k, v);
    svg.append(shape);
  }
  return svg;
}

function fillNavLink(doc, a, item) {
  const icon = drawIcon(doc, item?.icon);
  if (icon) {
    a.setAttribute("data-icon", item.icon);
    const label = doc.createElement("span");
    label.className = "shell-nav-label";
    label.textContent = item.label;
    a.append(icon, label);
    if (item.display === "icon-only") {
      a.setAttribute("data-display", "icon-only");
      a.setAttribute("aria-label", item.label);
      a.setAttribute("title", item.label);
    }
  } else {
    a.textContent = item?.label ?? "";
  }
}

/** Where a provider's sign-in starts: a navigation, not a fetch, since the
 * provider's own pages take the reader and the auth service brings them back
 * to `here` (mecha's services/auth/README.md#provider-sign-in). */
export function providerHref(service, provider, here) {
  return `${service}/oidc/${encodeURIComponent(provider)}/start?return=${encodeURIComponent(here)}`;
}

/** Whether the nav offers a guest a way in: wherever the app declares auth. */
export const offersSignin = (cfg) => cfg.auth !== undefined;

/** What the chrome says, in the language the page is in. A key no group holds
 * is the terminal asking for copy it never wrote, which no catalogue can
 * answer. */
export function chromeText(key, { messages, locale } = {}) {
  if (!Object.hasOwn(CHROME, key)) throw new Error(`no chrome copy named "${key}"`);
  return messages?.[locale]?.[key] ?? CHROME[key];
}

/** The routes the strip links. A route with a required param has no static
 * href; it is reached from rows. A route may also take itself off the strip,
 * when it is reached from somewhere more specific than "everywhere". */
export function stripRoutes(cfg) {
  return cfg.routes.filter((r) => requiredParams(r.path).length === 0 && r.nav.strip !== false);
}

/** Whether a page carries a strip: one link is no choice, but a person is
 * always someone the reader should see. A guest the app offers no sign-in to
 * is not one: there is nothing to gain, and signing out only mints another.
 * `session` is the restored one; `mintedGuest`, one minted on first write. */
export function hasStrip(cfg, session, mintedGuest = false) {
  const guest = session ? Boolean(session.user?.guest) : mintedGuest;
  const person = guest ? offersSignin(cfg) : Boolean(session);
  return stripRoutes(cfg).length > 1 || person || Boolean(cfg.brand?.label);
}

/** The strip, before any locale is resolved. Its addresses change with the
 * one the reader is in, so it names routes, and localizeStrip writes the hrefs
 * on every navigation. */
export function drawStrip(doc, cfg) {
  const nav = doc.createElement("nav");
  if (cfg.brand?.label) {
    const brand = doc.createElement("span");
    brand.className = "shell-brand";
    brand.textContent = cfg.brand.label;
    nav.append(brand);
  }
  for (const r of stripRoutes(cfg)) {
    const a = doc.createElement("a");
    a.setAttribute("data-route", r.screen);
    fillNavLink(doc, a, r.nav);
    nav.append(a);
    // A route's other entries are its own addresses, one per set of params
    // (nav.entries): the shelves of a library. Each is a link like any other,
    // current when its address is the page's, so the strip never has to be
    // told which one a gesture meant.
    for (const [i, entry] of (r.nav.entries ?? []).entries()) {
      const link = doc.createElement("a");
      link.setAttribute("data-route", r.screen);
      link.setAttribute("data-entry", String(i));
      for (const [name, value] of Object.entries(entry.params ?? {})) link.setAttribute(`data-param-${name}`, value);
      fillNavLink(doc, link, entry);
      nav.append(link);
    }
  }
  return nav;
}

export const supportsPasskeys = () =>
  typeof globalThis.window !== "undefined" &&
  Boolean(globalThis.PublicKeyCredential) &&
  globalThis.window.isSecureContext !== false;

/** The name a handle carries, as its own person reads it: the words its `-`
 * joins for addresses, without the four hex digits that keep it apart for
 * others (`lemon-manatee-8048` is "lemon manatee"). */
export const nameOf = (handle) => (handle ?? "").replace(/-[0-9a-f]{4}$/, "").replaceAll("-", " ");

function stroke(doc, cls, shapes) {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", cls);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const [tag, attrs] of shapes) {
    const shape = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) shape.setAttribute(k, v);
    svg.append(shape);
  }
  return svg;
}

export const worded = (doc, tag, cls, key) => {
  const el = doc.createElement(tag);
  if (cls) el.className = cls;
  el.setAttribute("data-key", key);
  return el;
};

/** The nav's end for anyone not signed in as a person (offersSignin): a
 * control that opens one panel in place — never over the page. For a visitor
 * it is Sign in; for a guest it is "Guest", on this device, with an open
 * lock, and the panel is about keeping its work. Passkey is a
 * `data-auth-action` control, so one handler opens its accounts; it starts
 * hidden, shown where the browser has passkeys. Words and the providers'
 * addresses are the nav's to write in the page's language (localizeStrip),
 * each `data-key` saying which word. */
export function signinBox(doc, cfg, guest = null) {
  const box = doc.createElement("span");
  box.className = "shell-me";
  const open = doc.createElement("button");
  open.setAttribute("type", "button");
  open.className = "shell-signin";
  open.setAttribute("aria-expanded", "false");
  open.setAttribute("aria-controls", "shell-signin-panel");
  if (guest === null) {
    open.setAttribute("data-key", "chrome_passkey");
    // With no provider the device is the only way in, and only the browser
    // knows whether it can ask the device alone (renderSignin).
    if ((cfg.auth.providers ?? []).length === 0) open.setAttribute("hidden", "");
  } else {
    open.classList.add("shell-guest");
    const mark = doc.createElement("span");
    mark.className = "shell-avatar";
    mark.setAttribute("aria-hidden", "true");
    mark.append(stroke(doc, "shell-guest-icon", [["circle", { cx: "12", cy: "8", r: "4" }], ["path", { d: "M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" }]]));
    chip(doc, open, mark, worded(doc, "span", "handle", "chrome_guest"), worded(doc, "span", "shell-chip-label", "chrome_this_device"), false);
  }
  const panel = doc.createElement("div");
  panel.className = "shell-signin-panel";
  panel.id = "shell-signin-panel";
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-labelledby", "shell-signin-title");
  panel.setAttribute("hidden", "");
  const head = doc.createElement("div");
  head.className = "shell-signin-head";
  const title = worded(doc, "strong", "shell-signin-title", guest === null ? "chrome_passkey" : "chrome_signed_in_guest");
  title.id = "shell-signin-title";
  const close = doc.createElement("button");
  close.setAttribute("type", "button");
  close.className = "shell-signin-close";
  close.setAttribute("data-label-key", "chrome_close");
  close.append(stroke(doc, "shell-close-icon", [["path", { d: "M6 6l12 12M18 6L6 18" }]]));
  head.append(title, close);
  const ways = doc.createElement("div");
  ways.className = "shell-signin-ways";
  for (const provider of cfg.auth.providers ?? []) {
    const a = doc.createElement("a");
    a.className = "shell-provider";
    a.setAttribute("data-provider", provider);
    a.setAttribute("data-label-key", providerKey(provider));
    const mark = doc.createElement("span");
    mark.className = "shell-provider-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = (PROVIDER_NAMES[provider] ?? provider)[0].toUpperCase();
    const name = doc.createElement("span");
    name.textContent = PROVIDER_NAMES[provider] ?? provider;
    a.append(mark, name);
    ways.append(a);
  }
  const device = doc.createElement("button");
  device.setAttribute("type", "button");
  device.className = "shell-passkey";
  device.setAttribute("data-auth-action", "accounts");
  device.setAttribute("hidden", "");
  device.append(passkeyIcon(doc), worded(doc, "span", "", "chrome_device"));
  ways.append(device);
  panel.append(head, worded(doc, "p", "shell-signin-with", guest === null ? "chrome_signin_with" : "chrome_keep"), ways);
  if (guest !== null) {
    const out = worded(doc, "button", "shell-guest-signout", "chrome_signout");
    out.setAttribute("type", "button");
    out.setAttribute("data-auth-action", "signout");
    out.setAttribute("data-title-key", "chrome_guest_signout_hint");
    panel.append(out);
  }
  box.append(open, panel);
  return box;
}

/** A person's name as they see it: the name alone, never the suffix that
 * keeps their handle apart for others. */
export function ownName(doc, handle, name = nameOf(handle)) {
  const shown = doc.createElement("span");
  shown.className = "handle";
  shown.textContent = name;
  return shown;
}

/** The passkey mark: a person and a key. */
export const passkeyIcon = (doc) => stroke(doc, "shell-passkey-icon", [
  ["circle", { cx: "9", cy: "7.5", r: "3.5" }], ["path", { d: "M2.5 20c0-3.6 2.9-6.5 6.5-6.5 1.3 0 2.5.4 3.5 1" }],
  ["circle", { cx: "17.5", cy: "13.5", r: "2.5" }], ["path", { d: "M17.5 16v5M17.5 19h2" }],
]);

/** The one this device is, on the control that opens its panel: a mark, the
 * name, a word under it, and a lock — open for a guest, whose work nothing
 * keeps, closed for a person. */
function chip(doc, open, mark, name, label, locked) {
  const who = doc.createElement("span");
  who.className = "shell-chip-who";
  who.append(name, label);
  open.append(mark, who, stroke(doc, "shell-lock", [
    ["rect", { x: "4", y: "11", width: "16", height: "10", rx: "2" }],
    ["path", { d: locked ? "M8 11V7a4 4 0 0 1 8 0v4" : "M8 11V7a4 4 0 0 1 7.6-1.7" }],
  ]));
}

function renameItem(doc) {
  const rename = doc.createElement("button");
  rename.setAttribute("type", "button");
  rename.className = "shell-rename";
  rename.setAttribute("data-auth-action", "rename");
  rename.append(worded(doc, "span", "", "chrome_rename"));
  return rename;
}

/** A person's end of the nav: their chip, opening the account's panel in
 * place — their page where the app has one, Rename, and Sign out, after which
 * the account is still among Passkey's. `label` is the word under the name:
 * the address a provider vouched for, or the copy key of how they signed in. */
export function accountBox(doc, cfg, user, label) {
  const box = doc.createElement("span");
  box.className = "shell-me";
  const open = doc.createElement("button");
  open.setAttribute("type", "button");
  open.className = "shell-person";
  open.setAttribute("aria-expanded", "false");
  open.setAttribute("aria-controls", "shell-account-panel");
  const word = label.key === undefined ? doc.createElement("span") : worded(doc, "span", "", label.key);
  word.classList.add("shell-chip-label");
  if (label.text !== undefined) word.textContent = label.text;
  const name = nameOf(user.handle);
  const mark = doc.createElement("span");
  mark.className = "shell-avatar";
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = [...name][0]?.toLocaleUpperCase() ?? "";
  chip(doc, open, mark, ownName(doc, user.handle), word, true);
  const panel = doc.createElement("div");
  panel.className = "shell-signin-panel shell-account";
  panel.id = "shell-account-panel";
  panel.setAttribute("role", "group");
  panel.setAttribute("hidden", "");
  const self = cfg.auth?.self;
  if (self !== undefined) {
    const route = cfg.routes.find((r) => r.screen === self.route);
    if (route === undefined) throw new Error(`auth.self names "${self.route}", which is no route of this app`);
    // The person is fixed for the session; only the locale of their address
    // moves, so the strip's own pass composes the href (localizeStrip).
    const page = worded(doc, "a", "shell-account-page", "chrome_profile");
    page.setAttribute("data-route", self.route);
    for (const [, name] of route.path.matchAll(/:(\w+)/g)) page.setAttribute(`data-param-${name}`, user[name]);
    panel.append(page);
  }
  const out = doc.createElement("button");
  out.setAttribute("type", "button");
  out.className = "shell-signout";
  out.setAttribute("data-auth-action", "signout");
  out.append(worded(doc, "span", "", "chrome_signout"));
  // Deleting is for good, so the first press only asks (data-confirm) and the
  // panel closing takes the question back.
  const drop = doc.createElement("button");
  drop.setAttribute("type", "button");
  drop.className = "shell-delete";
  drop.setAttribute("data-auth-action", "delete-account");
  drop.append(worded(doc, "span", "shell-delete-ask", "chrome_delete_account"), worded(doc, "span", "shell-delete-confirm", "chrome_delete_confirm"));
  panel.append(renameItem(doc), out, drop);
  box.append(open, panel);
  return box;
}

/** The strip's addresses, its words and its state, all re-derived per
 * navigation: an href carries the locale of the page it is on, so does a
 * label, and aria-current names the link that IS this page — which is the
 * link whose address is this one (`here`, a pathname), not merely a link to
 * the same route with someone else's :params.
 * @param {Element | null | undefined} nav
 * @param {any} cfg
 * @param {{ locale?: string, here?: string, search?: string, messages?: Record<string, Record<string, string>>, explicitLocale?: boolean }} [options] */
export function localizeStrip(nav, cfg, { locale, here, search = "", messages, explicitLocale = false } = {}) {
  if (!nav) return;
  for (const a of nav.querySelectorAll("a[data-route]")) {
    const href = routeHref(cfg, a.getAttribute("data-route"), routeParams(a), locale, { explicitLocale, fragment: a.dataset.routeFragment });
    if (href === undefined) a.removeAttribute("href");
    else a.setAttribute("href", href);
    if (href !== undefined && (a.getAttribute("href") === here || new URL(href, "https://shell.local").pathname === here)) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  const brand = nav.querySelector(":scope > .shell-brand");
  if (brand && cfg.brand?.label !== undefined) {
    brand.textContent = cfg.brand.key !== undefined
      ? (messages?.[locale]?.[cfg.brand.key] ?? messages?.[cfg.i18n?.default]?.[cfg.brand.key] ?? cfg.brand.label)
      : cfg.brand.label;
  }
  // The strip's own links, and not the account's: its page is worded by its
  // data-key below.
  for (const a of nav.querySelectorAll(":scope > a[data-route]")) {
    // Re-apply even when `key` is absent so a served strip adopted from a
    // cached document picks up renamed default-language labels in `shell.yaml`.
    const routeNav = cfg.routes.find((r) => r.screen === a.getAttribute("data-route"))?.nav;
    const entry = a.getAttribute("data-entry");
    const { key, label } = (entry === null ? routeNav : routeNav?.entries?.[Number(entry)]) ?? {};
    if (key === undefined && label === undefined) continue;
    const word = key !== undefined
      ? (messages?.[locale]?.[key] ?? messages?.[cfg.i18n?.default]?.[key] ?? label)
      : label;
    const labelEl = a.querySelector(":scope > .shell-nav-label") ?? a;
    labelEl.textContent = word;
    if (a.getAttribute("data-display") === "icon-only") {
      a.setAttribute("aria-label", word);
      a.setAttribute("title", word);
    }
  }
  for (const el of nav.querySelectorAll(".shell-me [data-key]")) {
    el.textContent = chromeText(el.getAttribute("data-key"), { messages, locale });
  }
  for (const el of nav.querySelectorAll(".shell-me [data-label-key]")) {
    el.setAttribute("aria-label", chromeText(el.getAttribute("data-label-key"), { messages, locale }));
  }
  for (const el of nav.querySelectorAll(".shell-me [data-title-key]")) {
    el.setAttribute("title", chromeText(el.getAttribute("data-title-key"), { messages, locale }));
  }
  // The provider brings the reader back to the page they left, in its language.
  for (const a of nav.querySelectorAll(".shell-provider")) {
    if (here !== undefined) a.setAttribute("href", providerHref(cfg.auth?.service, a.getAttribute("data-provider"), here + search));
  }
}

/** What a document says it IS. One entry file answers at every address, so its
 * head names no screen and no language of its own: until this runs, every
 * route of every locale is the entry's language, titled with the app. A screen
 * reader takes the document's language from that attribute, and a crawler has
 * no other source for the title or for the fact that three addresses are one
 * page in three languages.
 *
 * `el` is the rendered screen, whose h1 names it; `origin` is spelled ahead of
 * every link, which is what makes them absolute: the origin the reader arrived
 * at, so nothing here has to be told where the app is deployed, or what stands
 * for it in a document rendered before any request. */
export function describe(doc, cfg, { route, params, locale, written, el, origin }) {
  // The language RENDERED, which is what a screen reader has to pronounce,
  // and which way its script runs, which is what the nav strip, the
  // scrollbar and every unstyled box take their side from. It is the
  // address's own everywhere but a plain route carrying `?lang=`, which
  // names a language without naming an address. An app that declares no
  // locales resolves none and makes no claim: the entry document's own
  // attributes stand rather than being overwritten with `undefined`.
  if (locale !== undefined) {
    doc.documentElement.setAttribute("lang", locale);
    doc.documentElement.setAttribute("dir", directionOf(locale));
  }
  // A screen's h1 names it; a screen without one — the home screen — is
  // the app itself.
  const name = el.querySelector("h1")?.textContent?.trim();
  let title = doc.querySelector("title");
  if (title === null) {
    title = doc.createElement("title");
    doc.head.append(title);
  }
  title.textContent = name ? `${name} — ${cfg.app}` : cfg.app;

  for (const old of doc.head.querySelectorAll('link[rel="canonical"], link[rel="alternate"][hreflang]')) {
    old.remove();
  }
  const link = (rel, href, hreflang) => {
    const node = doc.createElement("link");
    node.setAttribute("rel", rel);
    // Every href composed here is root-relative and already encoded
    // (routeHref).
    node.setAttribute("href", `${origin}${href}`);
    if (hreflang !== undefined) node.setAttribute("hreflang", hreflang);
    doc.head.append(node);
  };
  // The language the ADDRESS is written in, never the rendered one. The
  // two part only on a plain route carrying `?lang=`, which is the case
  // that would otherwise make a canonical vary per reader — and a
  // canonical two readers of one URL disagree about is the one thing a
  // canonical exists not to be.
  const here = routeHref(cfg, route.screen, params, written);
  // A route whose param carries nothing has no address, so this document
  // has none to name — and none in any other locale either, since the
  // param is the same in all of them.
  if (here === undefined) return;
  link("canonical", here);
  if (cfg.i18n === undefined) return;
  for (const tag of Object.keys(localeTable(cfg.i18n))) {
    link("alternate", routeHref(cfg, route.screen, params, tag), tag);
  }
  // x-default names the default locale's unprefixed address: where a
  // crawler is told to send a reader whose language matches no alternate.
  link("alternate", routeHref(cfg, route.screen, params, cfg.i18n.default), "x-default");
}
