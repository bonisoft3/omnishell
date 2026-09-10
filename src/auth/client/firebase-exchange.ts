export interface ExchangeOptions {
  endpoint?: string
  fetch?: typeof fetch
}

export interface ExchangeResult {
  userId: string
}

const DEFAULT_ENDPOINT = "/auth/authenticate/verify"

export async function exchangeFirebaseToken(
  idToken: string,
  options: ExchangeOptions = {},
): Promise<ExchangeResult> {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT
  const f = options.fetch ?? fetch
  const res = await f(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credential: { idToken } }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`exchangeFirebaseToken: ${res.status} ${text}`)
  }
  const body = (await res.json()) as { userId: string }
  return { userId: body.userId }
}
