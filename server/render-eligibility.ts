export function publicSSR(cfg: { auth?: { required?: boolean } }, route: { ssr?: string; access?: string }): boolean {
  return !cfg.auth?.required && route.access !== 'private' && route.ssr === 'ssr'
}
