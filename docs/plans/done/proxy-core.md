# Proxy core implementation

## Goal

Implement the easy-proxy CLI so it does what README.md describes: load the JSON config, open one server per listener and forward each request to the route matching its `Host` header.

## Steps

1. `src/config.js`: load, validate and normalize the config. Route strings become `{ target, changeOrigin, secure }`. TLS paths resolve from the config file's directory and are read at load time, so errors show up at startup.
2. `src/proxy.js`: an HTTP/HTTPS server per listener.
   - Match the host without port and ignoring case, falling back to `default`, else 404.
   - Forward the method, path and body. Strip hop-by-hop headers and add `X-Forwarded-For/Proto/Host`.
   - Tunnel WebSocket and other `Upgrade` requests.
   - Answer 502 when an upstream fails, without crashing.
3. `src/index.js`: `startProxy(config)` starts all listeners and returns a `close()` for shutdown.
4. `src/cli.js`: parse `--config`, `--help` and `--version`, report bind errors in plain words, shut down on SIGINT/SIGTERM.
5. Tests in `tests/` for config validation and end-to-end proxying: HTTP, HTTPS, upgrade and error cases.

## Decisions

- New route option `secure` (default `true`). Setting it to `false` skips upstream TLS certificate checks, which HTTPS targets on `localhost` usually need. README and the example config document it.
- Duplicate listener ports and duplicate domains (compared case-insensitively) are config errors.
- Only Node built-ins are used, no dependencies.
