import assert from "node:assert/strict";
import WebSocket from "ws";
import { startServer } from "../src/server.js";
import { TraceStore } from "../src/store.js";
import { generateTrace } from "../src/generator.js";
import type { HistoryResponse, ServerMessage, Trace } from "../src/types.js";

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    try {
        await fn();
        passed += 1;
        console.log(`  ok   ${name}`);
    } catch (error) {
        console.log(`  FAIL ${name}\n       ${(error as Error).message}`);
        process.exitCode = 1;
    }
}

const started = await startServer({ port: 0, seedCount: 500, intervalMs: 120 });
const base = `http://127.0.0.1:${started.port}`;
const get = async (path: string): Promise<HistoryResponse> =>
    (await fetch(`${base}${path}`)).json() as Promise<HistoryResponse>;

console.log("\nshape");
await check("entries match the Neatlogs trace document", async () => {
    const { logs } = await get("/api/logs?limit=1");
    const trace = logs[0]!;
    for (const key of ["_id", "projectId", "name", "createdAt", "latency", "spanCount", "llmCalls",
        "toolCalls", "hasError", "promptTokens", "totalTokensUsed", "totalTokensCost", "tags",
        "workflowName", "sessionId", "spans", "status", "projection"]) {
        assert.ok(key in trace, `missing ${key}`);
    }
    assert.equal(trace.projection, "session");
});

await check("spans are flat with parent pointers and exactly one root", async () => {
    const { logs } = await get("/api/logs?limit=20");
    for (const trace of logs) {
        const roots = trace.spans.filter((s) => s.parent_span_id === undefined);
        assert.equal(roots.length, 1, "expected exactly one root span");
        assert.equal(roots[0]!.node_type, "agent_action");
        const ids = new Set(trace.spans.map((s) => s.span_id));
        for (const span of trace.spans) {
            if (span.parent_span_id) assert.ok(ids.has(span.parent_span_id), "dangling parent_span_id");
            assert.equal(span.traceId, trace._id);
        }
        assert.equal(trace.spanCount, trace.spans.length);
    }
});

await check("data is a fixed schema: every span carries every key", async () => {
    const { logs } = await get("/api/logs?limit=10");
    const required = ["input_value", "output_value", "duration", "duration_ms", "duration_ns",
        "duration_seconds", "llm_model", "provider", "prompt_tokens", "completion_tokens",
        "total_tokens", "tool_name", "tool_description", "error_message", "error_type",
        "error_stacktrace", "agent_name"];
    for (const trace of logs) {
        for (const span of trace.spans) {
            for (const key of required) assert.ok(key in span.data, `${span.node_type} missing data.${key}`);
        }
    }
});

console.log("\nhistory: before");
await check("newest page is ordered latest -> oldest", async () => {
    const { logs } = await get("/api/logs?limit=50");
    assert.equal(logs.length, 50);
    for (let i = 1; i < logs.length; i += 1) assert.ok(logs[i - 1]!.id > logs[i]!.id, "not descending");
});

await check("before returns the entries immediately older, with no gap or overlap", async () => {
    const first = await get("/api/logs?limit=50");
    const second = await get(`/api/logs?before=${first.nextCursor}&limit=50`);
    assert.equal(second.logs[0]!.id, first.logs[first.logs.length - 1]!.id - 1, "gap or overlap at the seam");
    const overlap = new Set(first.logs.map((l) => l.id));
    assert.ok(!second.logs.some((l) => overlap.has(l.id)), "pages overlap");
});

await check("paging back reaches the oldest entry and reports hasMore=false", async () => {
    let cursor: number | null = null;
    let seen = 0;
    for (let page = 0; page < 40; page += 1) {
        const res: HistoryResponse = await get(`/api/logs?limit=100${cursor ? `&before=${cursor}` : ""}`);
        seen += res.logs.length;
        cursor = res.nextCursor;
        if (!res.hasMore) {
            assert.equal(res.logs[res.logs.length - 1]!.id, started.store.oldestId());
            assert.ok(seen >= 500);
            return;
        }
    }
    throw new Error("never reached the start of the buffer");
});

console.log("\nhistory: after");
await check("after returns entries newer than the cursor, ordered oldest -> newest", async () => {
    const last = started.store.lastId();
    const res = await get(`/api/logs?after=${last - 10}&limit=50`);
    assert.equal(res.logs[0]!.id, last - 9, "did not start immediately after the cursor");
    for (let i = 1; i < res.logs.length; i += 1) assert.ok(res.logs[i - 1]!.id < res.logs[i]!.id, "not ascending");
});

await check("after excludes the cursor itself", async () => {
    const last = started.store.lastId();
    const res = await get(`/api/logs?after=${last - 3}&limit=10`);
    assert.ok(!res.logs.some((l) => l.id === last - 3), "cursor entry was included");
});

await check("after at the head returns an empty page, not an error", async () => {
    const res = await get(`/api/logs?after=${started.store.lastId() + 1000}&limit=10`);
    assert.deepEqual(res.logs, []);
    assert.equal(res.nextCursor, null);
    assert.equal(res.hasMore, false);
});

console.log("\nvalidation");
for (const [query, label] of [["before=abc", "before=abc"], ["after=-1", "after=-1"],
    ["limit=0", "limit=0"], ["before=5&after=5", "before and after together"]] as const) {
    await check(`rejects ${label} with 400`, async () => {
        const res = await fetch(`${base}/api/logs?${query}`);
        assert.equal(res.status, 400);
    });
}

console.log("\nwebsocket");
await check("handshake reports the newest id at connection time", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${started.port}/api/stream`);
    const message = await new Promise<ServerMessage>((resolve, reject) => {
        socket.once("message", (raw) => resolve(JSON.parse(String(raw))));
        socket.once("error", reject);
    });
    assert.equal(message.type, "connected");
    const handshakeId = (message as { lastLogId: number }).lastLogId;
    // The generator may tick between the handshake and this assertion, so the
    // value must be current-or-newer, never stale.
    assert.ok(handshakeId >= started.store.lastId() - 1 && handshakeId <= started.store.lastId(),
        `handshake id ${handshakeId} vs store ${started.store.lastId()}`);
    socket.close();
});

await check("live traces broadcast with contiguous ids", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${started.port}/api/stream`);
    const received: Trace[] = [];
    await new Promise<void>((resolve, reject) => {
        socket.on("message", (raw) => {
            const msg = JSON.parse(String(raw)) as ServerMessage;
            if (msg.type === "log") {
                received.push(msg.data);
                if (received.length === 3) resolve();
            }
        });
        socket.once("error", reject);
        setTimeout(() => reject(new Error("no live messages within 3s")), 3000);
    });
    for (let i = 1; i < received.length; i += 1) {
        assert.equal(received[i]!.id, received[i - 1]!.id + 1, "live ids not contiguous");
    }
    socket.close();
});

console.log("\nreconciliation (the race this contract exists to prevent)");
await check("no entry is lost between the handshake and the history fetch", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${started.port}/api/stream`);
    const buffered: Trace[] = [];
    const handshake = await new Promise<number>((resolve, reject) => {
        socket.on("message", (raw) => {
            const msg = JSON.parse(String(raw)) as ServerMessage;
            if (msg.type === "connected") resolve(msg.lastLogId);
            else buffered.push(msg.data);
        });
        socket.once("error", reject);
    });

    // Stall deliberately so the generator ticks during the gap.
    await new Promise((r) => setTimeout(r, 400));
    const history = await get(`/api/logs?before=${handshake + 1}&limit=100`);

    // Merge exactly as the frontend is specified to: history + buffered, deduped.
    const merged = new Map<number, Trace>();
    for (const t of history.logs) merged.set(t.id, t);
    for (const t of buffered) merged.set(t.id, t);

    const ids = [...merged.keys()].sort((a, b) => a - b);
    for (let i = 1; i < ids.length; i += 1) {
        assert.equal(ids[i], ids[i - 1]! + 1, `gap between ${ids[i - 1]} and ${ids[i]}`);
    }
    assert.ok(buffered.length > 0, "expected live messages during the gap");
    assert.ok(ids.includes(handshake), "handshake id missing from merged view");
    socket.close();
});

await check("backfill via after closes a gap the client missed", async () => {
    const from = started.store.lastId() - 5;
    const res = await get(`/api/logs?after=${from}&limit=100`);
    const ids = res.logs.map((l) => l.id);
    for (let i = 1; i < ids.length; i += 1) assert.equal(ids[i], ids[i - 1]! + 1, "backfill has holes");
    assert.equal(ids[0], from + 1);
});

console.log("\nring buffer");
await check("evicts oldest and never exceeds capacity", () => {
    const store = new TraceStore({ capacity: 1000 });
    for (let i = 0; i < 5000; i += 1) {
        store.append((id) => generateTrace({ id, ts: Date.now(), sessionId: "s", step: 1 }));
        assert.ok(store.size <= 1000, `size ${store.size} exceeded capacity`);
    }
    assert.equal(store.lastId(), 5000);
    assert.ok(store.oldestId()! > 1, "oldest entries were not evicted");
});

await check("ids stay monotonic across eviction, and cursors still resolve", () => {
    const store = new TraceStore({ capacity: 100 });
    for (let i = 0; i < 400; i += 1) {
        store.append((id) => generateTrace({ id, ts: Date.now(), sessionId: "s", step: 1 }));
    }
    const page = store.getBefore(undefined, 10);
    assert.equal(page.logs[0]!.id, 400);
    // A cursor pointing into evicted territory yields an empty page, not a crash.
    const evicted = store.getBefore(5, 10);
    assert.deepEqual(evicted.logs, []);
    assert.equal(evicted.hasMore, false);
});

await check("appends stay fast once the buffer is full", () => {
    const store = new TraceStore({ capacity: 20_000 });
    for (let i = 0; i < 20_000; i += 1) {
        store.append((id) => generateTrace({ id, ts: Date.now(), sessionId: "s", step: 1 }));
    }
    const start = process.hrtime.bigint();
    for (let i = 0; i < 20_000; i += 1) {
        store.append((id) => generateTrace({ id, ts: Date.now(), sessionId: "s", step: 1 }));
    }
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 4000, `20k appends at capacity took ${ms.toFixed(0)}ms`);
    console.log(`       (20k appends while full: ${ms.toFixed(0)}ms)`);
});

console.log("\nalways-on");
await check("generator keeps running with zero clients connected", async () => {
    const before = started.store.lastId();
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(started.store.lastId() > before, "generator stalled without clients");
});

await started.stop();
console.log(`\n${passed} checks passed\n`);
