import z from '@deepseek-ai/schemastery'
import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'

export const name = 'fetch-timeouts'
export const inject = []

const DEFAULT_MS = 30 * 60 * 1000

export const Config = z.object({
  headersTimeoutMs: z.number().step(1).min(0).default(DEFAULT_MS),
  bodyTimeoutMs: z.number().step(1).min(0).default(DEFAULT_MS),
})

/** Node honours HTTP_PROXY and friends only when NODE_USE_ENV_PROXY is set; keep that behaviour. */
export function envProxyAgent(env, options) {
  return env.NODE_USE_ENV_PROXY ? new EnvHttpProxyAgent(options) : undefined
}

/** The same dispatcher, with our timeouts on every request that does not set its own. */
export function withTimeouts(dispatcher, headersTimeout, bodyTimeout) {
  const dispatch = (opts, handler) => dispatcher.dispatch({
    ...opts,
    headersTimeout: opts.headersTimeout ?? headersTimeout,
    bodyTimeout: opts.bodyTimeout ?? bodyTimeout,
  }, handler)
  return new Proxy(dispatcher, { get: (target, key) => key === 'dispatch' ? dispatch : target[key] })
}

export function apply(ctx, config = {}) {
  const headersTimeout = config?.headersTimeoutMs ?? DEFAULT_MS
  const bodyTimeout = config?.bodyTimeoutMs ?? DEFAULT_MS

  // The dsh host keeps plugin logs in memory only; print just this plugin's lines.
  ctx.logger.exporter({
    export: (message) => {
      const line = message.args[0]
      if (typeof line === 'string' && line.startsWith('fetch-timeouts:')) console.log(line)
    },
  })

  ctx.effect(() => {
    // Node's built-in fetch and npm undici share one global dispatcher. Going through
    // setGlobalDispatcher (not the raw global symbol) keeps Node's fetch compatible.
    // dsh 0.2 installs its own proxy router there before plugins mount, so wrap whatever
    // is installed instead of replacing it.
    const previous = getGlobalDispatcher()
    const own = envProxyAgent(process.env, { headersTimeout, bodyTimeout })
    const agent = withTimeouts(own ?? previous, headersTimeout, bodyTimeout)
    setGlobalDispatcher(agent)
    ctx.logger.info(`fetch-timeouts: headers ${headersTimeout} ms, body ${bodyTimeout} ms (process-wide${own ? ', env proxy' : ''})`)
    return () => {
      // Only step back if nobody installed another dispatcher after us.
      if (getGlobalDispatcher() === agent) setGlobalDispatcher(previous)
      own?.close().catch(() => {})
    }
  }, 'fetch-timeouts: global dispatcher')
}
