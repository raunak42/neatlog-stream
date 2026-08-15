import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { TraceStore } from "./store.js";
import type { ServerMessage, Trace } from "./types.js";
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
export function attachStream(server: Server, store: TraceStore, path = "/api/stream"): StreamHub {
    const wss = new WebSocketServer({ server, path });
    const clients = new Set<WebSocket>();

    const send = (socket: WebSocket, message: ServerMessage): void => {
        if (socket.readyState !== socket.OPEN) return;
        try {
            socket.send(JSON.stringify(message));
        } catch {
            // A failed write means the peer is gone; cleanup runs on close.
        }
    };

    wss.on("connection", (socket) => {
        clients.add(socket);
        send(socket, { type: "connected", lastLogId: store.lastId(), bootId: BOOT_ID });

        socket.on("close", () => clients.delete(socket));
        socket.on("error", () => {
            clients.delete(socket);
            socket.terminate();
        });
    });

    return {
        broadcast(trace) {
            const payload = JSON.stringify({ type: "log", data: trace } satisfies ServerMessage);
            for (const socket of clients) {
                if (socket.readyState !== socket.OPEN) continue;
                try {
                    socket.send(payload);
                } catch {
                    // Same reasoning as `send`.
                }
            }
        },
        clientCount: () => clients.size,
        close() {
            for (const socket of clients) socket.terminate();
            clients.clear();
            return new Promise((resolve) => wss.close(() => resolve()));
        },
    };
}
