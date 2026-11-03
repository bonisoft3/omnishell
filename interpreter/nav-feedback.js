/** A link answers its click in the frame it was clicked, wordless, until the screen it asked for
 * is on show: a navigation can take seconds, and the page gave no sign it had heard. */
export function navFeedback(reducedMotion) {
  let held = null;
  const settle = () => {
    if (held === null) return;
    held.animation?.cancel();
    held.link.removeAttribute("aria-busy");
    held = null;
  };
  return {
    settle,
    press(link) {
      settle();
      link.setAttribute("aria-busy", "true");
      const frames = reducedMotion ? [{ opacity: 0.6 }, { opacity: 0.6 }] : [{ opacity: 1 }, { opacity: 0.4 }];
      held = { link, animation: link.animate?.(frames, { duration: 500, iterations: Infinity, direction: "alternate" }) };
    },
  };
}
