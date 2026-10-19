// Addresses a door's served tree in place (release-addresses.ts) and writes
// beside it the inline scripts its entries hold, which the door's policy names:
//   deno run address.ts <served-dir> <script-sources-file>
import { addressRelease } from './release-addresses.ts'

const [dir, scripts] = Deno.args
if (!dir || !scripts || Deno.args.length !== 2) throw new Error('usage: address.ts <served-dir> <script-sources-file>')
const release = await addressRelease(dir)
await Deno.writeTextFile(scripts, release.scripts.join(' '))
