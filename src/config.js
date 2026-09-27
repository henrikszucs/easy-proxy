import { readFile } from "node:fs/promises";
import path from "node:path";

export class ConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = "ConfigError";
    }
}

const PROTOCOLS = ["http", "https"];

/**
 * Reads, validates and normalizes a config file, including the TLS files
 * it refers to.
 */
export async function loadConfig(filePath) {
    const absolutePath = path.resolve(filePath);

    let text;
    try {
        text = await readFile(absolutePath, "utf8");
    } catch (err) {
        if (err.code === "ENOENT") {
            throw new ConfigError(`config file not found: ${absolutePath}`);
        }
        throw new ConfigError(`cannot read config file ${absolutePath}: ${err.message}`);
    }

    let raw;
    try {
        raw = JSON.parse(text);
    } catch (err) {
        throw new ConfigError(`invalid JSON in ${absolutePath}: ${err.message}`);
    }

    const config = normalizeConfig(raw, path.dirname(absolutePath));

    for (const listener of config.listeners) {
        if (listener.tls) {
            listener.tls.cert = await readTlsFile(listener, "cert");
            listener.tls.key = await readTlsFile(listener, "key");
        }
    }

    return config;
}

async function readTlsFile(listener, field) {
    const filePath = listener.tls[field];
    try {
        return await readFile(filePath);
    } catch (err) {
        throw new ConfigError(`listener "${listener.name}": cannot read tls.${field} ${filePath}: ${err.message}`);
    }
}

/**
 * Validates a parsed config object and returns it in normalized form.
 * TLS file paths are resolved against baseDir but not read.
 */
export function normalizeConfig(raw, baseDir = process.cwd()) {
    if (!isPlainObject(raw)) {
        throw new ConfigError("config must be a JSON object");
    }
    if (!Array.isArray(raw.listeners) || raw.listeners.length === 0) {
        throw new ConfigError("config.listeners must be a non-empty array");
    }

    const listeners = raw.listeners.map((listener, index) => normalizeListener(listener, index, baseDir));

    const seenPorts = new Map();
    for (const listener of listeners) {
        // Port 0 asks the OS for a free port, so it can never clash.
        if (listener.port !== 0 && seenPorts.has(listener.port)) {
            throw new ConfigError(`listeners "${seenPorts.get(listener.port)}" and "${listener.name}" both use port ${listener.port}`);
        }
        seenPorts.set(listener.port, listener.name);
    }

    return { listeners };
}

function normalizeListener(raw, index, baseDir) {
    const where = `listeners[${index}]`;
    if (!isPlainObject(raw)) {
        throw new ConfigError(`${where} must be an object`);
    }

    if (!PROTOCOLS.includes(raw.protocol)) {
        throw new ConfigError(`${where}.protocol must be "http" or "https"`);
    }
    if (!Number.isInteger(raw.port) || raw.port < 0 || raw.port > 65535) {
        throw new ConfigError(`${where}.port must be an integer between 0 and 65535`);
    }
    if (raw.name !== undefined && (typeof raw.name !== "string" || raw.name === "")) {
        throw new ConfigError(`${where}.name must be a non-empty string`);
    }

    const name = raw.name ?? `${raw.protocol}:${raw.port}`;
    const label = `listener "${name}"`;

    let tls = null;
    if (raw.protocol === "https") {
        if (!isPlainObject(raw.tls)) {
            throw new ConfigError(`${label}: tls with cert and key is required for https`);
        }
        for (const field of ["cert", "key"]) {
            if (typeof raw.tls[field] !== "string" || raw.tls[field] === "") {
                throw new ConfigError(`${label}: tls.${field} must be a file path`);
            }
        }
        tls = {
            cert: path.resolve(baseDir, raw.tls.cert),
            key: path.resolve(baseDir, raw.tls.key),
        };
    }

    const routes = new Map();
    if (raw.routes !== undefined) {
        if (!isPlainObject(raw.routes)) {
            throw new ConfigError(`${label}: routes must be an object`);
        }
        for (const [domain, route] of Object.entries(raw.routes)) {
            const key = normalizeHostname(domain);
            if (key === "") {
                throw new ConfigError(`${label}: route domain must not be empty`);
            }
            if (routes.has(key)) {
                throw new ConfigError(`${label}: domain "${domain}" is listed more than once`);
            }
            routes.set(key, normalizeRoute(route, `${label}: routes["${domain}"]`));
        }
    }

    const defaultRoute = raw.default === undefined || raw.default === null
        ? null
        : normalizeRoute(raw.default, `${label}: default`);

    return {
        name,
        port: raw.port,
        protocol: raw.protocol,
        tls,
        routes,
        default: defaultRoute,
    };
}

function normalizeRoute(raw, where) {
    const route = typeof raw === "string" ? { target: raw } : raw;
    if (!isPlainObject(route)) {
        throw new ConfigError(`${where} must be a target URL string or an object`);
    }
    if (typeof route.target !== "string") {
        throw new ConfigError(`${where}.target must be a URL string`);
    }

    let target;
    try {
        target = new URL(route.target);
    } catch {
        throw new ConfigError(`${where}.target is not a valid URL: ${route.target}`);
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
        throw new ConfigError(`${where}.target must use http or https: ${route.target}`);
    }

    for (const flag of ["changeOrigin", "secure"]) {
        if (route[flag] !== undefined && typeof route[flag] !== "boolean") {
            throw new ConfigError(`${where}.${flag} must be true or false`);
        }
    }

    return {
        target,
        changeOrigin: route.changeOrigin ?? false,
        secure: route.secure ?? true,
    };
}

/**
 * Lowercases a hostname and removes a trailing dot, so "Example.COM." and
 * "example.com" compare equal.
 */
export function normalizeHostname(hostname) {
    return hostname.trim().toLowerCase().replace(/\.$/, "");
}

function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
