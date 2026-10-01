---
type: concept
title: Native capabilities
description: Why standard HTML5 primitives and W3C APG patterns replace ad-hoc framework data-* attributes, and how the platform owns what script used to simulate.
---

# Native capabilities

Modern web standards provide native browser capabilities for behaviors that
earlier frontend architectures implemented through custom JavaScript and
framework-specific `data-*` attributes. By leveraging native HTML5 primitives
and W3C Accessible Rich Internet Applications (WAI-ARIA) Authoring Practices
Guide (APG) standards, applications avoid runtime coordination bugs, eliminate
script weight, and enable both human developers and LLMs to author interfaces
using standard web contracts instead of learning a proprietary DSL.

The legacy ad-hoc attributes (`data-open`, `data-interest`, `data-rove`,
`data-focus`) have been completely removed from the runtime interpreter and static
analysis in favor of platform-native HTML5 and W3C APG contracts. Focus and ARIA
derivations are argued in [Focus and ARIA](accessibility.md).

## Why native capabilities supersede ad-hoc data attributes

Ad-hoc framework attributes like `data-open`, `data-interest`, `data-rove`, and
`data-focus` introduce a fundamental hazard: the **two-writer problem**. The
framework attempts to track and simulate layout and interaction state in DOM
attributes and runtime variables, while the browser engine's native event loop,
focus manager, top layer stack, and accessibility tree operate concurrently.

| Dimension | Ad-Hoc `data-*` Attributes & Custom JS | Native HTML5 Primitives & W3C APG |
|---|---|---|
| **Top Layer & Stacking** | Requires `z-index` wars, manual backdrop styling, and DOM re-parenting. | Native `::backdrop` and top-layer placement guaranteed by browser engine; escapes all parent `overflow: hidden` and stacking contexts. |
| **Focus Management** | Fragile JavaScript event listeners (`focusin`, `keydown`) that trap or steal focus, often fighting user Tab navigation. | Built-in focus containment in modal `<dialog>`, native return of focus to invoking control upon dismissal. |
| **Dismissal Semantics** | Manual click-outside listeners, window resize observers, and Esc key bindings that break across nested popups. | Browser-native light dismiss and Escape key handling with correct stacking order resolution for `popover="auto"` and `<dialog>`. |
| **Accessibility (AOM)** | Manual ARIA attribute synchronization; missing states cause silent screen reader failures. | Built-in accessibility semantics directly mapped to the Accessibility Object Model (AOM) by the browser engine. |
| **Runtime Cost & Dependencies** | Mutation observers, timer queues, script bundles, and polyfills. | Zero JavaScript footprint, zero garbage collection pauses, instant parsing and execution in browser engine native code. |

## The standard HTML5 advantage for developers and LLMs

A custom framework domain-specific language (DSL)—such as remembering that
`data-open` controls a popover element, `data-interest` orchestrates a hover
delay timer, or `data-rove` calculates `tabindex`—imposes a steep cognitive tax:

1. **Elimination of DSL Hallucinations**: Large Language Models (LLMs) and
   developers are trained on the vast corpus of standard HTML5 specifications
   and open web repositories. When a framework invents custom attributes for
   native problems, models must be steered with extensive prompt engineering
   and few-shot examples, frequently hallucinating dialect variations. Using
   standard HTML5 attributes (`popovertarget`, `<dialog>`, `tabindex`) enables
   accurate zero-shot markup generation.
2. **Transferable Competence**: Code written with standard HTML5 primitives can
   be audited, styled, tested, and refactored using universal web tooling,
   browser DevTools, accessibility linters, and Playwright test assertions
   without framework-specific plugins.
3. **Resilience to Browser Evolution**: Standards-based markup automatically
   benefits from browser engine performance optimizations, OS-level assistive
   technology enhancements, and emerging platform features.

## Concrete primitives and patterns

### 1. Native Popovers: `popover="auto"` and `popovertarget`

HTML5 popovers provide top-layer rendering, automatic light dismiss (clicking
outside), and Escape key dismissal with no JavaScript.

```html
<!-- Trigger button -->
<button type="button" class="pop-trigger"
        popovertarget="account-menu"
        popovertargetaction="toggle">
  Account
</button>

<!-- Popover surface in the top layer -->
<div id="account-menu" class="pop-surface" popover="auto">
  <nav aria-label="Account actions">
    <a href="/profile">Profile</a>
    <a href="/settings">Settings</a>
    <button type="button" popovertarget="account-menu" popovertargetaction="hide">
      Close
    </button>
  </nav>
</div>
```

- **`popover="auto"`**: Automatically enforces that opening one popover dismisses
  unrelated popovers, and provides outside click and Esc dismissal.
- **`popover="manual"`**: Used for toasts or persistent banners that require
  explicit dismissal and do not auto-close sibling popovers.
- **`popovertarget`**: Declares the target element ID to control.
- **`popovertargetaction`**: Specifies whether the trigger should `"toggle"`,
  `"show"`, or `"hide"` the target (defaults to `"toggle"`).
- **CSS Anchor Positioning**: Anchors the surface against the trigger using
  `anchor-name`, `position-anchor`, `position-area`, and
  `position-try-fallbacks` in pure CSS, eliminating JavaScript coordinate
  math.

*Legacy replacement*: Replaces `data-open="{column}"` and `data-interest="{id}"`.

### 2. Native Dialogs: `<dialog>` and `<form method="dialog">`

HTML `<dialog>` elements provide native modal and non-modal dialog surfaces with
automatic backdrop dimming, inert document isolation, and built-in focus loops.

```html
<!-- Modal Trigger -->
<button type="button" commandfor="confirm-dialog" command="show-modal">
  Delete Project
</button>

<!-- Modal Dialog Surface -->
<dialog id="confirm-dialog" class="dialog-modal"
        aria-labelledby="dialog-title" aria-describedby="dialog-desc">
  <h2 id="dialog-title">Delete Project</h2>
  <p id="dialog-desc">Are you sure? This action cannot be reversed.</p>

  <form method="dialog" class="dialog-actions">
    <button type="submit" value="cancel" class="btn-cancel" autofocus>
      Cancel
    </button>
    <button type="submit" value="confirm" class="btn-danger">
      Confirm Deletion
    </button>
  </form>
</dialog>
```

- **Inert Background**: Calling `showModal()` or triggering via `show-modal`
  makes the rest of the document `inert` automatically, preventing focus and
  virtual cursor traversal outside the modal.
- **`<form method="dialog">`**: Submitting this form closes the dialog
  natively, stores the submitting button's `value` in `dialog.returnValue`, and
  restores focus to the invoking element without custom click handlers.
- **Escape Handling**: The platform handles the Escape key natively, firing a
  `cancel` event that can be prevented if needed.

*Legacy replacement*: Replaces custom modal overlays and ad-hoc focus traps.

### 3. W3C APG Roving Tabstop: `role="tablist"` + `role="tab"` + `tabindex`

The W3C APG Roving Tabstop pattern provides accessible keyboard navigation
across composite interactive controls (tabs, radio groups, toolbars, menus).
Exactly one member of the set is in the document tab order (`tabindex="0"`),
while all inactive members are excluded from the tab sequence
(`tabindex="-1"`).

```html
<div role="tablist" aria-label="Project Views">
  <button type="button" role="tab" id="tab-overview"
          aria-selected="true" tabindex="0"
          aria-controls="panel-overview">
    Overview
  </button>
  <button type="button" role="tab" id="tab-deployments"
          aria-selected="false" tabindex="-1"
          aria-controls="panel-deployments">
    Deployments
  </button>
  <button type="button" role="tab" id="tab-metrics"
          aria-selected="false" tabindex="-1"
          aria-controls="panel-metrics">
    Metrics
  </button>
</div>

<div role="tabpanel" id="panel-overview"
     aria-labelledby="tab-overview" tabindex="0">
  Overview details...
</div>
<div role="tabpanel" id="panel-deployments"
     aria-labelledby="tab-deployments" tabindex="0" hidden>
  Deployments list...
</div>
<div role="tabpanel" id="panel-metrics"
     aria-labelledby="tab-metrics" tabindex="0" hidden>
  Metrics graph...
</div>
```

- **Contract**: The active item holds `tabindex="0"`; inactive items hold
  `tabindex="-1"`. When the user navigates using Arrow keys, focus moves to the
  new active element, updating `aria-selected` and swapping `tabindex`.
- **Assistive Technology**: Screen readers understand the container size,
  position in set (`aria-posinset`, `aria-setsize`), and selection state
  directly from standard ARIA attributes.
- **Predictable Tab Traversal**: Pressing Tab moves focus directly to the active
  tab, and a subsequent Tab moves to the active tabpanel (which carries
  `tabindex="0"`), completely skipping unselected tabs.

*Legacy replacement*: Replaces `data-rove="{column}"` and `data-focus="{column}"`.

### 4. Native Temporal, Numeric, and Disclosure Elements

Beyond overlay and focus primitives, standard HTML5 includes semantic elements
for temporal and numeric representation:

```html
<!-- Native Temporal: ISO 8601 machine-readable datetime + localized display -->
<time datetime="2026-09-30T14:30:00Z" data-text="{created_at}" data-text-format="datetime">
  Sep 30, 2026, 14:30 UTC
</time>

<!-- Native Gauge / Meter -->
<meter min="0" max="100" low="25" high="75" optimum="100" value="85">
  85% Capacity
</meter>

<!-- Native Progress Bar -->
<progress max="100" value="45">45%</progress>

<!-- Native Zero-Script Disclosure -->
<details>
  <summary>Advanced Settings</summary>
  <div class="details-content">
    Configuration options...
  </div>
</details>
```

- **`<time datetime="...">`**: Provides machine-readable time stamps for search
  engines, screen readers, and automated agents while displaying formatted
  human-readable text.
- **`<meter>` and `<progress>`**: Surface scalar measurements and progress
  gauges directly in the accessibility tree with native range semantics,
  avoiding custom `role="progressbar"` styling shims.
- **`<details>` and `<summary>`**: Native interactive disclosure widget with
  built-in keyboard toggle (Space / Enter) requiring zero JavaScript or state
  machines for presentation-only toggles.
## Elimination of ad-hoc attributes

Omnishell completely eliminates ad-hoc data attributes rather than carrying
backwards-compatibility shims or deprecation warnings. The runtime handlers in
`screen.js`, static analysis rules in `lint.ts`, and reference tables in
`REFERENCE.md` have deleted:

- **`data-open`**: Eliminated. Standard HTML5 Popovers (`popover="auto"`,
  `popovertarget="..."`) and Dialogs (`<dialog>`, `<form method="dialog">`)
  handle top layer, backdrop dimming, and dismissals natively without binding
  ad-hoc columns or coordinating imperative calls in the interpreter.
- **`data-interest`**: Eliminated. Simulating hover/focus timers in JavaScript
  creates two-writer hazards. Use standard popover activations or native invokers.
- **`data-rove` and `data-focus`**: Eliminated. Standard W3C APG patterns specify
  composite keyboard navigation through explicit `tabindex="0"` on the active
  member and `tabindex="-1"` on inactive members, mapped directly to the browser
  accessibility tree.

### Attribute replacement matrix

| Ad-Hoc Attribute | Status | Native Replacement | Replacement Pattern |
|---|---|---|---|
| `data-open="{col}"` | **Removed** | `popover="auto"` + `popovertarget="..."` or `<dialog>` | Use declarative button invokers or native dialog methods. Where non-click triggers (context menus) need state, bind through standard HTML5 popover attributes. |
| `data-interest="id"` | **Removed** | `popover="auto"` + standard invoker commands | Replace with standard popover triggers. Avoid custom hover timer scripts. |
| `data-rove="{col}"` | **Removed** | W3C APG `role="tablist"` + `role="tab"` + `tabindex="0" / "-1"` | Declare explicit `tabindex="0"` on the active item and `tabindex="-1"` on siblings via data projection or markup. |
| `data-focus="{col}"` | **Removed** | Standard DOM focus / APG keyboard patterns | Rely on native browser focus movements, invoker return focus, and standard APG navigation. |
