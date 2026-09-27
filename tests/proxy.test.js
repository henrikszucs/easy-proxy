import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { once } from "node:events";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeConfig } from "../src/config.js";
import { startProxy } from "../src/index.js";
import { hostnameFromHostHeader } from "../src/proxy.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const tls = {
    cert: readFileSync(path.join(fixturesDir, "cert.pem")),
    key: readFileSync(path.join(fixturesDir, "key.pem")),
};

/**
 * Starts an upstream that answers every request with a JSON description of
 * it. "Upgrade: echo" requests become a tunnel that echoes its input; other
 * upgrades are refused with 403.
 */
async function startUpstream(t, { name = "upstream", protocol = "http" } = {}) {
    const onRequest = (req, res) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json", "x-upstream": name });
            res.end(JSON.stringify({
                name,
                method: req.method,
                url: req.url,
                headers: req.headers,
                body: Buffer.concat(chunks).toString(),
            }));
        });
    };
    const server = protocol === "https" ? https.createServer(tls, onRequest) : http.createServer(onRequest);

    server.on("upgrade", (req, socket) => {
        if (req.headers.upgrade === "echo") {
            socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n");
            socket.pipe(socket);
        } else {
            socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 5\r\n\r\nnope\n");
        }
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    return `${protocol}://127.0.0.1:${server.address().port}`;
}

/** Starts the proxy with the given raw listeners and returns their ports. */
async function startTestProxy(t, listeners) {
    const config = normalizeConfig({ listeners });
    for (const listener of config.listeners) {
        if (listener.tls) {
            listener.tls = tls;
        }
    }
    const proxy = await startProxy(config);
    t.after(() => proxy.close());
    return { proxy, ports: proxy.servers.map((server) => server.address().port) };
}

async function startHttpProxy(t, overrides) {
    const { proxy, ports } = await startTestProxy(t, [{ port: 0, protocol: "http", ...overrides }]);
    return { proxy, port: ports[0] };
}

function request({ port, protocol = "http", host, method = "GET", path = "/", headers = {}, body }) {
    return new Promise((resolve, reject) => {
        const client = protocol === "https" ? https : http;
        const req = client.request({
            hostname: "127.0.0.1",
            port,
            method,
            path,
            headers: host === undefined ? headers : { host, ...headers },
            rejectUnauthorized: false,
            agent: false,
        }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString();
                const json = res.headers["content-type"] === "application/json" ? JSON.parse(text) : null;
                resolve({ status: res.statusCode, headers: res.headers, text, json });
            });
        });
        req.on("error", reject);
        req.end(body);
    });
}

function upgradeRequest({ port, host, protocol = "echo" }) {
    const req = http.request({
        hostname: "127.0.0.1",
        port,
        headers: { host, connection: "Upgrade", upgrade: protocol },
        agent: false,
    });
    req.end();
    return req;
}

async function unusedPort() {
    const server = http.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address();
    server.close();
    await once(server, "close");
    return port;
}

describe("hostnameFromHostHeader", () => {
    it("drops the port and lowercases", () => {
        assert.equal(hostnameFromHostHeader("Example1.COM:8080"), "example1.com");
        assert.equal(hostnameFromHostHeader("example1.com"), "example1.com");
    });

    it("keeps bracketed IPv6 addresses intact", () => {
        assert.equal(hostnameFromHostHeader("[::1]:8080"), "[::1]");
        assert.equal(hostnameFromHostHeader("[::1]"), "[::1]");
    });
});

describe("proxy", () => {
    it("routes requests by domain", async (t) => {
        const one = await startUpstream(t, { name: "one" });
        const two = await startUpstream(t, { name: "two" });
        const { port } = await startHttpProxy(t, { routes: { "example1.com": one, "example2.com": two } });

        assert.equal((await request({ port, host: "example1.com" })).json.name, "one");
        assert.equal((await request({ port, host: "example2.com" })).json.name, "two");
    });

    it("matches domains ignoring case and port", async (t) => {
        const upstream = await startUpstream(t);
        const { port } = await startHttpProxy(t, { routes: { "example1.com": upstream } });

        const res = await request({ port, host: "EXAMPLE1.com:8080" });

        assert.equal(res.status, 200);
    });

    it("answers 404 for an unknown domain without a default", async (t) => {
        const upstream = await startUpstream(t);
        const { port } = await startHttpProxy(t, { routes: { "example1.com": upstream } });

        const res = await request({ port, host: "unknown.test" });

        assert.equal(res.status, 404);
        assert.equal(res.text, "404 Not Found\n");
    });

    it("sends unknown domains to the default route", async (t) => {
        const upstream = await startUpstream(t, { name: "fallback" });
        const { port } = await startHttpProxy(t, { default: upstream });

        assert.equal((await request({ port, host: "unknown.test" })).json.name, "fallback");
    });

    it("forwards method, path, body and response headers", async (t) => {
        const upstream = await startUpstream(t, { name: "one" });
        const { port } = await startHttpProxy(t, { routes: { "example1.com": upstream } });

        const res = await request({ port, host: "example1.com", method: "POST", path: "/submit?x=1", body: "hello" });

        assert.equal(res.json.method, "POST");
        assert.equal(res.json.url, "/submit?x=1");
        assert.equal(res.json.body, "hello");
        assert.equal(res.headers["x-upstream"], "one");
    });

    it("prefixes the target's path", async (t) => {
        const upstream = await startUpstream(t);
        const { port } = await startHttpProxy(t, { routes: { "example1.com": `${upstream}/base/` } });

        assert.equal((await request({ port, host: "example1.com", path: "/page?q=1" })).json.url, "/base/page?q=1");
    });

    it("keeps the original Host and adds X-Forwarded headers", async (t) => {
        const upstream = await startUpstream(t);
        const { port } = await startHttpProxy(t, { routes: { "example1.com": upstream } });

        const { headers } = (await request({ port, host: "example1.com", headers: { "x-forwarded-for": "10.0.0.1" } })).json;

        assert.equal(headers.host, "example1.com");
        assert.equal(headers["x-forwarded-host"], "example1.com");
        assert.equal(headers["x-forwarded-proto"], "http");
        assert.match(headers["x-forwarded-for"], /^10\.0\.0\.1, .*127\.0\.0\.1$/);
    });

    it("rewrites Host with changeOrigin", async (t) => {
        const upstream = await startUpstream(t);
        const { port } = await startHttpProxy(t, { routes: { "example1.com": { target: upstream, changeOrigin: true } } });

        const { headers } = (await request({ port, host: "example1.com" })).json;

        assert.equal(headers.host, new URL(upstream).host);
        assert.equal(headers["x-forwarded-host"], "example1.com");
    });

    it("drops hop-by-hop headers", async (t) => {
        const upstream = await startUpstream(t);
        const { port } = await startHttpProxy(t, { routes: { "example1.com": upstream } });

        const { headers } = (await request({
            port,
            host: "example1.com",
            headers: { "connection": "x-private", "x-private": "1", "proxy-authorization": "secret", "x-kept": "1" },
        })).json;

        assert.equal(headers["x-private"], undefined);
        assert.equal(headers["proxy-authorization"], undefined);
        assert.equal(headers["x-kept"], "1");
    });

    it("answers 502 when the upstream is down", async (t) => {
        const { port } = await startHttpProxy(t, { routes: { "example1.com": `http://127.0.0.1:${await unusedPort()}` } });

        const res = await request({ port, host: "example1.com" });

        assert.equal(res.status, 502);
        assert.equal(res.text, "502 Bad Gateway\n");
    });

    it("serves HTTPS listeners", async (t) => {
        const upstream = await startUpstream(t);
        const { ports } = await startTestProxy(t, [{
            port: 0,
            protocol: "https",
            tls: { cert: "cert.pem", key: "key.pem" },
            routes: { "example1.com": upstream },
        }]);

        const res = await request({ port: ports[0], protocol: "https", host: "example1.com" });

        assert.equal(res.status, 200);
        assert.equal(res.json.headers["x-forwarded-proto"], "https");
    });

    it("verifies HTTPS upstream certificates unless secure is false", async (t) => {
        const upstream = await startUpstream(t, { protocol: "https" });
        const { port } = await startHttpProxy(t, {
            routes: {
                "strict.test": upstream,
                "insecure.test": { target: upstream, secure: false },
            },
        });

        assert.equal((await request({ port, host: "strict.test" })).status, 502);
        assert.equal((await request({ port, host: "insecure.test" })).status, 200);
    });

    it("tunnels upgraded connections", async (t) => {
        const upstream = await startUpstream(t);
        const { port } = await startHttpProxy(t, { routes: { "example1.com": upstream } });

        const [res, socket] = await once(upgradeRequest({ port, host: "example1.com" }), "upgrade");
        t.after(() => socket.destroy());
        socket.write("ping");
        const [data] = await once(socket, "data");

        assert.equal(res.statusCode, 101);
        assert.equal(data.toString(), "ping");
    });

    it("relays a refused upgrade", async (t) => {
        const upstream = await startUpstream(t);
        const { port } = await startHttpProxy(t, { routes: { "example1.com": upstream } });

        const [res] = await once(upgradeRequest({ port, host: "example1.com", protocol: "other" }), "response");
        res.resume();

        assert.equal(res.statusCode, 403);
    });

    it("answers 404 to an upgrade for an unknown domain", async (t) => {
        const { port } = await startHttpProxy(t, {});

        const [res] = await once(upgradeRequest({ port, host: "unknown.test" }), "response");
        res.resume();

        assert.equal(res.statusCode, 404);
    });

    it("closes open tunnels on shutdown", async (t) => {
        const upstream = await startUpstream(t);
        const { proxy, port } = await startHttpProxy(t, { routes: { "example1.com": upstream } });
        const [, socket] = await once(upgradeRequest({ port, host: "example1.com" }), "upgrade");
        socket.on("error", () => {});

        await proxy.close();

        if (!socket.destroyed) {
            await once(socket, "close");
        }
    });

    it("reports a port that is already in use", async (t) => {
        const { port } = await startHttpProxy(t, { name: "first" });
        const config = normalizeConfig({ listeners: [{ name: "second", port, protocol: "http" }] });

        await assert.rejects(startProxy(config), /listener "second": port \d+ is already in use/);
    });
});
