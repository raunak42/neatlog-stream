import { createServer } from "node:http";
import express from "express";
import { createSessionRotator, generateTrace } from "./generator.js";
import { createHistoryRouter } from "./rest.js";
import { TraceStore } from "./store.js";
import { attachStream } from "./stream.js";
import { BOOT_ID } from "./bootId.js";

const PORT = Number(process.env.PORT ?? 4500);
const CAPACITY = Number(process.env.CAPACITY ?? 100_000);
const SEED_COUNT = Number(process.env.SEED_COUNT ?? 5_000);
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 1_000);

export interface StartedServer {
    port: number;
    store: TraceStore;
    stop(): Promise<void>;
}

export async function startServer(overrides: {
    port?: number;
    capacity?: number;
    seedCount?: number;
    intervalMs?: number;
} = {}): Promise<StartedServer> {
    const port = overrides.port ?? PORT;
    const capacity = overrides.capacity ?? CAPACITY;
    const seedCount = overrides.seedCount ?? SEED_COUNT;
    const intervalMs = overrides.intervalMs ?? INTERVAL_MS;

    const store = new TraceStore({ capacity });
    const nextSession = createSessionRotator();

    // Seed backwards from now so historical timestamps ascend with id.
    const seedStart = Date.now() - seedCount * intervalMs;
    for (let index = 0; index < seedCount; index += 1) {
        const { sessionId, step } = nextSession();
        const ts = seedStart + index * intervalMs;
        store.append((id) => generateTrace({ id, ts, sessionId, step }));
    }

    const app = express();
    app.use(express.json());

    // The frontend runs on its own origin in development (Vite, Next, and so
    // on), so without this every history request fails the browser's CORS check
    // while curl succeeds. Reads are public in this demo, hence the wildcard.
    app.use((_req, res, next) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.setHeader("Access-Control-Max-Age", "86400");
        next();
    });
    app.options(/.*/, (_req, res) => { res.sendStatus(204); });
    app.use("/api", createHistoryRouter(store));
    app.get("/health", (_req, res) => {
        res.json({ ok: true, bootId: BOOT_ID, size: store.size, lastLogId: store.lastId() });
    });

    const server = createServer(app);
    const hub = attachStream(server, store);

    // Runs for the life of the process, independent of connected clients: the
    // history endpoint must keep advancing even with nobody listening.
    const timer = setInterval(() => {
        const { sessionId, step } = nextSession();
        const trace = store.append((id) => generateTrace({ id, ts: Date.now(), sessionId, step }));
        hub.broadcast(trace);
    }, intervalMs);
    timer.unref?.();

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, () => resolve());
    });

    const address = server.address();
    const boundPort = typeof address === "object" && address ? address.port : port;

    return {
        port: boundPort,
        store,
        async stop() {
            clearInterval(timer);
            await hub.close();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

const isDirectRun = process.argv[1] !== undefined
    && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isDirectRun) {
    startServer()
        .then((started) => {
            console.log(`neatlog-stream listening on http://127.0.0.1:${started.port}`);
            console.log(`  history   GET  /api/logs?before=&after=&limit=`);
            console.log(`  live tail WS   /api/stream`);
            console.log(`  seeded ${started.store.size} traces · capacity ${CAPACITY} · 1 new trace / ${INTERVAL_MS}ms`);
            const shutdown = () => { void started.stop().then(() => process.exit(0)); };
            process.on("SIGINT", shutdown);
            process.on("SIGTERM", shutdown);
        })
        .catch((error) => {
            console.error("failed to start:", error);
            process.exit(1);
        });
}
