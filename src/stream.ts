import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { TraceStore } from "./store.js";
import type { Projection, ServerMessage, Trace } from "./types.js";
import { BOOT_ID } from "./bootId.js";

export interface StreamHub {
    broadcast(trace: Trace): void;
    clientCount(): number;
    close(): Promise<void>;
}

/**
 * Live tail over WebSocket.
 *
 * The handshake reports the newest id at the moment of connection. A client
 * connects, records that id, buffers everything pushed afterwards, then pulls
 * history — so nothing can slip through the gap between the two calls. That
 * only holds if the value is read at connection time and the socket starts
 * receiving immediately, which is why both happen in the same handler.
 */
interface Subscription {
    /** Only traces from this session are sent. Absent means the whole stream. */
    sessionId?: string;
    projection: Projection;
}

export function attachStream(server: Server, store: TraceStore, path = "/api/stream"): StreamHub {
    const wss = new WebSocketServer({ server, path });
    const clients = new Map<WebSocket, Subscription>();

    const send = (socket: WebSocket, message: ServerMessage): void => {
        if (socket.readyState !== socket.OPEN) return;
        try {
            socket.send(JSON.stringify(message));
        } catch {
            // A failed write means the peer is gone; cleanup runs on close.
        }
    };

    wss.on("connection", (socket, request) => {
        // A client watching one thread should not be shipped the whole firehose
        // and told to filter it; both dials are negotiated at connection time.
        const url = new URL(request.url ?? path, "http://localhost");
        const sessionId = url.searchParams.get("sessionId") ?? undefined;
        const projection: Projection = url.searchParams.get("projection") === "list" ? "list" : "session";

        clients.set(socket, { sessionId, projection });
        send(socket, { type: "connected", lastLogId: store.lastId(), bootId: BOOT_ID });

        socket.on("close", () => clients.delete(socket));
        socket.on("error", () => {
            clients.delete(socket);
            socket.terminate();
        });
    });

    return {
        broadcast(trace) {
            // Two payloads at most, built once and shared by every subscriber.
            let full: string | undefined;
            let summary: string | undefined;

            for (const [socket, sub] of clients) {
                if (socket.readyState !== socket.OPEN) continue;
                if (sub.sessionId !== undefined && sub.sessionId !== trace.sessionId) continue;

                let payload: string;
                if (sub.projection === "list") {
                    summary ??= JSON.stringify({ type: "log", data: store.toProjection(trace, "list") });
                    payload = summary;
                } else {
                    full ??= JSON.stringify({ type: "log", data: trace } satisfies ServerMessage);
                    payload = full;
                }

                try {
                    socket.send(payload);
                } catch {
                    // Same reasoning as `send`.
                }
            }
        },
        clientCount: () => clients.size,
        close() {
            for (const socket of clients.keys()) socket.terminate();
            clients.clear();
            return new Promise((resolve) => wss.close(() => resolve()));
        },
    };
}
