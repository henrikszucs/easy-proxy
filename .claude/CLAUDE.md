# easy-proxy

Minimal command-line reverse proxy. It serves several services on one port and picks the upstream from the request's domain (`Host` header / TLS SNI). See [README.md](../README.md) for the user-facing description and the config format.

## Commands

- `npm start`: run the proxy (`node src/cli.js`)
- `npm test`: run tests (`node --test`)
- `node src/cli.js --config <path>`: run with a specific config file

## Layout

- `src/cli.js`: CLI entry point (the `easy-proxy` bin in package.json). Must start with `#!/usr/bin/env node`.
- `src/config.js`: loads, validates and normalizes the config (throws `ConfigError`)
- `src/proxy.js`: per-listener HTTP/HTTPS server: routing, forwarding, upgrade tunnels
- `src/index.js`: `startProxy(config)` plus the public exports
- `tests/fixtures/`: self-signed test certificate (not a secret)
- `tests/`: tests using the built-in `node:test` runner and `node:assert`
- `conf/config.example.json`: committed config template
- `conf/config.json`: real local config. It is gitignored: never commit it and never put real hosts or secrets in the example.
- `docs/plans/active/`, `docs/plans/done/`: implementation plans

## Conventions

- Code style: double quotes for strings, 4-space indentation, semicolons.
- Node.js >= 20, ES modules (`"type": "module"`), `import`/`export` only.
- Keep it minimal: prefer Node built-ins (`node:http`, `node:https`, `node:net`, `node:tls`, `node:util` `parseArgs`) over dependencies. Add a dependency only when a built-in is clearly not enough, and say why.
- Config shape is documented in README.md. When you change the config format, update README.md and `conf/config.example.json` in the same change.
- Route values are either a target URL string or `{ "target", "changeOrigin", "secure" }`. Normalize the string form into the object form when loading the config.
- Relative TLS `cert`/`key` paths resolve from the config file's directory.
- Domain matching strips the port and ignores case.
- Errors from upstreams must not crash the process: answer `502 Bad Gateway` and log the error.

## Plans

For non-trivial work, write a plan first as `docs/plans/active/<short-name>.md` (goal, steps, open questions). Update it as work progresses. When the work is finished, move the file to `docs/plans/done/`.
