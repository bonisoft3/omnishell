/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { Page } from "@playwright/test"
import type { VisualBug } from "../types"

type RGB = [number, number, number]
type Pair = { label: string; size: number; weight: number; fg: RGB; bg: RGB }

/** WCAG 1.4.3 large text: 24px, or 18.66px at 700 and above. */
export function contrastFloor(fontSizePx: number, fontWeight: number): number {
  return fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700) ? 3 : 4.5
}

/** WCAG 2's contrast ratio over two opaque sRGB colours. */
export function contrastRatio(a: RGB, b: RGB): number {
  const luminance = ([r, g, bl]: RGB) => {
    const channel = (v: number) => {
      const c = v / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(bl)
  }
  const [la, lb] = [luminance(a), luminance(b)]
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

const hex = ([r, g, b]: RGB) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")

/** How long a flip's transitions are waited for: settle's own budget. */
const MOTION_CAP_MS = 2500

/**
 * Text against the flat colour painted behind it, in every appearance the page
 * claims.
 *
 * The ratio is the criterion's own arithmetic over the computed colours, so a
 * finding is exact, and it is decided only where the backdrop is: the nearest
 * opaque background up the ancestors, composited through any translucent ones,
 * with no image, opacity, filter or blend on the way and nothing painted
 * between it and the glyphs. Text over an image, a gradient or a translucent
 * stack is not this rule's, and is skipped rather than guessed at.
 *
 * A pair under the floor is an error: it is wrong in the design, not in the
 * rendering. Each appearance in `color-scheme` is read on its own, since a
 * twin resolves differently in each.
 *
 * It scrolls each run into view and switches the appearance while it reads,
 * and restores both, so it is sequenced after checks that read geometry.
 */
export async function checkContrast(page: Page): Promise<VisualBug[]> {
  const { claimed, dark } = await page.evaluate(() => ({
    claimed: getComputedStyle(document.documentElement).colorScheme,
    dark: matchMedia("(prefers-color-scheme: dark)").matches,
  }))
  const schemes = (["light", "dark"] as const).filter((s) => claimed.split(/\s+/).includes(s))
  // `normal`, the scheme a page claims by claiming none, is painted light
  // whatever the reader prefers: one appearance.
  const passes = schemes.length > 0 ? schemes : (["light"] as const)
  const bugs: VisualBug[] = []
  try {
    for (const scheme of passes) {
      await page.emulateMedia({ colorScheme: scheme })
      // The flip starts every `transition: color` on the page, and a colour
      // read mid-way is neither twin. Each finite one on the document's clock
      // is waited out, up to the cap — not ended, since ending one fires the
      // events a page acts on; an infinite one is the page's steady state, and
      // one on a scroll timeline is where the scroll is. settle in
      // check-visual.ts waits by the same rule.
      await page.evaluate((cap: number) =>
        Promise.race([
          Promise.allSettled(
            document.getAnimations()
              .filter((a) =>
                a.timeline instanceof DocumentTimeline && a.playState === "running" && a.playbackRate !== 0 &&
                a.effect?.getTiming().iterations !== Infinity
              )
              .map((a) => a.finished),
          ),
          new Promise((done) => setTimeout(done, cap)),
        ]), MOTION_CAP_MS)
      for (const p of await page.evaluate(pairs)) {
        const ratio = contrastRatio(p.fg, p.bg)
        const floor = contrastFloor(p.size, p.weight)
        if (ratio >= floor) continue
        const where = passes.length > 1 ? ` (${scheme})` : ""
        bugs.push({
          rule: "text-contrast",
          description: `"${p.label}" paints ${hex(p.fg)} on ${hex(p.bg)} at ${Math.round(p.size)}px: ` +
            `${ratio.toFixed(2)}:1, under the ${floor}:1 floor${where}`,
          severity: "critical",
          element: p.label,
        })
      }
    }
  } finally {
    // The appearance the page had, kept as an emulation: the caller's own
    // emulation, if it had one, is not readable back.
    await page.emulateMedia({ colorScheme: dark ? "dark" : "light" })
  }
  return bugs
}

/** Every text run whose backdrop is decidable, with both colours resolved. */
function pairs(): Pair[] {
  type RGBA = [number, number, number, number]
  // A computed colour keeps the space it was mixed in — oklch, oklab,
  // color(srgb) — so it is read as painted: once over white and once over
  // black, which gives the sRGB bytes and the alpha between them.
  const cx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!
  const painted = (css: string, under: string) => {
    cx.fillStyle = under
    cx.fillRect(0, 0, 1, 1)
    cx.fillStyle = css
    cx.fillRect(0, 0, 1, 1)
    return cx.getImageData(0, 0, 1, 1).data
  }
  const colours = new Map<string, RGBA>()
  const parse = (css: string): RGBA => {
    const known = colours.get(css)
    if (known) return known
    if (!CSS.supports("color", css)) throw new Error(`${css} is not a colour this rule reads`)
    const w = painted(css, "#ffffff")
    const k = painted(css, "#000000")
    const a = 1 - (w[0] - k[0] + w[1] - k[1] + w[2] - k[2]) / (3 * 255)
    const rgba: RGBA = a <= 0 ? [0, 0, 0, 0] : [k[0] / a, k[1] / a, k[2] / a, Math.min(1, a)]
    colours.set(css, rgba)
    return rgba
  }
  // The canvas under everything, as this appearance paints it.
  const probe = document.createElement("span")
  probe.style.backgroundColor = "Canvas"
  document.body.append(probe)
  const canvas = parse(getComputedStyle(probe).backgroundColor)
  probe.remove()

  // A modal dialog makes everything outside it inert without an attribute
  // saying so, and paints its backdrop over it.
  const modal = document.querySelector("dialog:modal")
  const label = (el: HTMLElement) =>
    el.getAttribute("data-testid") || el.getAttribute("aria-label") ||
    el.textContent?.trim().slice(0, 30) || el.tagName.toLowerCase()

  // Each run is judged where a reader would see it, and every scroller —
  // the root among them — is put back where it was.
  const scrolled = [...document.querySelectorAll<HTMLElement>("*")]
    .map((e) => [e, e.scrollTop, e.scrollLeft] as const)
  // An ancestor's layer is the same for every run under it.
  const layers = new Map<HTMLElement, { flat: boolean; colour: RGBA }>()
  const layerOf = (up: HTMLElement) => {
    const known = layers.get(up)
    if (known) return known
    const s = getComputedStyle(up)
    const flat = s.opacity === "1" && s.filter === "none" && s.mixBlendMode === "normal" &&
      s.backdropFilter === "none" && s.maskImage === "none" && s.backgroundImage === "none"
    const layer = { flat, colour: flat ? parse(s.backgroundColor) : ([0, 0, 0, 0] as RGBA) }
    layers.set(up, layer)
    return layer
  }
  const out: Pair[] = []
  try {
    for (const el of document.body.querySelectorAll<HTMLElement>("*")) {
      if (![...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? "").trim())) continue
      // 1.4.3 exempts text that is part of an inactive control or is there for
      // decoration only; both are authored deliberately dim.
      if (el.closest('[aria-hidden="true"],[inert],:disabled,[aria-disabled="true"]')) continue
      if (modal && !modal.contains(el)) continue
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) continue
      const style = getComputedStyle(el)
      // The glyphs are painted in the fill colour, which is `color` unless
      // authored apart from it. Outlined glyphs are read by their outline, as
      // the criterion's own technique has it: the stroke is the edge the eye
      // finds.
      const stroked = parseFloat(style.webkitTextStrokeWidth) > 0
      const ink = parse(stroked ? style.webkitTextStrokeColor : style.webkitTextFillColor)
      // Transparent ink is authored: text painted by a background clipped to
      // the glyphs, or text meant to be read by nothing.
      if (ink[3] === 0) continue

      // The backdrop: layers composited outward until one is opaque, or the
      // canvas. Anything on the way that is not a flat colour ends the claim.
      let [r, g, b, a] = [0, 0, 0, 0]
      const over = ([lr, lg, lb, la]: RGBA) => {
        const gap = (1 - a) * la
        r += lr * gap; g += lg * gap; b += lb * gap; a += gap
      }
      let provider: HTMLElement | null = null
      let flat = true
      for (let up: HTMLElement | null = el; up; up = up.parentElement) {
        const layer = layerOf(up)
        if (!layer.flat) { flat = false; break }
        over(layer.colour)
        if (a >= 1) { provider = up; break }
      }
      if (!flat) continue
      if (provider === null) { over(canvas); provider = document.documentElement }

      // Nothing painted over the glyphs, and nothing painted between them and
      // that backdrop: the paint stack at the first line's centre must start
      // at the run and hold only its ancestors down to the provider.
      const range = document.createRange()
      const text = [...el.childNodes].find((n) => n.nodeType === 3 && (n.textContent ?? "").trim())!
      range.selectNodeContents(text)
      const firstLine = () => [...range.getClientRects()].find((rect) => rect.width >= 1 && rect.height >= 1)
      let line = firstLine()
      if (!line) continue
      if (line.top < 0 || line.left < 0 || line.bottom > innerHeight || line.right > innerWidth) {
        el.scrollIntoView({ block: "center", inline: "center" })
        line = firstLine()
        if (!line) continue
      }
      const stack = document.elementsFromPoint(line.left + line.width / 2, line.top + line.height / 2)
      if (stack.length === 0 || !el.contains(stack[0])) continue
      // A run laid outside its provider's box — a label floated above a card —
      // has that provider nowhere under its glyphs.
      const to = stack.indexOf(provider)
      if (to < 0 || stack.slice(stack.indexOf(el) + 1, to).some((e) => !e.contains(el))) continue

      const bg: RGB = [Math.round(r), Math.round(g), Math.round(b)]
      const fg = bg.map((c, i) => Math.round(ink[i] * ink[3] + c * (1 - ink[3]))) as RGB
      out.push({ label: label(el), size: parseFloat(style.fontSize), weight: Number(style.fontWeight), fg, bg })
    }
  } finally {
    for (const [e, top, left] of scrolled) { e.scrollTop = top; e.scrollLeft = left }
  }
  return out
}
