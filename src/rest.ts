import { Router } from "express";
import type { TraceStore } from "./store.js";

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

export function createHistoryRouter(store: TraceStore): Router {
    const router = Router();

    router.get("/logs", (req, res) => {
        const before = parseCursor(req.query.before);
        const after = parseCursor(req.query.after);
        const limit = parseLimit(req.query.limit);

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

        res.json(after !== undefined ? store.getAfter(after, limit) : store.getBefore(before, limit));
    });

    router.get("/stats", (_req, res) => {
        res.json({
            size: store.size,
            oldestId: store.oldestId(),
            lastLogId: store.lastId(),
            nextId: store.peekNextId(),
        });
    });

    return router;
}
