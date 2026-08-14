import type { HistoryResponse, Trace } from "./types.js";

export interface StoreOptions {
    /** Entries retained before the oldest are evicted. */
    capacity: number;
}

/**
 * Append-only in-memory log with a bounded window.
 *
 * Entries are kept sorted by `id`, which increases monotonically, so every
 * lookup is a binary search rather than a scan — at 100k entries a linear scan
 * per request is wasteful, and the array is already ordered.
 *
 * Eviction drops from the front in batches. Shifting one element at a time
 * turns each append into an O(n) copy once the buffer is full; amortising it
 * keeps steady-state appends O(1).
 */
export class TraceStore {
    private entries: Trace[] = [];
    private nextId = 1;
    private readonly capacity: number;
    private readonly evictionBatch: number;

    constructor(options: StoreOptions) {
        if (options.capacity < 1) throw new Error("capacity must be at least 1");
        this.capacity = options.capacity;
        this.evictionBatch = Math.max(1, Math.floor(options.capacity * 0.01));
    }

    get size(): number {
        return this.entries.length;
    }

    /** Id the next appended entry will receive. */
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

    append(build: (id: number) => Trace): Trace {
        const entry = build(this.nextId);
        this.nextId += 1;
        this.entries.push(entry);
        this.evictIfNeeded();
        return entry;
    }

    private evictIfNeeded(): void {
        if (this.entries.length <= this.capacity) return;

        const overflow = this.entries.length - this.capacity;
        // Always clear the overflow, plus a batch, so this runs rarely.
        this.entries.splice(0, overflow + this.evictionBatch - 1);
    }

    /**
     * Index of the first entry with `id >= target`, or `length` if none.
     * The array is sorted by id, so this is a binary search.
     */
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

    /**
     * The `limit` entries immediately older than `before`, newest first.
     * Omitting `before` returns the newest `limit` entries.
     */
    getBefore(before: number | undefined, limit: number): HistoryResponse {
        const end = before === undefined ? this.entries.length : this.lowerBound(before);
        const start = Math.max(0, end - limit);
        const page = this.entries.slice(start, end).reverse();

        return {
            logs: page,
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
    getAfter(after: number, limit: number): HistoryResponse {
        const start = this.lowerBound(after + 1);
        const page = this.entries.slice(start, start + limit);

        return {
            logs: page,
            // For a forward scan the cursor is the newest id returned, so the
            // caller can pass it straight back as the next `after`.
            nextCursor: page.length > 0 ? page[page.length - 1]!.id : null,
            hasMore: start + page.length < this.entries.length,
        };
    }

    /** Test and diagnostic helper. */
    snapshot(): readonly Trace[] {
        return this.entries;
    }
}
