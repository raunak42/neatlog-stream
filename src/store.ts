import type { HistoryResponse, Projection, Trace, TraceSummary } from "./types.js";

export interface StoreOptions {
    /** Entries retained before the oldest are evicted. */
    capacity: number;
    /** Bytes of `data.output_value` kept inline before clipping. */
    contentLimit?: number;
}

export const DEFAULT_CONTENT_LIMIT = 16_384;

/**
 * Append-only in-memory log with a bounded window.
 *
 * Entries stay sorted by `id`, which increases monotonically, so lookups are
 * binary searches rather than scans. Eviction drops from the front in batches:
 * shifting one element per append turns every append into an O(n) copy once the
 * buffer is full, and amortising keeps steady-state appends O(1).
 *
 * Clipping oversized span output happens here rather than in the generator,
 * because it is a property of how data is served, not of the data itself. The
 * full text is kept aside so it can still be fetched explicitly.
 */
export class TraceStore {
    private entries: Trace[] = [];
    private byTraceId = new Map<string, Trace>();
    /** Full pre-clip output, keyed `${traceId}:${spanId}`. Only oversized spans. */
    private payloads = new Map<string, string>();
    /** sessionId → its trace ids, ascending. Sessions interleave in the stream,
     *  so without this a session lookup is a scan of the whole window. */
    private bySession = new Map<string, number[]>();

    private nextId = 1;
    private readonly capacity: number;
    private readonly evictionBatch: number;
    private readonly contentLimit: number;

    constructor(options: StoreOptions) {
        if (options.capacity < 1) throw new Error("capacity must be at least 1");
        this.capacity = options.capacity;
        this.evictionBatch = Math.max(1, Math.floor(options.capacity * 0.01));
        this.contentLimit = options.contentLimit ?? DEFAULT_CONTENT_LIMIT;
    }

    get size(): number {
        return this.entries.length;
    }

    get payloadCount(): number {
        return this.payloads.size;
    }

    peekNextId(): number {
        return this.nextId;
    }

    /** Newest entry's id, or 0 when empty — the WebSocket handshake value. */
    lastId(): number {
        return this.entries.length === 0 ? 0 : this.entries[this.entries.length - 1]!.id;
    }

    oldestId(): number | null {
        return this.entries.length === 0 ? null : this.entries[0]!.id;
    }

    private payloadKey(traceId: string, spanId: string): string {
        return `${traceId}:${spanId}`;
    }

    /** Clips oversized output and records the full text for later retrieval. */
    private clipOversizedOutput(trace: Trace): void {
        for (const span of trace.spans) {
            const full = span.data.output_value;
            if (full.length <= this.contentLimit) continue;

            this.payloads.set(this.payloadKey(trace._id, span.span_id), full);
            span.data.output_value = full.slice(0, this.contentLimit);
            span.output_truncated = true;
            span.payload_signed_url = `/api/traces/v3/${trace._id}/spans/${span.span_id}/payload`;
            span.session_projection = {
                content_limit: this.contentLimit,
                truncated: true,
                truncated_fields: ["data.output_value"],
            };
        }
    }

    append(build: (id: number) => Trace): Trace {
        const entry = build(this.nextId);
        this.nextId += 1;

        this.clipOversizedOutput(entry);
        this.entries.push(entry);
        this.byTraceId.set(entry._id, entry);
        const turns = this.bySession.get(entry.sessionId);
        if (turns) turns.push(entry.id);
        else this.bySession.set(entry.sessionId, [entry.id]);
        this.evictIfNeeded();

        return entry;
    }

    private evictIfNeeded(): void {
        if (this.entries.length <= this.capacity) return;

        const overflow = this.entries.length - this.capacity;
        const removed = this.entries.splice(0, overflow + this.evictionBatch - 1);

        // The side indexes are bounded by the same window, so they are pruned
        // with the entries they belong to.
        for (const trace of removed) {
            this.byTraceId.delete(trace._id);
            for (const span of trace.spans) {
                this.payloads.delete(this.payloadKey(trace._id, span.span_id));
            }
            // Evicted turns leave the session index; an emptied session leaves too.
            const turns = this.bySession.get(trace.sessionId);
            if (!turns) continue;
            const at = turns.indexOf(trace.id);
            if (at !== -1) turns.splice(at, 1);
            if (turns.length === 0) this.bySession.delete(trace.sessionId);
        }
    }

    get sessionCount(): number {
        return this.bySession.size;
    }

    /**
     * Sessions worth opening. `turns` finds the biggest, `recent` finds the
     * ones still receiving traffic — a demo needs both, and a large session is
     * not necessarily a live one.
     */
    listSessions(limit: number, sort: "turns" | "recent" = "turns"):
    Array<{ sessionId: string; turns: number; lastId: number; live: boolean }> {
        const newest = this.lastId();
        // Tight on purpose. A thread that has just hit its ceiling still has a
        // recent last id, so a loose window reports it as live right up until
        // it is ranked first for being the largest — which is exactly the
        // thread that will never receive another turn. A resident writes every
        // second or so, and this is twenty seconds of stream at five a second.
        const liveWindow = 100;
        const rows = [];
        for (const [sessionId, ids] of this.bySession) {
            const lastId = ids[ids.length - 1] ?? 0;
            rows.push({ sessionId, turns: ids.length, lastId, live: newest - lastId <= liveWindow });
        }
        if (sort === "recent") {
            rows.sort((a, b) => b.lastId - a.lastId);
            return rows.slice(0, limit);
        }
        // Live threads first. Among them, largest-first would always name the
        // one closest to finishing, so a caller asking for "a big live session"
        // gets one with minutes left. Rank instead by the smallest thread that
        // is still substantial, which is the one with the most life ahead.
        const substantial = 400;
        rows.sort((a, b) => {
            if (a.live !== b.live) return Number(b.live) - Number(a.live);
            if (a.live) {
                const aBig = a.turns >= substantial, bBig = b.turns >= substantial;
                if (aBig !== bBig) return Number(bBig) - Number(aBig);
                if (aBig && bBig) return a.turns - b.turns;
            }
            return b.turns - a.turns;
        });
        return rows.slice(0, limit);
    }

    /**
     * One page of a session's turns, ascending, cursor-paginated. A long
     * session is the case the detail view has to survive, so it is paged the
     * same way history is rather than returned whole.
     */
    getSession(sessionId: string, options: {
        after?: number; before?: number; limit: number; projection: Projection;
    }): { logs: (Trace | TraceSummary)[]; total: number; nextCursor: number | null; hasMore: boolean } {
        const ids = this.bySession.get(sessionId);
        if (!ids) return { logs: [], total: 0, nextCursor: null, hasMore: false };

        let from = 0;
        let to = ids.length;
        if (options.after !== undefined) {
            const at = ids.findIndex((id) => id > options.after!);
            from = at === -1 ? ids.length : at;
        }
        if (options.before !== undefined) {
            const at = ids.findIndex((id) => id >= options.before!);
            to = at === -1 ? ids.length : at;
            from = Math.max(from, to - options.limit);
        }

        const page = ids.slice(from, Math.min(to, from + options.limit));
        const logs: (Trace | TraceSummary)[] = [];
        for (const id of page) {
            // The index can briefly name a turn the ring has already dropped.
            const entry = this.entries[this.lowerBound(id)];
            if (entry?.id === id) logs.push(this.project(entry, options.projection));
        }

        return {
            logs,
            total: ids.length,
            nextCursor: page.length > 0 ? page[page.length - 1]! : null,
            hasMore: from + page.length < ids.length,
        };
    }

    /** Index of the first entry with `id >= target`, or `length` if none. */
    private lowerBound(target: number): number {
        let low = 0;
        let high = this.entries.length;

        while (low < high) {
            const mid = (low + high) >>> 1;
            if (this.entries[mid]!.id < target) low = mid + 1;
            else high = mid;
        }

        return low;
    }

    /** Public so the live tail can send summaries rather than full documents. */
    toProjection(trace: Trace, projection: Projection): Trace | TraceSummary {
        return this.project(trace, projection);
    }

    private project(trace: Trace, projection: Projection): Trace | TraceSummary {
        if (projection === "session") return trace;
        const { spans: _spans, ...summary } = trace;
        return { ...summary, projection: "list" };
    }

    /**
     * The `limit` entries immediately older than `before`, newest first.
     * Omitting `before` returns the newest `limit` entries.
     */
    getBefore(before: number | undefined, limit: number, projection: Projection = "session"): HistoryResponse {
        const end = before === undefined ? this.entries.length : this.lowerBound(before);
        const start = Math.max(0, end - limit);
        const page = this.entries.slice(start, end).reverse();

        return {
            logs: page.map((trace) => this.project(trace, projection)),
            // Anchors the next page. Null only when this page is empty, so a
            // client never loses its place while entries still exist.
            nextCursor: page.length > 0 ? page[page.length - 1]!.id : null,
            hasMore: start > 0,
        };
    }

    /**
     * Entries strictly newer than `after`, oldest first — the gap backfill used
     * when reconciling history against buffered live messages.
     */
    getAfter(after: number, limit: number, projection: Projection = "session"): HistoryResponse {
        const start = this.lowerBound(after + 1);
        const page = this.entries.slice(start, start + limit);

        return {
            logs: page.map((trace) => this.project(trace, projection)),
            // For a forward scan the cursor is the newest id returned, so it can
            // be passed straight back as the next `after`.
            nextCursor: page.length > 0 ? page[page.length - 1]!.id : null,
            hasMore: start + page.length < this.entries.length,
        };
    }

    /** Full trace by hex `_id` or by numeric cursor id. */
    getTrace(identifier: string): Trace | null {
        const byHex = this.byTraceId.get(identifier);
        if (byHex) return byHex;

        const numeric = Number(identifier);
        if (!Number.isInteger(numeric)) return null;

        const index = this.lowerBound(numeric);
        const candidate = this.entries[index];
        return candidate && candidate.id === numeric ? candidate : null;
    }

    /** Pre-clip output for a span, or null if it was never clipped or has aged out. */
    getSpanPayload(traceId: string, spanId: string): string | null {
        return this.payloads.get(this.payloadKey(traceId, spanId)) ?? null;
    }

    snapshot(): readonly Trace[] {
        return this.entries;
    }
}
