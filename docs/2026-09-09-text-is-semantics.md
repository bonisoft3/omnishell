# Text is semantics

The ground: [`2026-07-30-the-binding-vocabulary.md`](2026-07-30-the-binding-vocabulary.md)
(any attribute may carry `{field}`; a screen is interpreted, not compiled),
[`2026-08-31-the-session-is-a-value.md`](2026-08-31-the-session-is-a-value.md)
(the session is a row in `tab` or `device`),
[`2026-09-01-aria-is-columns.md`](2026-09-01-aria-is-columns.md)
(one vocabulary serves three readers: the human, the screen reader, and the test runner),
[`2026-09-03-the-reader-is-also-a-writer.md`](2026-09-03-the-reader-is-also-a-writer.md)
(reader navigation expresses intent),
and [`../interpreter/jessie.js`](../interpreter/jessie.js)
(SES compartments running pure, deterministic modules).

The claim: **text is semantics, not presentation. Translated strings must live as
the actual text content of DOM nodes—never as CSS generated content—so that all three
readers observe the exact same state. The binding vocabulary admits static localization by
introducing the reserved `{msg.key}` prefix into `lookup()` without adding a single
new HTML attribute. For dynamic content, the route is the atomic unit of intent: accessing
a route (or pre-fetching it via `<a href="..." data-prefetch>`) executes the route's
declared reads under the active `session.locale`. The backend automatically enqueues
translations for untranslated entities contained in that route. The client never micromanages
item-level translation requests.**

## Facts not to re-derive

Read out of the DOM specifications and measured in browsers on 2026-09-09.

- **CSS text replacement breaks three readers at once.** Hiding DOM text and painting
  translations via CSS `content: "..."` (scoped to `html[lang="..."]`) fails
  immediately:
  - *The screen reader*: The accessibility tree is built from DOM text nodes. A blind
    user on VoiceOver/NVDA hears the original English string, or hears nothing if hidden
    via `display: none`. Accessible attributes (`aria-label`, `aria-description`) cannot
    be styled or replaced by CSS.
  - *The human user*: Text rendered via CSS `content` cannot be selected or copied to the
    clipboard. Browser in-page search (`Cmd+F` / `Ctrl+F`) fails completely: searching
    for `"Salvar"` yields zero matches.
  - *The test runner*: Playwright queries (`page.getByRole('button', { name: 'Salvar' })`)
    match the accessibility tree and text nodes, not CSS pseudo-elements.
  - *Form controls*: CSS cannot replace `<input placeholder="...">`, `<option>` labels,
    or submit values.
- **The rule that makes the binding list short already handles this.**
  `2026-07-30-the-binding-vocabulary.md:19`: "Any attribute may carry `{field}`, and the
  binder resolves it against the row." Route parameters were admitted without inventing
  a new attribute by introducing the `{param.x}` prefix (`screen.js:295`). Static
  message keys need no `data-t` or `data-msg-attr` attributes; they are another prefix
  in the same expression evaluator.
- **The route is the unit of intent.** In Pronto and Omnishell, `#Screen` defines the
  boundary of what is read and displayed (`#Screen.route` and `#Screen.reads`). An app
  does not ask for "item 42 translation" via bespoke client hooks; it navigates to
  (or pre-fetches) `#/items/42`. Executing the route's reads under `session.locale` is
  the sole declaration of demand.
- **`Intl` is the interpreter's, not a cage's.** SES Compartments remove ambient,
  non-deterministic globals (`Date.now()`, `Math.random()`, `window`, `fetch`), and
  `Intl` goes with them: `typeof Intl` inside `evaluateCaged` is `undefined`, so a
  handler, renderer, validation or fold can reach none of `Intl.NumberFormat`,
  `Intl.DateTimeFormat`, `Intl.PluralRules`, `Intl.RelativeTimeFormat` or
  `Intl.DisplayNames`. plv8 has none either. That is why locale-aware FORMATTING is
  the terminal's: `formatDatetime` and the message arms behind `data-msg-plural`
  resolve in `screen.js`, where `Intl` is endowed.

## The `{msg.key}` Binding Vocabulary

In [`../interpreter/screen.js`](../interpreter/screen.js),
`lookup(expr, ctx)` resolves three namespaces:

```javascript
function lookup(expr, { row, params, messages, locale }) {
  if (expr.startsWith("param.")) {
    return params[expr.slice("param.".length)];
  }
  if (expr.startsWith("msg.")) {
    const key = expr.slice("msg.".length);
    const pattern = messages?.[key] ?? key;
    return formatMessage(pattern, row, locale);
  }
  // Standard dot-path into row...
}
```

Because Omnishell already interpolates `{field}` across all attributes, `{msg.key}` works
everywhere with zero new vocabulary:

```html
<button type="submit" data-text="{msg.save_info}">Save Info</button>

<input type="text"
       placeholder="{msg.search_placeholder}"
       aria-label="{msg.search_label}">

<div data-live="items" data-empty="{msg.no_items_yet}">
  ...
</div>

<span data-text="{msg.photos_count}">3 photos</span>
```

## Route-Level Localization & Pre-fetching

In Omnishell, translation of dynamic data is **route-driven**, never item-driven. The client
contains no item-level translation tracking, no `requestedRef` sets, and no ad-hoc
`POST /api/translate` calls.

### 1. Route Access as Demand
When the user navigates to a screen (e.g. `#/items/42`):
- Omnishell executes the screen's declared `#Screen.reads` against PostgREST, passing the
  current `session.locale` in the `Accept-Language` / `x-locale` request header.
- The server serves the localized view: `coalesce(translations.caption, caption)`.
- If the Spanish translation is missing, the server yields the original text immediately
  (zero blocking latency) and **the server itself enqueues the translation in the CDC path**.
- The client receives and binds the row normally. When the background CDC translation
  finishes, the live query pushes the updated row, and Omnishell re-binds reactively.

### 2. Route Pre-fetching (`data-prefetch`)
Pre-fetching uses the standard web pattern—on navigation links:
```html
<a href="#/items/{id}" data-prefetch>
  <span data-text="{caption}"></span>
</a>
```
When a link carrying `data-prefetch` enters the viewport (via `IntersectionObserver`) or
receives pointer hover/focus:
1. Omnishell pre-fetches the target route's `#Screen.reads` in the background with
   `session.locale`.
2. This read query triggers the backend's translation enqueue for the content of that
   target route.
3. By the time the user clicks the link and the navigation transition completes, the
   translated row is already warm in the database and client collection cache.

## Vendored ICU MessageFormat Runtime

Omnishell vendors `@formatjs/intl-messageformat` (~5KB minified, zero dependencies) in
[`../interpreter/vendor/`](../interpreter/vendor/)
beside `ses.umd.min.js` and `js-yaml.js`.

When a message contains standard ICU syntax:
```json
{
  "unread_count": "{count, plural, one {You have # unread message} other {You have # unread messages}}"
}
```
`formatMessage` parses the pattern once, caches the AST, and formats against the bound
`row` values using the active `locale`. CLDR plural categories (`zero`, `one`, `two`,
`few`, `many`, `other`) evaluate natively via `Intl.PluralRules`.

## Built-in Value Formats (`data-text-format`)

Standard, locale-aware `Intl` formatters replace hardcoded formatting in `screen.js`:

| Format | Markup Example | Output (`en-US`) | Output (`pt-BR`) |
|---|---|---|---|
| `datetime` | `data-text-format="datetime"` | Aug 2, 09:00 | 2 de ago., 09:00 |
| `date` | `data-text-format="date"` | Aug 2, 2026 | 02/08/2026 |
| `time` | `data-text-format="time"` | 09:00 | 09:00 |
| `number` | `data-text-format="number"` | 1,234.5 | 1.234,5 |
| `money` | `data-text-format="money"` | R$1,204 | R$ 1.204 |
| `relative-time` | `data-text-format="relative-time"` | 3 minutes ago | há 3 minutos |

Formatters are cached per `(locale, format, options)` tuple; re-binding a 500-row table
incurs zero formatter allocation overhead.

`number` and `money` shipped; `date`, `time` and `relative-time` are still proposals.

The `currency:<col>` spelling this proposed is NOT what landed, and the argument
against it is the one this document makes everywhere else: a colon is a second
grammar inside an attribute value, carrying a fact the column already states. The
currency code and the minor-unit scale ride the column instead
(`schema.cue #Field.money`), which is one declaration, beside the `cel` and the
bounds governing the same value, and reachable by `check-markup` out of the emitted
`schema:` — so every `money` binding is graded before a screen is mounted. The column
stays an `int`: a currency is not a type, it is what an integer counts, and the scale
is not guessable (xpense stores whole reais where the convention is cents).

## Jessie as the Custom Linguistic Compute Plane

When an app needs domain-specific formatting (e.g. parsing raw text into numbered step
lists, localized classification badges, or grammatical gender selection), the app declares
a Jessie renderer in `files.renderers`:

```javascript
// files/renderers/disposal-steps.js (pure Jessie)
(rawText) => {
  const steps = String(rawText || "")
    .split(/\n|(?:\d+\.\s)/)
    .map(s => s.trim())
    .filter(Boolean);

  return {
    tag: "ol",
    attrs: { class: "disposal-steps" },
    children: steps.map(step => ({ tag: "li", children: [step] }))
  };
}
```

`Intl.DisplayNames` translates language names or region codes dynamically with zero
lookup tables, and `render.js` guarantees that emitted tags (`ol`, `li`, `span`) and
attributes (`lang`, `dir`) stay strictly within the safe prose allowlist.

## Document Orchestration & RTL

A screen's language is not session state. It is resolved once, by `fragment.js`
`resolveLocale`, from the most explicit thing the arrival carries — the address's locale
prefix, then `?lang=`, then a bound row's own `locale` column, then `Accept-Language`,
then the app's declared default. One order in one function, because four sources
re-derived at three call sites is how a row and a path come to disagree about what
language a screen is in.

Direction comes from the same tag through `fragment.js` `directionOf`, which asks
`Intl.Locale.prototype.getTextInfo()` (or the `textInfo` getter an older WebKit still
ships). There is no list of right-to-left languages in the interpreter: CLDR's answer is
already in the engine, and a hand-kept list is a thing that goes stale silently. An
engine that offers neither spelling throws — assuming `ltr` renders Hebrew backwards and
reports success.

Four surfaces write it, because four surfaces paint:

1. `shell.html` carries `lang` and `dir` as holes the emitter fills from the app's
   declared default (`terminal.cue`, resolved against `#RtlLanguages` because CUE has no
   Intl to ask). This is the paint before boot, and everything a crawler that renders
   nothing ever sees.
2. `prerender.ts` writes both onto each prerendered document, one per route per locale.
3. `shell.js` `describe()` rewrites the live document's pair on every navigation. An app
   that declares no locales resolves none and writes neither.
4. `screen.js` `applyLocale` writes `dir` on the screen root, because a row carrying its
   own `locale` switches one screen and leaves the page around it alone.

Every one of those is graded without a browser: `check-i18n.ts` renders every screen ×
state under two pseudo locales, one per direction, and reports a frame root whose `dir`
disagrees with the tag.

Still pending: `<bdi>` around dynamic user data embedded in static sentences. `render.js`
already admits the `dir` attribute but not the `bdi` element, so punctuation around a
right-to-left name inside a left-to-right sentence is not yet isolated.
