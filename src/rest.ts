import { Router } from "express";
import type { TraceStore } from "./store.js";
import type { Projection, SpanPayloadResponse } from "./types.js";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;

/** Returns the parsed value, or null when present but not a positive integer. */
function parseCursor(raw: unknown): number | null | undefined {
    if (raw === undefined) return undefined;
    if (typeof raw !== "string") return null;

    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 ? value : null;
}

function parseLimit(raw: unknown): number | null {
    if (raw === undefined) return DEFAULT_LIMIT;
    if (typeof raw !== "string") return null;

    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) return null;
    return Math.min(value, MAX_LIMIT);
}

/** Defaults to the full document so the history contract is unchanged. */
function parseProjection(raw: unknown): Projection | null {
    if (raw === undefined) return "session";
    if (raw === "session" || raw === "list") return raw;
    return null;
}

export function createHistoryRouter(store: TraceStore): Router {
    const router = Router();

    router.get("/logs", (req, res) => {
        const before = parseCursor(req.query.before);
        const after = parseCursor(req.query.after);
        const limit = parseLimit(req.query.limit);
        const projection = parseProjection(req.query.projection);

        if (before === null) {
            res.status(400).json({ error: "`before` must be a non-negative integer id" });
            return;
        }
        if (after === null) {
            res.status(400).json({ error: "`after` must be a non-negative integer id" });
            return;
        }
        if (limit === null) {
            res.status(400).json({ error: `\`limit\` must be an integer between 1 and ${MAX_LIMIT}` });
            return;
        }
        if (before !== undefined && after !== undefined) {
            res.status(400).json({ error: "use either `before` or `after`, not both" });
            return;
        }
        if (projection === null) {
            res.status(400).json({ error: "`projection` must be `session` or `list`" });
            return;
        }

        res.json(after !== undefined
            ? store.getAfter(after, limit, projection)
            : store.getBefore(before, limit, projection));
    });

    // Detail view. Accepts the hex `_id` or the numeric cursor id, so a list
    // rendered from the `list` projection can drill into a full trace.
    router.get("/traces/:traceId", (req, res) => {
        const trace = store.getTrace(String(req.params.traceId));
        if (!trace) {
            res.status(404).json({ error: "trace not found or evicted from the buffer" });
            return;
        }
        res.json(trace);
    });

    // Serves the escape hatch advertised by `payload_signed_url` on a clipped
    // span. The path matches that URL exactly.
    router.get("/traces/v3/:traceId/spans/:spanId/payload", (req, res) => {
        const traceId = String(req.params.traceId);
        const spanId = String(req.params.spanId);
        const content = store.getSpanPayload(traceId, spanId);

        if (content === null) {
            res.status(404).json({ error: "no stored payload for that span" });
            return;
        }

        res.json({
            traceId,
            span_id: spanId,
            field: "data.output_value",
            content,
            length: content.length,
        } satisfies SpanPayloadResponse);
    });

    router.get("/stats", (_req, res) => {
        res.json({
            size: store.size,
            oldestId: store.oldestId(),
            lastLogId: store.lastId(),
            nextId: store.peekNextId(),
            storedPayloads: store.payloadCount,
        });
    });

    return router;
}
