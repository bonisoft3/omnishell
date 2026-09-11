Frozen copies of app stylesheets and markup, read by `test/visibility.test.ts`. They are copies, not the apps: an app editing its shell changes nothing here, and a case that needs a newer sheet re-copies it. Each fixture path mirrors its source under `apps/<app>/`:

- `chess/shell/shared/paper.css`, `chess/shell/screens/board.{css,html}` — from `apps/chess/shell/`
- `truco/shell/shared/table.css`, `truco/shell/screens/arena.{css,html}` — from `apps/truco/shell/`; the copied `arena.css` carries an orphaned `}` before `@keyframes ember`, the case for "an orphaned brace is reported unjudged"
- `shadcnui/shell/shared/chrome.css`, `shadcnui/shell/screens/*.css`, `shadcnui/shell/screens/{overlays,input-otp}.html` — from `apps/shadcnui/shell/`; no shadcnui screen's markup carries a `<style>`, so only the two mounted screens keep theirs
