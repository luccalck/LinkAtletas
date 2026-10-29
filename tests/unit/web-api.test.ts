import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, json } from '../../src/services/api.js'

afterEach(() => vi.unstubAllGlobals())

function transport() {
  const events = new EventTarget()
  const fetch = vi.fn(async (_url: string, options: RequestInit) => {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    return new Response(JSON.stringify({ saved: true }), {
      headers: { 'Content-Type': 'application/json' },
    })
  })
  vi.stubGlobal('window', events)
  vi.stubGlobal('fetch', fetch)
  return { events, fetch }
}

describe('transporte web e cancelamento antes da rede', () => {
  it('nao inicia fetch com sinal ja cancelado', async () => {
    const { fetch } = transport()
    const controller = new AbortController()
    controller.abort()

    await expect(api('/dashboard', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('nao inicia fetch quando o efeito e desmontado no mesmo ciclo', async () => {
    const { fetch } = transport()
    const controller = new AbortController()
    const request = api('/dashboard', { signal: controller.signal })
    controller.abort()

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('nao inicia fetch depois de pagehide no mesmo ciclo', async () => {
    const { events, fetch } = transport()
    const request = api('/dashboard')
    events.dispatchEvent(new Event('pagehide'))

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('preserva payload, sessao, resposta e remove listeners ao concluir', async () => {
    const { events, fetch } = transport()
    const remove = vi.spyOn(events, 'removeEventListener')
    const controller = new AbortController()
    const removeAbort = vi.spyOn(controller.signal, 'removeEventListener')

    await expect(api('/profile', { ...json('PUT', { name: 'Demo' }), signal: controller.signal })).resolves.toEqual({ saved: true })
    expect(fetch).toHaveBeenCalledWith('/api/profile', expect.objectContaining({
      method: 'PUT',
      body: '{"name":"Demo"}',
      credentials: 'include',
    }))
    expect(remove).toHaveBeenCalledWith('pagehide', expect.any(Function))
    expect(removeAbort).toHaveBeenCalledWith('abort', expect.any(Function))
    controller.abort()
    events.dispatchEvent(new Event('pagehide'))
    expect(fetch.mock.calls[0]?.[1].signal?.aborted).toBe(false)
  })

  it('preserva erros de validacao recebidos da API', async () => {
    transport()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'Entrada invalida' }), { status: 400 })))

    await expect(api('/profile')).rejects.toThrow('Entrada invalida')
  })

  it('preserva falha de rede e remove listeners ao rejeitar', async () => {
    const { events, fetch } = transport()
    const controller = new AbortController()
    const removePagehide = vi.spyOn(events, 'removeEventListener')
    const removeAbort = vi.spyOn(controller.signal, 'removeEventListener')
    fetch.mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(api('/dashboard', { signal: controller.signal })).rejects.toThrow(/servidor/)
    expect(removePagehide).toHaveBeenCalledWith('pagehide', expect.any(Function))
    expect(removeAbort).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('preserva resposta sem JSON quando nao ha cancelamento', async () => {
    const { fetch } = transport()
    fetch.mockResolvedValue(new Response(null, { status: 204 }))

    await expect(api('/profile', { method: 'DELETE' })).resolves.toBeNull()
  })

  it('trata cancelamento depois que a requisicao iniciou', async () => {
    const { fetch } = transport()
    fetch.mockImplementation(async (_url, options) => new Promise<Response>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))
    const controller = new AbortController()
    const request = api('/dashboard', { signal: controller.signal })
    await Promise.resolve()
    expect(fetch).toHaveBeenCalledTimes(1)
    controller.abort()

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
  })

  it.each([
    { status: 200, source: 'signal' },
    { status: 400, source: 'signal' },
    { status: 200, source: 'pagehide' },
    { status: 400, source: 'pagehide' },
  ])('preserva cancelamento durante leitura do corpo: $status, $source', async ({ status, source }) => {
    const { events, fetch } = transport()
    const controller = new AbortController()
    const removePagehide = vi.spyOn(events, 'removeEventListener')
    const removeAbort = vi.spyOn(controller.signal, 'removeEventListener')
    let reading!: () => void
    const startedReading = new Promise<void>((resolve) => { reading = resolve })
    fetch.mockImplementation(async (_url, options) => new Response(new ReadableStream({
      start(stream) {
        stream.enqueue(new TextEncoder().encode('{"saved":'))
        options.signal?.addEventListener('abort', () => {
          stream.error(new DOMException('Aborted', 'AbortError'))
        }, { once: true })
      },
      pull() { reading() },
    }), { status }))
    const request = api('/dashboard', { signal: controller.signal })
    await startedReading
    if (source === 'signal') controller.abort()
    else events.dispatchEvent(new Event('pagehide'))

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(removePagehide).toHaveBeenCalledWith('pagehide', expect.any(Function))
    expect(removeAbort).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})
