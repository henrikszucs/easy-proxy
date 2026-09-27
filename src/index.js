import { closeProxyServer, createProxyServer } from "./proxy.js";

export { ConfigError, loadConfig, normalizeConfig } from "./config.js";
export { closeProxyServer, createProxyServer } from "./proxy.js";

/**
 * Starts one server per listener in a normalized config. If any listener
 * fails to start, the ones already started are closed again.
 */
export async function startProxy(config, { logger } = {}) {
    const servers = [];

    try {
        for (const listener of config.listeners) {
            const server = createServer(listener, logger);
            servers.push(server);
            await listen(server, listener);

            server.on("error", (err) => logger?.error(`[${listener.name}] server error: ${err.message}`));
            const { port } = server.address();
            logger?.info(`[${listener.name}] listening on ${listener.protocol} port ${port} (${describeRoutes(listener)})`);
        }
    } catch (err) {
        await Promise.all(servers.map(closeProxyServer));
        throw err;
    }

    return {
        servers,
        async close() {
            await Promise.all(servers.map(closeProxyServer));
        },
    };
}

function createServer(listener, logger) {
    try {
        return createProxyServer(listener, { logger });
    } catch (err) {
        // Invalid PEM data makes the TLS context creation throw.
        throw new Error(`listener "${listener.name}": cannot create server: ${err.message}`);
    }
}

function listen(server, listener) {
    return new Promise((resolve, reject) => {
        const onError = (err) => reject(new Error(`listener "${listener.name}": ${describeListenError(err, listener.port)}`));
        server.once("error", onError);
        server.listen(listener.port, () => {
            server.off("error", onError);
            resolve();
        });
    });
}

function describeListenError(err, port) {
    switch (err.code) {
        case "EADDRINUSE":
            return `port ${port} is already in use`;
        case "EACCES":
            return `permission denied to bind port ${port} (ports below 1024 need root or CAP_NET_BIND_SERVICE)`;
        default:
            return `cannot listen on port ${port}: ${err.message}`;
    }
}

function describeRoutes(listener) {
    const count = listener.routes.size;
    const routes = `${count} route${count === 1 ? "" : "s"}`;
    return listener.default ? `${routes} + default` : routes;
}
