import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

describe('runtime React da interface web', () => {
  it('renderiza com as versoes instaladas de React e React DOM', () => {
    const html = renderToString(createElement('main', null, 'LinkAtletas'))
    expect(html).toBe('<main>LinkAtletas</main>')
  })
})
