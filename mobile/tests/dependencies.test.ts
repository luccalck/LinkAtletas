import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const expoRequire = createRequire(require.resolve('expo/package.json'))
const configRequire = createRequire(expoRequire.resolve('@expo/config/package.json'))
const merge = configRequire('deepmerge')
const umdMerge = configRequire('deepmerge/dist/umd.js')
const { modifyConfigAsync } = expoRequire('@expo/config')
const cliRoot = dirname(expoRequire.resolve('@expo/cli/package.json'))
const { PluginSchema, DevToolsPluginOutputSchema } = require(join(cliRoot, 'build/src/start/server/DevToolsPlugin.schema.js'))
const { createMCPDevToolsExtensionSchema } = require(join(cliRoot, 'build/src/start/server/createMCPDevToolsExtensionSchema.js'))

describe('Expo dependency security', () => {
  it.each([null, undefined, 0, '', false])('preserves valid values alongside unsafe keys for placeholder %j', (placeholder) => {
    const source = JSON.parse('{"extra":{"valid":true,"__proto__":{"admin":true},"constructor":{"prototype":{"admin":true}},"prototype":{"admin":true}}}')

    for (const mergeEntry of [merge, umdMerge]) {
      const result = mergeEntry({ extra: placeholder }, source)
      expect(result.extra).toEqual({ valid: true })
      expect(result.extra.admin).toBeUndefined()
      expect(Object.getPrototypeOf(result.extra)).toBe(Object.prototype)
      for (const key of ['__proto__', 'constructor', 'prototype']) {
        expect(Object.hasOwn(result.extra, key)).toBe(false)
      }
    }
  })

  it.each([null, 0, '', false])('preserves Expo config updates and rejects poisoning for extra=%j', async (placeholder) => {
    const directory = await mkdtemp(join(tmpdir(), 'linkatletas-expo-config-'))
    const configPath = join(directory, 'app.json')
    const original = JSON.stringify({ expo: { name: 'demo', slug: 'demo', sdkVersion: '57.0.0', extra: placeholder } })
    try {
      await writeFile(join(directory, 'package.json'), '{"name":"demo","version":"1.0.0"}')
      await writeFile(configPath, original)
      const modifications = JSON.parse('{"extra":{"valid":true,"__proto__":{"admin":true}}}')
      const result = await modifyConfigAsync(directory, modifications, {}, { dryRun: true })

      expect(result.type).toBe('success')
      expect(result.config.extra).toEqual({ valid: true })
      expect(result.config.extra.admin).toBeUndefined()
      expect(Object.getPrototypeOf(result.config.extra)).toBe(Object.prototype)
      expect(await readFile(configPath, 'utf8')).toBe(original)
    } finally {
      if (resolve(dirname(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('linkatletas-expo-config-')) {
        throw new Error('Diretorio temporario fora do escopo do teste')
      }
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each([
    { session: null },
    { session: undefined },
    { session: 0 },
    { session: Object.create(null) },
    { session: JSON.parse('{"__proto__":{"admin":false}}') },
  ])('rejects a poisoned source for target %j', (target) => {
    const source = JSON.parse('{"session":{"__proto__":{"admin":true}}}')
    const result = merge(target, source)

    expect(result.session.admin).toBeUndefined()
    expect(Object.getPrototypeOf(result.session)).toBe(Object.prototype)
    expect(Object.hasOwn(result.session, '__proto__')).toBe(false)
    expect(({} as Record<string, unknown>).admin).toBeUndefined()
  })

  it('rejects unsafe keys copied from the target and the source', () => {
    const payload = JSON.parse('{"__proto__":{"admin":true},"constructor":{"prototype":{"admin":true}},"prototype":{"admin":true},"name":"demo"}')

    for (const result of [merge(payload, {}), merge({}, payload)]) {
      expect(result).toEqual({ name: 'demo' })
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
      for (const key of ['__proto__', 'constructor', 'prototype']) {
        expect(Object.hasOwn(result, key)).toBe(false)
      }
    }
  })

  it('preserves nested config, array concatenation, symbols and input values', () => {
    const symbol = Symbol('config')
    const target = { plugins: ['a'], android: { package: 'app.demo' }, [symbol]: 1 }
    const source = { plugins: ['b'], android: { versionCode: 2 } }

    expect(merge(target, source)).toEqual({
      plugins: ['a', 'b'],
      android: { package: 'app.demo', versionCode: 2 },
      [symbol]: 1,
    })
    expect(target.plugins).toEqual(['a'])
    expect(source.plugins).toEqual(['b'])
  })

  it('protects the published UMD entry point', () => {
    const result = umdMerge({ session: null }, JSON.parse('{"session":{"__proto__":{"admin":true}}}'))

    expect(result.session.admin).toBeUndefined()
    expect(Object.getPrototypeOf(result.session)).toBe(Object.prototype)
  })

  it('keeps Expo plugin validation and MCP schemas compatible with patched Zod', () => {
    const plugin = {
      packageName: 'demo-plugin',
      packageRoot: '/demo',
      cliExtensions: {
        description: 'Demo',
        entryPoint: './index.js',
        commands: [{
          name: 'check',
          title: 'Check',
          environments: ['cli', 'mcp'],
          parameters: [
            { name: 'label', type: 'text' },
            { name: 'count', type: 'number' },
            { name: 'confirm', type: 'confirm' },
          ],
        }],
      },
    }

    expect(PluginSchema.safeParse(plugin).success).toBe(true)
    expect(PluginSchema.safeParse({ ...plugin, packageName: '' }).success).toBe(false)
    expect(DevToolsPluginOutputSchema.safeParse([{ type: 'text', text: 'ok', level: 'info' }]).success).toBe(true)
    expect(DevToolsPluginOutputSchema.safeParse([{ type: 'image', url: 'invalid' }]).success).toBe(false)

    const schema = createMCPDevToolsExtensionSchema(plugin)
    expect(schema.safeParse({ command: 'check', label: 'demo', count: 2, confirm: true }).success).toBe(true)
    expect(schema.safeParse({ command: 'unknown' }).success).toBe(false)
    expect(schema.safeParse({ command: 'check', count: 'invalid' }).success).toBe(false)
  })
})
