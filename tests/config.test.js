import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ConfigError, loadConfig, normalizeConfig } from "../src/config.js";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(testsDir, "..");
const fixturesDir = path.join(testsDir, "fixtures");

function httpListener(overrides = {}) {
    return { port: 8080, protocol: "http", routes: {}, ...overrides };
}

function normalizeListeners(...listeners) {
    return normalizeConfig({ listeners }, "/etc/easy-proxy");
}

describe("normalizeConfig", () => {
    it("accepts the example config", () => {
        const raw = JSON.parse(readFileSync(path.join(rootDir, "conf/config.example.json"), "utf8"));
        const config = normalizeConfig(raw, path.join(rootDir, "conf"));

        assert.equal(config.listeners.length, 2);
        assert.equal(config.listeners[1].tls.cert, path.join(rootDir, "conf/cert.pem"));
    });

    it("expands a target string into a route object", () => {
        const { listeners } = normalizeListeners(httpListener({ routes: { "example1.com": "http://localhost:8888" } }));
        const route = listeners[0].routes.get("example1.com");

        assert.equal(route.target.href, "http://localhost:8888/");
        assert.equal(route.changeOrigin, false);
        assert.equal(route.secure, true);
    });

    it("keeps route options", () => {
        const { listeners } = normalizeListeners(httpListener({
            routes: { "api.example.local": { target: "https://localhost:4443", changeOrigin: true, secure: false } },
        }));
        const route = listeners[0].routes.get("api.example.local");

        assert.equal(route.changeOrigin, true);
        assert.equal(route.secure, false);
    });

    it("lowercases domains and removes a trailing dot", () => {
        const { listeners } = normalizeListeners(httpListener({ routes: { "Example1.COM.": "http://localhost:8888" } }));

        assert.deepEqual([...listeners[0].routes.keys()], ["example1.com"]);
    });

    it("defaults the name, routes and default route", () => {
        const { listeners } = normalizeListeners({ port: 80, protocol: "http" });

        assert.equal(listeners[0].name, "http:80");
        assert.equal(listeners[0].routes.size, 0);
        assert.equal(listeners[0].default, null);
    });

    it("normalizes the default route", () => {
        const { listeners } = normalizeListeners(httpListener({ default: "http://localhost:9000" }));

        assert.equal(listeners[0].default.target.href, "http://localhost:9000/");
    });

    it("resolves TLS paths from the base directory", () => {
        const { listeners } = normalizeListeners({
            port: 443,
            protocol: "https",
            tls: { cert: "cert.pem", key: "/abs/key.pem" },
        });

        assert.equal(listeners[0].tls.cert, path.resolve("/etc/easy-proxy/cert.pem"));
        assert.equal(listeners[0].tls.key, path.resolve("/abs/key.pem"));
    });

    const invalidCases = [
        ["a non-object config", null, /must be a JSON object/],
        ["missing listeners", {}, /non-empty array/],
        ["empty listeners", { listeners: [] }, /non-empty array/],
        ["an unknown protocol", { listeners: [httpListener({ protocol: "ftp" })] }, /protocol/],
        ["a port out of range", { listeners: [httpListener({ port: 70000 })] }, /port/],
        ["https without tls", { listeners: [{ port: 443, protocol: "https" }] }, /tls with cert and key is required/],
        ["tls without key", { listeners: [{ port: 443, protocol: "https", tls: { cert: "c.pem" } }] }, /tls\.key/],
        ["an invalid target URL", { listeners: [httpListener({ routes: { "a.test": "not a url" } })] }, /not a valid URL/],
        ["a non-http target", { listeners: [httpListener({ routes: { "a.test": "ftp://localhost" } })] }, /must use http or https/],
        ["a non-boolean flag", { listeners: [httpListener({ routes: { "a.test": { target: "http://x", changeOrigin: "yes" } } })] }, /changeOrigin/],
        ["routes that is not an object", { listeners: [httpListener({ routes: [] })] }, /routes must be an object/],
        ["duplicate domains", { listeners: [httpListener({ routes: { "a.test": "http://x", "A.test": "http://y" } })] }, /more than once/],
        ["duplicate ports", { listeners: [httpListener({ name: "one" }), httpListener({ name: "two" })] }, /"one" and "two" both use port 8080/],
    ];

    for (const [description, raw, message] of invalidCases) {
        it(`rejects ${description}`, () => {
            assert.throws(() => normalizeConfig(raw), (err) => err instanceof ConfigError && message.test(err.message));
        });
    }
});

describe("loadConfig", () => {
    it("reports a missing file", async () => {
        await assert.rejects(loadConfig("/nonexistent/config.json"), /config file not found/);
    });

    it("reports invalid JSON", async (t) => {
        const configPath = await writeTempConfig(t, "{ not json");

        await assert.rejects(loadConfig(configPath), /invalid JSON/);
    });

    it("reads TLS files relative to the config file", async (t) => {
        const configPath = await writeTempConfig(t, JSON.stringify({
            listeners: [{ port: 443, protocol: "https", tls: { cert: "cert.pem", key: "key.pem" } }],
        }));
        await copyFile(path.join(fixturesDir, "cert.pem"), path.join(path.dirname(configPath), "cert.pem"));
        await copyFile(path.join(fixturesDir, "key.pem"), path.join(path.dirname(configPath), "key.pem"));

        const config = await loadConfig(configPath);

        assert.ok(config.listeners[0].tls.cert.toString().includes("BEGIN CERTIFICATE"));
        assert.ok(config.listeners[0].tls.key.toString().includes("PRIVATE KEY"));
    });

    it("reports a missing TLS file", async (t) => {
        const configPath = await writeTempConfig(t, JSON.stringify({
            listeners: [{ name: "secure", port: 443, protocol: "https", tls: { cert: "missing.pem", key: "missing.pem" } }],
        }));

        await assert.rejects(loadConfig(configPath), /listener "secure": cannot read tls\.cert/);
    });
});

async function writeTempConfig(t, content) {
    const dir = await mkdtemp(path.join(tmpdir(), "easy-proxy-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, content);
    return configPath;
}
