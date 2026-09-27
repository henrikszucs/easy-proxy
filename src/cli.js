#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { startProxy } from "./index.js";

const DEFAULT_CONFIG = "conf/config.json";

const USAGE = `Usage: easy-proxy [options]

Serves several services on one port, routed by the request's domain.

Options:
    -c, --config <path>  Path to the configuration file (default: ${DEFAULT_CONFIG})
    -h, --help           Show this help
    -v, --version        Show the version`;

const logger = {
    info(message) {
        console.log(`${new Date().toISOString()} ${message}`);
    },
    error(message) {
        console.error(`${new Date().toISOString()} ${message}`);
    },
};

async function main(argv) {
    let options;
    try {
        ({ values: options } = parseArgs({
            args: argv,
            options: {
                config: { type: "string", short: "c", default: DEFAULT_CONFIG },
                help: { type: "boolean", short: "h" },
                version: { type: "boolean", short: "v" },
            },
        }));
    } catch (err) {
        console.error(`easy-proxy: ${err.message}\n\n${USAGE}`);
        process.exit(2);
    }

    if (options.help) {
        console.log(USAGE);
        return;
    }
    if (options.version) {
        console.log(readVersion());
        return;
    }

    const config = await loadConfig(options.config);
    const proxy = await startProxy(config, { logger });

    let stopping = false;
    const stop = async (signal) => {
        if (stopping) {
            logger.error(`received ${signal} again, exiting immediately`);
            process.exit(1);
        }
        stopping = true;
        logger.info(`received ${signal}, shutting down`);
        await proxy.close();
        process.exit(0);
    };
    process.on("SIGINT", () => stop("SIGINT"));
    process.on("SIGTERM", () => stop("SIGTERM"));
}

function readVersion() {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return packageJson.version;
}

main(process.argv.slice(2)).catch((err) => {
    console.error(`easy-proxy: ${err.message}`);
    process.exit(1);
});
