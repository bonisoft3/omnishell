// What the device's passkey manager is told of what the server holds
// (WebAuthn's Signal API, where the browser has it).

import { ProgramError } from "./fragment.js";

/** Tells the device's passkey manager something the server holds (WebAuthn's
 * Signal API, where the browser has it). The sign-in it follows has already
 * succeeded and stands; a refusal is a call this terminal got wrong, so it
 * dies attributed as the program's rather than passing for a failed request. */
export function signal(method, options) {
  const call = globalThis.PublicKeyCredential?.[method];
  if (call === undefined) return undefined;
  return call.call(globalThis.PublicKeyCredential, options).catch((err) => {
    throw new ProgramError(`PublicKeyCredential.${method} refused ${JSON.stringify(options)}: ${err?.name}: ${err?.message}`);
  });
}

/** The name the device shows beside this person's passkeys, after a ceremony
 * and whenever they rename themselves. Which passkeys still sign in is never
 * said: no list a tab holds is current once another tab may have added one,
 * and the device may delete whatever it is not told of. A dead passkey is
 * dropped the first time it is refused (signalUnknownCredential). A provider's
 * session carries no `passkey` and has nothing to name. */
export function signalName(session, displayName) {
  const passkey = session.passkey;
  if (!passkey) return;
  // The person's manager shows the account by its name, never the handle
  // others see (a suffix, or a guest's fruit and animal).
  signal("signalCurrentUserDetails", { rpId: passkey.rpId, userId: passkey.userId, name: displayName, displayName });
}
