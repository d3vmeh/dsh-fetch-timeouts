import { afterEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { Agent, EnvHttpProxyAgent } from 'undici'
import { Config, apply, dispatcherClass } from '../src/index.js'

function fakeCtx() {
  const disposers = []
  const ctx = {
    effect: (setup, label) => { disposers.push(setup()) },
    logger: { info: vi.fn(), exporter: vi.fn() },
  }
  return { ctx, dispose: () => { for (const d of disposers.splice(0)) d() } }
}

const original = getGlobalDispatcher()
afterEach(() => { setGlobalDispatcher(original) })

describe('Config', () => {
  it('defaults both timeouts to 30 minutes and accepts 0', () => {
    expect(Config({})).toEqual({ headersTimeoutMs: 1800000, bodyTimeoutMs: 1800000 })
    expect(Config({ headersTimeoutMs: 0 }).headersTimeoutMs).toBe(0)
  })
  it('rejects negative and fractional values', () => {
    expect(() => Config({ bodyTimeoutMs: -1 })).toThrow()
    expect(() => Config({ headersTimeoutMs: 1.5 })).toThrow()
  })
})

describe('apply', () => {
  it('installs a global dispatcher with the configured timeouts and logs once', () => {
    const { ctx } = fakeCtx()
    apply(ctx, { headersTimeoutMs: 1234, bodyTimeoutMs: 5678 })
    expect(getGlobalDispatcher()).not.toBe(original)
    expect(ctx.logger.info).toHaveBeenCalledWith('fetch-timeouts: headers 1234 ms, body 5678 ms (process-wide)')
  })

  it('makes fetch wait past the old 5 minute default, then fail at the configured headers timeout', async () => {
    const server = http.createServer(() => {}).listen(0)   // never answers
    try {
      const { ctx, dispose } = fakeCtx()
      apply(ctx, { headersTimeoutMs: 800, bodyTimeoutMs: 800 })
      const t = Date.now()
      const error = await fetch(`http://127.0.0.1:${server.address().port}/`).catch((e) => e)
      expect(error.cause?.code).toBe('UND_ERR_HEADERS_TIMEOUT')
      expect(Date.now() - t).toBeGreaterThanOrEqual(750)
      expect(Date.now() - t).toBeLessThan(5000)
      dispose()
    } finally {
      server.close()
    }
  })

  it('applies the body timeout when the server sends headers and then goes silent', async () => {
    const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': hello\n') }).listen(0)
    try {
      const { ctx, dispose } = fakeCtx()
      apply(ctx, { headersTimeoutMs: 5000, bodyTimeoutMs: 800 })
      const t = Date.now()
      const res = await fetch(`http://127.0.0.1:${server.address().port}/`)
      const error = await res.text().catch((e) => e)
      expect(error.cause?.code).toBe('UND_ERR_BODY_TIMEOUT')
      expect(Date.now() - t).toBeGreaterThanOrEqual(750)
      expect(Date.now() - t).toBeLessThan(5000)
      dispose()
    } finally {
      server.close()
    }
  })

  it('restores the previous dispatcher on dispose', () => {
    const { ctx, dispose } = fakeCtx()
    apply(ctx, {})
    const installed = getGlobalDispatcher()
    expect(installed).not.toBe(original)
    dispose()
    expect(getGlobalDispatcher()).toBe(original)
  })

  it('leaves a later dispatcher in place when disposed out of order', async () => {
    const a = fakeCtx(); apply(a.ctx, {})
    const b = fakeCtx(); apply(b.ctx, {})
    const installedByB = getGlobalDispatcher()
    a.dispose()
    expect(getGlobalDispatcher()).toBe(installedByB)
    const server = http.createServer((req, res) => res.end('ok')).listen(0)
    try {
      expect(await (await fetch(`http://127.0.0.1:${server.address().port}/`)).text()).toBe('ok')
    } finally { server.close(); b.dispose() }
  })

  it('uses the env proxy agent only when NODE_USE_ENV_PROXY is set', () => {
    expect(dispatcherClass({})).toBe(Agent)
    expect(dispatcherClass({ NODE_USE_ENV_PROXY: '1' })).toBe(EnvHttpProxyAgent)
  })

  it('tolerates a null config', () => {
    const { ctx, dispose } = fakeCtx()
    expect(() => apply(ctx, null)).not.toThrow()
    dispose()
  })

  it('prints only its own log lines through the exporter', () => {
    const { ctx } = fakeCtx()
    apply(ctx, {})
    const [exporter] = ctx.logger.exporter.mock.calls[0]
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      exporter.export({ args: ['fetch-timeouts: x'] })
      exporter.export({ args: ['other: y'] })
      expect(log.mock.calls).toEqual([['fetch-timeouts: x']])
    } finally { log.mockRestore() }
  })
})
