import { expect, test, type Page, type BrowserContext } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const directory = path.resolve(
  process.env.EVIDENCE_DIR || 'docs/evidencias/web',
)
const password = 'SenhaTeste123!'
async function login(page: Page, email: string, pass = password) {
  await page.goto('/login')
  await page.getByLabel('E-mail', { exact: true }).fill(email)
  await page.getByLabel('Senha', { exact: true }).fill(pass)
  await page
    .getByRole('button', { name: 'Entrar na plataforma', exact: true })
    .click()
  await expect(page).not.toHaveURL(/\/login/)
}
async function api(
  context: BrowserContext,
  baseURL: string,
  method: string,
  endpoint: string,
  data?: unknown,
) {
  const response = await context.request.fetch(`${baseURL}/api${endpoint}`, {
    method,
    headers: { origin: baseURL },
    ...(data === undefined ? {} : { data }),
  })
  expect(response.status(), await response.text()).toBeLessThan(300)
  return response.json()
}
test('chat ao vivo → agenda → avaliação → consentimento e mídia → financeiro', async ({
  browser,
  baseURL,
}, info) => {
  const athleteContext = await browser.newContext({ baseURL, reducedMotion: 'reduce' }),
    coachContext = await browser.newContext({ baseURL, reducedMotion: 'reduce' })
  const athlete = await athleteContext.newPage(),
    coach = await coachContext.newPage(),
    errors: string[] = []
  for (const page of [athlete, coach])
    page.on('pageerror', (e) => errors.push(e.message))
  const unique = `${info.project.name}-${Date.now()}`,
    email = `expansion-${unique}@e2e.local`
  try {
    // Deliver StrictMode's discarded connection close after the live socket opens.
    // The stale event must not change the visible status of the active connection.
    await coach.addInitScript(() => {
      const state = window as Window & { lateClosedSocketDelivered?: boolean }
      const pending: Array<() => void> = []
      let first: WebSocket | undefined
      let live: WebSocket | undefined
      window.WebSocket = new Proxy(window.WebSocket, {
        construct(target, args) {
          const socket = Reflect.construct(target, args) as WebSocket
          if (!String(args[0]).endsWith('/api/events')) return socket
          const discarded = !first
          if (discarded) first = socket
          let queued = false
          let onclose:
            | ((this: WebSocket, event: CloseEvent) => unknown)
            | null = null
          Object.defineProperty(socket, 'onclose', {
            get: () => onclose,
            set: (handler) => {
              onclose = handler
            },
          })
          const close = socket.close.bind(socket)
          socket.close = (...parameters: Parameters<WebSocket['close']>) => {
            if (discarded && !queued) {
              queued = true
              // WebKit may omit `close` when CONNECTING is aborted. Inject the
              // stale callback explicitly while keeping both real connections.
              const deliver = () => {
                onclose?.call(socket, new CloseEvent('close', { code: 1000 }))
                state.lateClosedSocketDelivered = true
              }
              if (live && live !== socket) setTimeout(deliver, 0)
              else pending.push(deliver)
            }
            close(...parameters)
          }
          socket.addEventListener('close', (event) => {
            if (!discarded) onclose?.call(socket, event)
          })
          socket.addEventListener('open', () => {
            live = socket
            if (!discarded)
              setTimeout(() => pending.splice(0).forEach((deliver) => deliver()), 0)
          })
          return socket
        },
      })
    })
    await api(athleteContext, baseURL!, 'POST', '/auth/register', {
      name: `Atleta ${unique}`,
      email,
      password,
      role: 'athlete',
    })
    await api(athleteContext, baseURL!, 'PUT', '/profiles/me', {
      name: `Atleta ${unique}`,
      city: 'Joinville, SC',
      bio: 'Teste ampliado fictício',
      sports: ['Corrida'],
      goals: ['Performance'],
      levels: ['Intermediário'],
      availability: ['Segunda noite'],
      mode: 'online',
      budget: 250,
      price: 0,
    })
    await login(coach, 'emailtreinador@email.com', 'senhatreinador')
    const coachId = (await api(coachContext, baseURL!, 'GET', '/auth/session'))
      .user.id
    const contract = (
      await api(athleteContext, baseURL!, 'POST', '/contracts', { coachId })
    ).contract
    await api(coachContext, baseURL!, 'PATCH', `/contracts/${contract.id}`, {
      status: 'active',
    })
    const workout = (
      await api(coachContext, baseURL!, 'POST', '/workouts', {
        contractId: contract.id,
        title: `Treino ${unique}`,
        sport: 'Corrida',
        scheduledDate: new Date().toISOString().slice(0, 10),
        instructions: 'Teste de mídia',
        status: 'published',
        blocks: [
          {
            name: 'Corrida leve',
            instructions: 'Ritmo confortável',
            durationMinutes: 5,
          },
        ],
      })
    ).workout
    await athlete.goto(`/atleta/mensagens?vinculo=${contract.id}`)
    await coach.goto(`/treinador/mensagens?vinculo=${contract.id}`)
    await expect
      .poll(() =>
        coach.evaluate(() =>
          (window as Window & { lateClosedSocketDelivered?: boolean })
            .lateClosedSocketDelivered,
        ),
      )
      .toBe(true)
    await expect(coach.getByText('Conectado', { exact: true })).toBeVisible()
    await athlete.getByLabel('Sua mensagem').fill(`Mensagem ao vivo ${unique}`)
    await athlete
      .getByRole('button', { name: 'Enviar mensagem', exact: true })
      .click()
    await expect(
      coach.getByText(`Mensagem ao vivo ${unique}`, { exact: true }),
    ).toBeVisible()
    await coach.getByLabel('Sua mensagem').fill(`Orientação recebida ${unique}`)
    await coach
      .getByRole('button', { name: 'Enviar mensagem', exact: true })
      .click()
    await expect(
      athlete.getByText(`Orientação recebida ${unique}`, { exact: true }),
    ).toBeVisible()
    await expect(
      coach.locator('article').filter({ hasText: `Orientação recebida ${unique}` }).getByText(/Lida/),
    ).toBeVisible()
    await athlete.waitForLoadState('networkidle')
    await athlete.reload()
    await expect(
      athlete.getByText(`Mensagem ao vivo ${unique}`, { exact: true }),
    ).toBeVisible()
    await mkdir(directory, { recursive: true })
    await athlete.screenshot({
      path: path.join(directory, `${info.project.name}-chat.png`),
      fullPage: true,
      animations: 'disabled',
    })
    await athlete.goto('/atleta/agenda')
    await athlete
      .getByRole('combobox', { name: /Vínculo/ })
      .selectOption(contract.id)
    await athlete
      .getByLabel('Título', { exact: true })
      .fill(`Consultoria ${unique}`)
    await athlete
      .getByLabel('Objetivo do encontro')
      .fill('Avaliar evolução de forma privada.')
    // Separate deterministic future dates per browser avoid conflicts of a shared fixture coach.
    const hour =
      info.project.name === 'chromium'
        ? 10
        : info.project.name === 'firefox'
          ? 12
          : 14
    const existing = (
      await api(coachContext, baseURL!, 'GET', '/consultations')
    ).consultations
    let appointment = new Date(`2027-03-15T${hour}:00:00`)
    while (
      existing.some(
        (c: any) =>
          c.status === 'scheduled' &&
          Math.abs(new Date(c.startsAt).getTime() - appointment.getTime()) <
            3 * 3600000,
      )
    )
      appointment = new Date(appointment.getTime() + 86400000)
    const localStart = new Date(
      appointment.getTime() - appointment.getTimezoneOffset() * 60000,
    )
      .toISOString()
      .slice(0, 16)
    await athlete.getByLabel('Data e horário').fill(localStart)
    await athlete
      .getByRole('button', { name: 'Agendar consultoria', exact: true })
      .click()
    await expect(
      athlete.getByText('Consultoria agendada.', { exact: true }),
    ).toBeVisible()
    await coach.goto('/treinador/agenda')
    await expect(
      coach.getByRole('heading', {
        name: `Consultoria ${unique}`,
        exact: true,
      }),
    ).toBeVisible()
    await athlete.goto('/atleta/avaliacoes')
    await athlete
      .getByRole('combobox', { name: /Treinador/ })
      .selectOption(contract.id)
    await athlete
      .getByLabel('Sua experiência')
      .fill(`Avaliação demonstrativa ${unique}`)
    await athlete
      .getByRole('button', { name: 'Publicar avaliação', exact: true })
      .click()
    await expect(
      athlete.getByText('Avaliação salva.', { exact: true }),
    ).toBeVisible()
    await athlete.goto('/atleta/privacidade')
    await athlete
      .getByRole('checkbox', { name: /Informações de saúde/ })
      .check()
    await athlete.getByLabel('Altura (cm)').fill('180')
    await athlete.getByLabel('Peso (kg)').fill('80')
    await athlete
      .getByLabel('Observações privadas')
      .fill(`Saúde fictícia ${unique}`)
    await athlete
      .getByRole('button', { name: 'Salvar informações privadas', exact: true })
      .click()
    await expect(
      athlete.getByText('Informações privadas salvas.', { exact: true }),
    ).toBeVisible()
    await athlete
      .getByRole('checkbox', { name: /Vídeos e dados de performance/ })
      .check()
    await expect(athlete.getByText(/Prefer.ncia de privacidade atualizada/)).toBeVisible()
    await athlete.goto(`/atleta/treino`)
    await athlete
      .getByRole('combobox', { name: /Treino selecionado/ })
      .selectOption(workout.id)
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9uoAAAAASUVORK5CYII=',
      'base64',
    )
    await athlete
      .getByLabel('Arquivo privado', { exact: true })
      .setInputFiles({
        name: 'performance.png',
        mimeType: 'image/png',
        buffer: Buffer.concat([bytes, Buffer.alloc(5 * 1024 * 1024)]),
      })
    await athlete.getByRole('button', { name: /Enviar arquivo/ }).click()
    await expect(
      athlete.getByText('Arquivo enviado com sucesso.', { exact: true }),
    ).toBeVisible()
    await expect(
      athlete.getByRole('link', { name: 'performance.png', exact: true }),
    ).toBeVisible()
    await athlete.goto('/atleta/financeiro')
    await expect(athlete.getByText(/Modo acadêmico/).first()).toBeVisible()
    await expect(athlete.getByText(/Nenhum pagamento/).first()).toBeVisible()
    expect(errors).toEqual([])
  } finally {
    await athleteContext.close()
    await coachContext.close()
  }
})
test('recuperação pela interface usa SMTP local e permite senha nova', async ({
  page,
  baseURL,
}, info) => {
  const email = `recovery-${info.project.name}-${Date.now()}@e2e.local`
  await api(page.context(), baseURL!, 'POST', '/auth/register', {
    name: 'Recuperação teste',
    email,
    password,
    role: 'athlete',
  })
  await api(page.context(), baseURL!, 'POST', '/auth/logout', {})
  await page.goto('/recuperar-senha')
  await page.getByLabel('E-mail', { exact: true }).fill(email)
  await page.getByRole('button', { name: /Enviar instruções/ }).click()
  await expect(page.getByText(/Se o e-mail estiver cadastrado/)).toBeVisible()
  let token = ''
  await expect
    .poll(
      async () => {
        const listing = (await (
          await fetch('http://127.0.0.1:8025/api/v1/messages')
        ).json()) as any
        const item = listing.messages.find((m: any) =>
          m.To.some((to: any) => to.Address === email),
        )
        if (item) {
          const message = (await (
            await fetch(`http://127.0.0.1:8025/api/v1/message/${item.ID}`)
          ).json()) as any
          token = message.Text.match(/token=([a-f0-9]{64})/)[1]
        }
        return !!token
      },
      { timeout: 15000 },
    )
    .toBe(true)
  await page.goto(`/redefinir-senha#token=${token}`)
  await page
    .getByLabel('Nova senha', { exact: true })
    .fill('SenhaRedefinida123!')
  await page
    .getByLabel('Repita a nova senha', { exact: true })
    .fill('SenhaRedefinida123!')
  await page
    .getByRole('button', { name: /Alterar senha|Salvar nova senha/ })
    .click()
  await expect(page.getByText(/Senha alterada/)).toBeVisible()
  await login(page, email, 'SenhaRedefinida123!')
})
test('telas ampliadas têm acesso por teclado, responsividade e auditoria axe', async ({
  page,
}, info) => {
  await login(page, 'emailatleta@email.com', 'senhaatleta')
  const audits = []
  for (const route of [
    'mensagens',
    'agenda',
    'avaliacoes',
    'financeiro',
    'notificacoes',
    'privacidade',
  ]) {
    await page.goto(`/atleta/${route}`)
    await page.waitForLoadState('networkidle')
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    audits.push({
      route,
      violations: result.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        description: v.description,
        nodes: v.nodes.map((n) => ({
          target: n.target,
          summary: n.failureSummary,
        })),
      })),
      passes: result.passes.length,
    })
    await page.setViewportSize({ width: 390, height: 844 })
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
      )
      .toBe(true)
    await page.screenshot({
      path: path.join(directory, `${info.project.name}-${route}-mobile.png`),
      fullPage: true,
      animations: 'disabled',
    })
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe(
      'BODY',
    )
    await page.setViewportSize({ width: 1440, height: 1000 })
  }
  await mkdir(directory, { recursive: true })
  await writeFile(
    path.join(directory, `${info.project.name}-axe.json`),
    JSON.stringify(audits, null, 2),
  )
  expect(audits.flatMap((a) => a.violations)).toEqual([])
})
