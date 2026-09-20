/** Where the app under `appDir` is served: APP_URL when the environment sets
 * one (the integrate closure points it at the caddy service), else
 * `https://localhost:<port>` on the host port compose published for caddy's
 * 8443. The service is the app's caddy target as bayt names it,
 * `<project>-caddy`, and the project's name is in its bayt.json. No
 * published port is an error. */
export async function baseUrl(appDir: string): Promise<string> {
  const fromEnv = Deno.env.get("APP_URL")
  if (fromEnv) return fromEnv
  const project: string = JSON.parse(await Deno.readTextFile(`${appDir}/bayt.json`)).name
  const out = await new Deno.Command("docker", {
    args: ["compose", "port", `${project}-caddy`, "8443"],
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
