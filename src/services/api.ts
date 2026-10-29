import type { ApiErrorBody } from '../../shared/contracts.js'

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  window.addEventListener('pagehide', abort, { once: true })
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) controller.abort()
  try {
    await Promise.resolve()
    if (controller.signal.aborted)
      throw new DOMException('Consulta cancelada.', 'AbortError')
    let response: Response
    try {
      response = await fetch(`/api${path}`, {
        ...options,
        signal: controller.signal,
        credentials: 'include',
        headers: {
          ...(options.body instanceof FormData
            ? {}
            : { 'Content-Type': 'application/json' }),
          ...options.headers,
        },
      })
    } catch {
      if (controller.signal.aborted)
        throw new DOMException('Consulta cancelada.', 'AbortError')
      throw new Error(
        'Não foi possível conectar ao servidor. Verifique sua conexão e tente novamente.',
      )
    }
    const body = await response.json().catch(() => null)
    if (!response.ok) {
      const error = body as ApiErrorBody | null
      throw new Error(
        error?.message ||
          `Não foi possível concluir a operação (${response.status}).`,
      )
    }
    return body as T
  } finally {
    window.removeEventListener('pagehide', abort)
    options.signal?.removeEventListener('abort', abort)
  }
}

export function json(method: string, body: unknown): RequestInit {
  return { method, body: JSON.stringify(body) }
}
