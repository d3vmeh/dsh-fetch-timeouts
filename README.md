# dsh-fetch-timeouts

Raises Node's HTTP timeouts for the whole [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) process, so a slow local model is not cut off after 5 minutes of silence.

## The problem it fixes

Node's built-in `fetch` (which dsh's model adapters use) gives up when a server sends no response headers for 300 seconds, or no body bytes for 300 seconds. dsh has no setting for those two timers: `streamIdleTimeoutMs` is dsh's own watchdog and `timeoutMs` is the SDK's request timer, so raising them changes the failure message from `pi-ai stream idle timeout` to `Failure reason: terminated` (`UND_ERR_BODY_TIMEOUT` / `UND_ERR_HEADERS_TIMEOUT`) at exactly 5:00.

Servers that stay silent that long include Ollama and LM Studio while a model thinks or generates a large tool call (for example the entire contents of a file for `write`), and any backend that does not send keepalive pings. llama.cpp's `llama-server` sends a ping every 30 seconds by default, so llama.cpp users usually do not need this plugin.

## Install

```
dsh plugin --profile web add dsh-fetch-timeouts
```

That is enough: the defaults raise both timeouts to 30 minutes. To change them, add to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: fetch-timeouts
  config:
    headersTimeoutMs: 3600000   # time allowed before response headers arrive; 0 disables
    bodyTimeoutMs: 3600000      # time allowed between body chunks; 0 disables
```

Restart `dsh web`. One line confirms it at startup:

```
fetch-timeouts: headers 1800000 ms, body 1800000 ms (process-wide)
```

Also raise dsh's own watchdog on the provider route, or it will fire first:

```yaml
llm-pi-ai:
  providers:
    ollama:
      streamIdleTimeoutMs: 1800000
      timeoutMs: 1800000
```

## What you should know

- It is process-wide. Every `fetch` that uses Node's global dispatcher (model calls, web search, HTTP MCP servers, cloud providers) gets the same longer limits; `web_fetch` is not affected because it builds its own per-request agent. A genuinely dead connection therefore takes up to the configured time to be noticed, and once you have raised `streamIdleTimeoutMs` as well, dsh's idle watchdog is the only remaining backstop for a hung model server. Reasonable on a single-user machine; think twice on a shared host.
- It works by installing an `undici` `Agent` as Node's global fetch dispatcher. If `NODE_USE_ENV_PROXY` is set it installs undici's proxy-aware agent instead, so `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` keep working. Tested on Node 22 with undici 8 (undici 8 requires Node 22.19 or newer). Confirmed by a user on Windows with Ollama on a 20 minute file write (discussion #4518).
- Loading the plugin's `undici` dependency already swaps Node's default dispatcher for undici's own (same 300 second defaults); the plugin then applies your timeouts. undici only installs its default when no global dispatcher exists yet, so another plugin loading undici later cannot replace the plugin's agent. Unloading the plugin returns to undici's default, not to Node's original object.
- It is a stopgap. When dsh exposes these timeouts itself (its pi-ai dependency already accepts a custom `fetch`), this plugin becomes unnecessary.

## License

MIT
