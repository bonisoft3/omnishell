// Addresses a door's served tree in place (release-addresses.ts) and writes
// beside it the inline scripts its entries hold, which the door's policy names;
// a release target's ICE servers go into the terminal config first, and the
// door's realm frame sources into every entry's policy:
//   deno run address.ts <served-dir> <script-sources-file> [--ice-servers <json>] [--frames <json>]
import { addressRelease, type AddressOptions, parseIceServers } from './release-addresses.ts'

const usage = 'usage: address.ts <served-dir> <script-sources-file> [--ice-servers <json>] [--frames <json>]'
const [dir, scripts, ...rest] = Deno.args
if (!dir || !scripts || rest.length % 2) throw new Error(usage)
const options: AddressOptions = {}
for (let i = 0; i < rest.length; i += 2) {
  const [flag, value] = [rest[i], rest[i + 1]]
  if (flag === '--ice-servers' && !options.iceServers) options.iceServers = parseIceServers(value)
  else if (flag === '--frames' && !options.frames) {
    const frames = JSON.parse(value)
    if (!Array.isArray(frames) || !frames.every(f => typeof f === 'string' && /^https:\/\/[^\s;,]+$/.test(f))) throw new Error(`frames ${value} are not a list of https sources`)
    options.frames = frames
  } else throw new Error(usage)
}
const release = await addressRelease(dir, options)
await Deno.writeTextFile(scripts, release.scripts.join(' '))
