# easy-proxy

A minimal command-line reverse proxy. It serves several services on one port and chooses the service from the domain in each request.

Point `example1.com` and `example2.com` at the same machine. easy-proxy listens on port 80 or 443, reads the `Host` header (or the TLS SNI name) and forwards each request to the right local service:

```
  example1.com       ─┐                        ┌─▶ http://localhost:8888
  example2.com       ─┼─▶ easy-proxy :80/:443 ─┼─▶ http://localhost:8889
  api.example.local  ─┘                        └─▶ http://localhost:4000
```

## Requirements

- Node.js 20 or newer
- Permission to bind the configured ports. Ports below 1024 need root or `CAP_NET_BIND_SERVICE` on Linux.

## Installation

```sh
git clone <repo-url> easy-proxy
cd easy-proxy
npm install
npm link        # makes the `easy-proxy` command available globally
```

## Usage

```sh
cp conf/config.example.json conf/config.json
# edit conf/config.json
easy-proxy
```

Options:

| Option                | Description                     | Default              |
| --------------------- | ------------------------------- | -------------------- |
| `-c, --config <path>` | Path to the configuration file  | `conf/config.json`   |
| `-h, --help`          | Show help                       |                      |
| `-v, --version`       | Show version                    |                      |

Without installing globally, run it with `npm start` or `node src/cli.js`.

## Configuration

The configuration is a JSON file. `conf/config.json` is ignored by git, so your real hosts and certificate paths stay out of the repository. `conf/config.example.json` is the committed template.

```json
{
  "listeners": [
    {
      "name": "http",
      "port": 80,
      "protocol": "http",
      "routes": {
        "example1.com": "http://localhost:8888",
        "example2.com": "http://localhost:8889",
        "api.example.local": {
          "target": "http://localhost:4000",
          "changeOrigin": true
        }
      },
      "default": null
    },
    {
      "name": "https",
      "port": 443,
      "protocol": "https",
      "tls": {
        "cert": "cert.pem",
        "key": "key.pem"
      },
      "routes": {
        "example1.com": "https://localhost:8888",
        "api.example.local": {
          "target": "https://localhost:4443",
          "changeOrigin": true,
          "secure": false
        }
      },
      "default": null
    }
  ]
}
```

### Listeners

Each entry in `listeners` opens one port.

| Field      | Type             | Description                                                                    |
| ---------- | ---------------- | ------------------------------------------------------------------------------ |
| `name`     | string           | Label used in logs. Defaults to `<protocol>:<port>`.                           |
| `port`     | number           | Port to listen on.                                                             |
| `protocol` | `"http"` \| `"https"` | Protocol the listener accepts.                                            |
| `tls`      | object           | Required when `protocol` is `"https"`: `cert` and `key` file paths (PEM). Relative paths resolve from the config file's directory. |
| `routes`   | object           | Maps a domain name to a route (see below).                                     |
| `default`  | route \| `null`  | Route for requests whose domain matches nothing. With `null`, those requests get `404 Not Found`. |

### Routes

A route is either a target URL string or an object:

| Field          | Type    | Description                                                                 |
| -------------- | ------- | --------------------------------------------------------------------------- |
| `target`       | string  | Upstream URL that requests are forwarded to. A path in the URL is prepended to the request path: with `http://localhost:4000/api`, a request for `/users` goes to `/api/users`. |
| `changeOrigin` | boolean | Rewrite the `Host` header to the target's host. Defaults to `false`, which forwards the original `Host`. |
| `secure`       | boolean | Verify the TLS certificate of an `https` target. Defaults to `true`. Set it to `false` for upstreams with self-signed certificates, such as local services on `https://localhost`. |

`"example1.com": "http://localhost:8888"` is shorthand for `"example1.com": { "target": "http://localhost:8888" }`.

Domains match the request's `Host` header without the port and ignore letter case. A domain listed twice in one listener, or two listeners on the same port, is a configuration error.

## Behavior

- Requests go to the upstream with their method, path, query and body unchanged. Connection-specific (hop-by-hop) headers are dropped.
- The upstream receives `X-Forwarded-For` (the client address, appended to any existing value), `X-Forwarded-Proto` (`http` or `https`) and `X-Forwarded-Host` (the original `Host`).
- WebSocket and other `Upgrade` requests are tunneled to the upstream.
- If the upstream can't be reached, the client gets `502 Bad Gateway` and the error is logged. The proxy keeps running.
- Each request is logged to stdout with its listener, domain, path, status and duration. Errors go to stderr.
- `Ctrl+C` (SIGINT) or SIGTERM closes all connections and exits. A second signal exits immediately.

## Development

```sh
npm test        # runs the test suite with node --test
```

Project layout:

```
conf/          configuration (config.example.json is committed, config.json is not)
docs/plans/    implementation plans (active/ and done/)
src/
  cli.js       CLI entry point: argument parsing, logging, signal handling
  config.js    loading, validating and normalizing the config file
  proxy.js     the per-listener HTTP/HTTPS server that forwards requests
  index.js     startProxy(): starts all listeners; also the module's public API
tests/         node:test suites; tests/fixtures holds a self-signed test certificate
```

## License

Licensed under the [GNU Lesser General Public License v3.0](COPYING.LESSER) (LGPL-3.0-only). The LGPL builds on the [GNU General Public License v3.0](COPYING), which is included as well.
