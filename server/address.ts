// Addresses a door's served tree in place (release-addresses.ts) and writes
// beside it the inline scripts its entries hold, which the door's policy names;
// a release target's ICE servers go into the terminal config first:
//   deno run address.ts <served-dir> <script-sources-file> [--ice-servers <json>]
import { addressRelease, parseIceServers } from './release-addresses.ts'

const usage = 'usage: address.ts <served-dir> <script-sources-file> [--ice-servers <json>]'
const [dir, scripts, flag, ice, ...rest] = Deno.args
if (!dir || !scripts || rest.length > 0 || (flag !== undefined && (flag !== '--ice-servers' || ice === undefined))) throw new Error(usage)
const release = await addressRelease(dir, flag === undefined ? {} : { iceServers: parseIceServers(ice) })
await Deno.writeTextFile(scripts, release.scripts.join(' '))
