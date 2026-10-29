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

    await expect(api('/profile', json('PUT', { name: 'Demo' }))).resolves.toEqual({ saved: true })
    expect(fetch).toHaveBeenCalledWith('/api/profile', expect.objectContaining({
      method: 'PUT',
      body: '{"name":"Demo"}',
      credentials: 'include',
    }))
    expect(remove).toHaveBeenCalledWith('pagehide', expect.any(Function))
  })

  it('preserva erros de validacao recebidos da API', async () => {
    transport()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'Entrada invalida' }), { status: 400 })))

    await expect(api('/profile')).rejects.toThrow('Entrada invalida')
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
})
