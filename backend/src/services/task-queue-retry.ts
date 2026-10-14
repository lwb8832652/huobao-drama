/** Only a received HTTP 429 is proof that repeating a paid request is safe. */
export function httpErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const value = error as { statusCode?: unknown; status?: unknown }
  return typeof value.statusCode === 'number' ? value.statusCode : typeof value.status === 'number' ? value.status : undefined
}

function retryDelay(error: any, retry: number) {
  const headers = error?.responseHeaders || error?.headers
  const header = typeof headers?.get === 'function' ? headers.get('retry-after') : headers?.['retry-after'] || headers?.['Retry-After']
  if (typeof header === 'string' && header.trim()) {
    const seconds = Number(header)
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now()
    if (Number.isFinite(delay) && delay >= 0) return Math.min(delay, 2_147_483_647)
  }
  return 1000 * 2 ** retry
}

export async function retryRejectedRateLimit<T>(
  operation: (attempt: number) => Promise<T>,
  onRejected?: (error: unknown, retry: number, delayMs: number) => void | Promise<void>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(attempt) }
    catch (error) {
      if (httpErrorStatus(error) !== 429 || attempt >= 2) throw error
      const delayMs = retryDelay(error, attempt)
      await onRejected?.(error, attempt + 1, delayMs)
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
}
