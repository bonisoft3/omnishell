// The advertising conversions the terminal reports, at moments only it sees,
// through the entry's tag bridge (pronto's meta.googleTag), which sends
// nothing off its declared hosts. The declaration is shell.json's
// `conversions`: each name the terminal knows, its Google Ads `send_to`.

export const CONVERSION_PENDING_KEY = "pronto-conversion-pending";
const KNOWN = ["signup"];

/** The account a session change made a person of, or null: a guest's
 * session followed by a person's under the guest's own id, which only its
 * promotion gives — a passkey made for it, a provider's subject linked to it. */
export const promotedAccount = (before, after) =>
  before?.user?.guest === true && after?.user !== undefined && !after.user.guest && after.user.id === before.user.id
    ? after.user.id
    : null;

/**
 * Reports `signup` once per account, its id the transaction Google
 * de-duplicates on. A promotion the page reloads after is kept in the tab
 * (`storage`) and reported by the page that follows, whose frame lives to
 * send it.
 *
 * @param {object} opts
 * @param {Record<string, string>} opts.conversions
 * @param {(...args: unknown[]) => void} opts.gtag
 * @param {{ getItem(k: string): string | null, setItem(k: string, v: string): void, removeItem(k: string): void }} opts.storage
 */
export function startConversions({ conversions, gtag, storage }) {
  for (const name of Object.keys(conversions)) {
    if (!KNOWN.includes(name)) throw new Error(`the terminal reports no conversion named ${name}`);
  }
  const signup = (account) => {
    if (conversions.signup !== undefined) gtag("event", "conversion", { send_to: conversions.signup, transaction_id: account });
  };
  const pending = storage.getItem(CONVERSION_PENDING_KEY);
  if (pending !== null) {
    storage.removeItem(CONVERSION_PENDING_KEY);
    signup(pending);
  }
  return {
    /** A session replaced another; `reloading`, the page goes before it can send. */
    signedIn(before, after, reloading = false) {
      const account = promotedAccount(before, after);
      if (account === null) return;
      if (reloading) storage.setItem(CONVERSION_PENDING_KEY, account);
      else signup(account);
    },
    /** An account made with no guest before it: a sign-in gate's passkey. */
    made(session) {
      signup(session.user.id);
    },
  };
}
