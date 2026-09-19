/** Where the app under `appDir` is served: APP_URL when the environment sets
 * one (the integrate closure points it at the caddy service), else
 * `https://localhost:<port>` on the host port compose published for caddy's
 * 8443. No published port is an error. */
export async function baseUrl(appDir: string): Promise<string> {
  const fromEnv = Deno.env.get("APP_URL")
  if (fromEnv) return fromEnv
  const out = await new Deno.Command("docker", {
    args: ["compose", "port", "caddy", "8443"],
    cwd: appDir,
    stdout: "piped",
    stderr: "piped",
  }).output()
  const text = new TextDecoder().decode(out.stdout).trim()
  const port = text.split("\n")[0]?.split(":").pop()
  if (!out.success || !port) {
    throw new Error(`could not read the published caddy port: ${new TextDecoder().decode(out.stderr).trim()}`)
  }
  return `https://localhost:${port}`
}
