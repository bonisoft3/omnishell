export interface OmnishellPreset {
  theme: {
    zIndex: Record<string, string>
    spacing: Record<string, string>
    fontSize: Record<string, string>
  }
  disableArbitraryValues: boolean
}

export const omnishellPreset: OmnishellPreset = {
  theme: {
    zIndex: {
      bleed: "var(--z-bleed)",
      sticky: "var(--z-sticky)",
      panel: "var(--z-panel)",
      nav: "var(--z-nav)",
      fab: "var(--z-fab)",
      dropdown: "var(--z-dropdown)",
      overlay: "var(--z-overlay)",
      flash: "var(--z-flash)",
    },
    spacing: {
      "0": "0",
      "1": "0.25rem",
      "2": "0.5rem",
      "3": "0.75rem",
      "4": "1rem",
      "5": "1.25rem",
      "6": "1.5rem",
      "8": "2rem",
      "10": "2.5rem",
      "12": "3rem",
      "16": "4rem",
      "20": "5rem",
      "24": "6rem",
      "32": "8rem",
      "40": "10rem",
      "48": "12rem",
      "64": "16rem",
    },
    fontSize: {
      xs: "0.75rem",
      sm: "0.875rem",
      base: "1rem",
      lg: "1.125rem",
      xl: "1.25rem",
      "2xl": "1.5rem",
      "3xl": "1.875rem",
      "4xl": "2.25rem",
    },
  },
  disableArbitraryValues: true,
}
