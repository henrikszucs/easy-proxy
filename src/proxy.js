import http from "node:http";
import https from "node:https";
import { normalizeHostname } from "./config.js";

// Headers that describe a single connection and must not be forwarded.
const HOP_BY_HOP_HEADERS = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

// Upgraded (e.g. WebSocket) client sockets per server, destroyed on shutdown.
const tunnelsKey = Symbol("tunnels");

const silentLogger = {
    info() {},
    error() {},
};

/**
 * Creates an HTTP or HTTPS server for one normalized listener. The server
 * is returned unstarted; call listen() on it.
 */
export function createProxyServer(listener, { logger = silentLogger } = {}) {
    const onRequest = (req, res) => handleRequest(listener, req, res, logger);
    const server = listener.protocol === "https"
        ? https.createServer({ cert: listener.tls.cert, key: listener.tls.key }, onRequest)
        : http.createServer(onRequest);

    const tunnels = new Set();
    server[tunnelsKey] = tunnels;
    server.on("upgrade", (req, socket, head) => handleUpgrade(listener, tunnels, req, socket, head, logger));

    return server;
}

/**
 * Stops accepting connections and drops the open ones, including upgraded
 * tunnels.
 */
export function closeProxyServer(server) {
    return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
        for (const socket of server[tunnelsKey] ?? []) {
            socket.destroy();
        }
    });
}

/**
 * Extracts the hostname from a Host header value: drops the port and
 * normalizes case. Handles bracketed IPv6 addresses.
 */
export function hostnameFromHostHeader(host) {
    let hostname = host;
    if (hostname.startsWith("[")) {
        const end = hostname.indexOf("]");
        if (end !== -1) {
            hostname = hostname.slice(0, end + 1);
        }
    } else {
        const colon = hostname.lastIndexOf(":");
        if (colon !== -1) {
            hostname = hostname.slice(0, colon);
        }
    }
    return normalizeHostname(hostname);
}

function requestHostname(req) {
    if (req.headers.host) {
        return hostnameFromHostHeader(req.headers.host);
    }
    // No Host header (HTTP/1.0): fall back to the TLS SNI name if there is one.
    return normalizeHostname(req.socket.servername || "");
}

function findRoute(listener, hostname) {
    return listener.routes.get(hostname) ?? listener.default;
}

function handleRequest(listener, req, res, logger) {
    const startedAt = Date.now();
    const hostname = requestHostname(req);
    const label = `[${listener.name}] ${req.method} ${hostname}${req.url}`;

    res.on("close", () => {
        const status = res.writableFinished ? res.statusCode : "aborted";
        logger.info(`${label} -> ${status} ${Date.now() - startedAt}ms`);
    });

    const route = findRoute(listener, hostname);
    if (!route) {
        sendError(res, 404);
        return;
    }

    let clientGone = false;
    const proxyReq = sendUpstream(route, req, forwardHeaders(listener, route, req));

    proxyReq.on("response", (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.statusMessage, stripHopByHop(proxyRes.headers));
        proxyRes.pipe(res);
        proxyRes.on("error", () => res.destroy());
    });

    proxyReq.on("error", (err) => {
        if (clientGone) {
            return;
        }
        logger.error(`${label} -> upstream ${route.target.origin} failed: ${err.message}`);
        if (res.headersSent) {
            res.destroy();
        } else {
            sendError(res, 502);
        }
    });

    res.on("close", () => {
        if (!res.writableFinished) {
            clientGone = true;
            proxyReq.destroy();
        }
    });
    req.on("error", () => proxyReq.destroy());

    req.pipe(proxyReq);
}

function handleUpgrade(listener, tunnels, req, socket, head, logger) {
    const hostname = requestHostname(req);
    const label = `[${listener.name}] ${req.method} ${hostname}${req.url} (upgrade: ${req.headers.upgrade})`;

    // Socket errors surface as "close", which tears the tunnel down.
    socket.on("error", () => {});

    const route = findRoute(listener, hostname);
    if (!route) {
        logger.info(`${label} -> 404`);
        writeRawError(socket, 404);
        return;
    }

    const headers = forwardHeaders(listener, route, req);
    headers.connection = "upgrade";
    headers.upgrade = req.headers.upgrade;

    let answered = false;
    const proxyReq = sendUpstream(route, req, headers);

    proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
        answered = true;
        logger.info(`${label} -> ${proxyRes.statusCode}`);

        proxySocket.on("error", () => {});
        proxySocket.on("close", () => socket.destroy());
        socket.on("close", () => {
            proxySocket.destroy();
            tunnels.delete(socket);
        });
        tunnels.add(socket);

        socket.write(rawResponseHead(proxyRes.statusCode, proxyRes.statusMessage, proxyRes.rawHeaders));
        if (proxyHead.length > 0) {
            socket.write(proxyHead);
        }
        if (head.length > 0) {
            proxySocket.write(head);
        }
        proxySocket.pipe(socket);
        socket.pipe(proxySocket);
    });

    proxyReq.on("response", (proxyRes) => {
        // The upstream refused to switch protocols: relay its answer, then
        // close, since the body is delimited by the end of the connection.
        answered = true;
        logger.info(`${label} -> ${proxyRes.statusCode}`);
        const rawHeaders = withoutHopByHop(proxyRes.rawHeaders);
        rawHeaders.push("Connection", "close");
        socket.write(rawResponseHead(proxyRes.statusCode, proxyRes.statusMessage, rawHeaders));
        proxyRes.pipe(socket);
    });

    proxyReq.on("error", (err) => {
        if (answered || socket.destroyed) {
            socket.destroy();
            return;
        }
        logger.error(`${label} -> upstream ${route.target.origin} failed: ${err.message}`);
        writeRawError(socket, 502);
    });

    socket.on("close", () => {
        if (!answered) {
            proxyReq.destroy();
        }
    });

    proxyReq.end();
}

function forwardHeaders(listener, route, req) {
    const headers = stripHopByHop(req.headers);

    const clientAddress = req.socket.remoteAddress;
    if (clientAddress) {
        const forwardedFor = req.headers["x-forwarded-for"];
        headers["x-forwarded-for"] = forwardedFor ? `${forwardedFor}, ${clientAddress}` : clientAddress;
    }
    headers["x-forwarded-proto"] = listener.protocol;
    if (req.headers.host) {
        headers["x-forwarded-host"] = req.headers.host;
    }
    if (route.changeOrigin) {
        headers.host = route.target.host;
    }

    return headers;
}

function sendUpstream(route, req, headers) {
    const { target } = route;
    const isHttps = target.protocol === "https:";
    const options = {
        // URL keeps IPv6 addresses in brackets; request() wants them bare.
        hostname: target.hostname.replace(/^\[(.*)\]$/, "$1"),
        port: target.port || (isHttps ? 443 : 80),
        method: req.method,
        path: joinPath(target.pathname, req.url),
        headers,
    };
    if (isHttps) {
        options.rejectUnauthorized = route.secure;
    }
    return (isHttps ? https : http).request(options);
}

function joinPath(basePath, requestPath) {
    if (basePath === "/" || !requestPath.startsWith("/")) {
        return requestPath;
    }
    return basePath.replace(/\/$/, "") + requestPath;
}

function stripHopByHop(headers) {
    const result = { ...headers };
    for (const name of connectionHeaderNames(headers.connection)) {
        delete result[name];
    }
    for (const name of HOP_BY_HOP_HEADERS) {
        delete result[name];
    }
    return result;
}

function withoutHopByHop(rawHeaders) {
    let connection = "";
    for (let i = 0; i < rawHeaders.length; i += 2) {
        if (rawHeaders[i].toLowerCase() === "connection") {
            connection += `,${rawHeaders[i + 1]}`;
        }
    }
    const dropped = new Set([...HOP_BY_HOP_HEADERS, ...connectionHeaderNames(connection)]);

    const result = [];
    for (let i = 0; i < rawHeaders.length; i += 2) {
        if (!dropped.has(rawHeaders[i].toLowerCase())) {
            result.push(rawHeaders[i], rawHeaders[i + 1]);
        }
    }
    return result;
}

// Headers named in a Connection header are hop-by-hop too (RFC 9110 7.6.1).
function connectionHeaderNames(connection) {
    if (!connection) {
        return [];
    }
    return connection
        .split(",")
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name !== "");
}

function rawResponseHead(statusCode, statusMessage, rawHeaders) {
    let head = `HTTP/1.1 ${statusCode} ${statusMessage}\r\n`;
    for (let i = 0; i < rawHeaders.length; i += 2) {
        head += `${rawHeaders[i]}: ${rawHeaders[i + 1]}\r\n`;
    }
    return `${head}\r\n`;
}

function errorBody(statusCode) {
    return `${statusCode} ${http.STATUS_CODES[statusCode]}\n`;
}

function sendError(res, statusCode) {
    const body = errorBody(statusCode);
    res.writeHead(statusCode, {
        "content-type": "text/plain; charset=utf-8",
        "content-length": Buffer.byteLength(body),
    });
    res.end(body);
}

function writeRawError(socket, statusCode) {
    const body = errorBody(statusCode);
    const head = rawResponseHead(statusCode, http.STATUS_CODES[statusCode], [
        "Content-Type", "text/plain; charset=utf-8",
        "Content-Length", String(Buffer.byteLength(body)),
        "Connection", "close",
    ]);
    socket.end(head + body);
}
