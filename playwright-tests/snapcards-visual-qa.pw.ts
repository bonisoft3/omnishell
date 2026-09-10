// The battery pointed at guis/snapcards' Storybook. Nothing here starts it —
// run `just launch@browser` in guis/snapcards first, or these fail on connect.
import { asCheckPage, expect, it, withPage } from "./harness.ts"
import { visualLint } from "../src/lint/playwright/visual-lint.ts"
import { assertVisionReview } from "../src/lint/playwright/vision-review.ts"

const STORYBOOK = Deno.env.get("STORYBOOK_URL") ?? "http://localhost:6006"
const story = (id: string) => `${STORYBOOK}/iframe.html?id=${id}&viewMode=story`

const STORIES = [
  "components-cardsetcard--default",
  "components-cardsetcard--empty",
  "components-cardsetcard--long-name",
  "pages-dashboard--default",
  "components-editcarddialog--open",
  "components-errorfallback--default",
  "components-flashcardcard--with-image",
  "components-flashcardcard--flipped",
  "components-flashcardcard--no-image",
  "components-generationform--empty",
  "components-generationform--with-quick-suggestion",
  "components-onboarding--default",
  "components-pdfexportbutton--default",
  "components-reviewsession--default",
  "components-reviewsession--empty",
  "components-themetoggle--default",
]

for (const storyId of STORIES) {
  it(`visual lint — ${storyId}`, () =>
    withPage(async (page) => {
      await page.goto(story(storyId))
      await page.waitForTimeout(5000)
      const result = await visualLint(asCheckPage(page))
      for (const bug of result.bugs) console.log(`  [${bug.severity}] ${bug.rule}: ${bug.description}`)
      // minor findings (focus-order) are logged, never blocking
      const blocking = result.bugs.filter((b) => b.severity === "critical" || b.severity === "major")
      expect(
        blocking.map((b) => `[${b.severity}] ${b.rule}: ${b.description}`).join("\n"),
      ).toBe("")
    }))
}

const VISION_STORIES = [
  {
    id: "pages-dashboard--default",
    context:
      "Dashboard with card sets grid. Odd numbers of cards in a 2-column grid are expected — the last row may have a single card. Seed data may include cards in multiple languages.",
  },
  { id: "components-flashcardcard--with-image", context: "Flashcard with image" },
  { id: "components-generationform--empty", context: "Card generation form" },
  { id: "components-reviewsession--default", context: "Card review session" },
]

for (const { id, context } of VISION_STORIES) {
  it(`vision review — ${id}`, () =>
    withPage(async (page) => {
      await page.goto(story(id))
      await page.waitForTimeout(5000)
      await assertVisionReview(asCheckPage(page), { viewport: "desktop", context, failOn: "major" })
    }))
}
