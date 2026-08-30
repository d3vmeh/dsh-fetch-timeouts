import z from '@deepseek-ai/schemastery'
import { Agent, EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'

export const name = 'fetch-timeouts'
export const inject = []

const DEFAULT_MS = 30 * 60 * 1000

export const Config = z.object({
  headersTimeoutMs: z.number().step(1).min(0).default(DEFAULT_MS),
  bodyTimeoutMs: z.number().step(1).min(0).default(DEFAULT_MS),
})

/** Node honours HTTP_PROXY and friends only when NODE_USE_ENV_PROXY is set; keep that behaviour. */
export function dispatcherClass(env = process.env) {
  return env.NODE_USE_ENV_PROXY ? EnvHttpProxyAgent : Agent
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
    const previous = getGlobalDispatcher()
    const Dispatcher = dispatcherClass()
    const agent = new Dispatcher({ headersTimeout, bodyTimeout })
    setGlobalDispatcher(agent)
    ctx.logger.info(`fetch-timeouts: headers ${headersTimeout} ms, body ${bodyTimeout} ms (process-wide${Dispatcher === EnvHttpProxyAgent ? ', env proxy' : ''})`)
    return () => {
      // Only step back if nobody installed another dispatcher after us.
      if (getGlobalDispatcher() === agent) setGlobalDispatcher(previous)
      agent.close().catch(() => {})
    }
  }, 'fetch-timeouts: global dispatcher')
}
