# neatlog-stream

Always-on backend for a trace/log viewer demo: REST history with cursor
pagination, plus a WebSocket live tail. Backend only — no frontend.

Entries are **Neatlogs-shaped trace documents**, not flat log lines.

```bash
npm install
npm start          # http://127.0.0.1:4500
npm run smoke      # 21 contract checks
```

## Data shape

Each entry is one trace document, matching the Neatlogs read API
(`GET /api/traces/v3/:traceId?projection=session`): trace-level rollups, plus a
**flat** `spans` array where nesting is expressed by `parent_span_id` rather
than embedding. The root span is the one with no `parent_span_id`.

```jsonc
{
  "id": 5001,                      // cursor (addition, see below)
  "ts": 1786700000000,             // unix ms (addition)

  "_id": "c370533c079b63a02d3ac9d37ea09ca8",
  "name": "perry.turn step 2",
  "sessionId": "c8bb45ee-…", "workflowName": "perry",
  "createdAt": "…", "updatedAt": "…",

  "latency": 1560, "spanCount": 4,
  "llmCalls": 1, "toolCalls": 2, "retrievalCalls": 0,
  "hasError": 0, "errorCount": 0,
  "promptTokens": 8952, "completionTokens": 167,
  "totalTokensUsed": 9119, "totalTokensCost": 0.029361,

  "spans": [
    { "span_id": "49ff…", "node_type": "agent_action", "node_name": "perry.turn step 2",
      "status": "SUCCESS", "span_metadata": { "session.id": "…" },
      "data": { "input_value": "…", "output_value": "…", "display_blocks": [ … ],
                "duration_ms": 1560.4, "llm_model": "", "prompt_tokens": 0, … } },
    { "span_id": "b681…", "parent_span_id": "49ff…", "node_type": "chain", … },
    { "span_id": "9d44…", "parent_span_id": "49ff…", "node_type": "tool_call", … }
  ],

  "status": "success", "projection": "session"
}
```

Faithful to the original, including its quirks:

- `data` is a **fixed schema**, not an attribute bag — every span carries every
  key, `""` or `0` where it does not apply.
- Durations are precomputed in four units, so a client never does the maths.
- Trace-level rollups are precomputed, so the header is a field read rather
  than a reduce over `spans`.
- Oversized `output_value` is clipped at 16 KB and marked with
  `output_truncated`, `session_projection.truncated_fields`, and a
  `payload_signed_url` for fetching the full payload.

### Two additions

Neatlogs identifies a trace by a hex `_id`, which cannot be ordered or compared,
so cursor pagination and the WebSocket handshake need something monotonic:

| Field | Why |
|---|---|
| `id` | auto-incrementing integer — the cursor for `before`/`after` and `lastLogId` |
| `ts` | creation time in unix ms, alongside the ISO `createdAt` |

## `GET /api/logs`

| Query | Default | Meaning |
|---|---|---|
| `before` | — | entries immediately **older** than this id, newest→oldest |
| `after` | — | entries strictly **newer** than this id, oldest→newest |
| `limit` | 50 | 1–500 |

Omit both cursors for the newest `limit` entries. Passing both is a 400, as are
non-integer or negative cursors and a `limit` below 1.

```jsonc
{ "logs": [ … ], "nextCursor": 4951, "hasMore": true }
```

`nextCursor` is the id of the last entry in the page — the oldest for a `before`
scan, the newest for an `after` scan — so it feeds straight back into the next
request. It is `null` only when the page is empty.

Also `GET /api/stats` and `GET /health` for diagnostics.

## `WS /api/stream`

On connect:

```jsonc
{ "type": "connected", "lastLogId": 5000 }
```

Then, for every generated trace:

```jsonc
{ "type": "log", "data": { …trace… } }
```

Broadcast to all sockets; no filtering or auth.

## Reconciliation

The handshake exists so a client never loses an entry in the gap between
subscribing and loading history:

1. Open the WebSocket, keep `lastLogId`.
2. Buffer every `log` message that arrives.
3. `GET /api/logs?before=<lastLogId + 1>&limit=50`.
4. Merge history with the buffer, deduping on `id`.

`lastLogId` is read at connection time, in the same handler that starts
delivery, so nothing can slip between the two. If a client is disconnected and
needs to catch up, `?after=<lastSeenId>` returns the gap, oldest first.

The smoke test exercises exactly this — connecting, stalling long enough for the
generator to tick, then merging — and asserts the resulting id sequence is
contiguous.

## Generator and memory

- Seeds ~5,000 traces on boot, timestamps trailing back from now.
- `setInterval` appends one trace/second for the life of the process, **whether
  or not any client is connected**.
- Ring buffer capped at 100,000 entries; the oldest are evicted past that.
  Eviction happens in batches and lookups are binary searches, so appends stay
  fast once full (20k appends against a full buffer: ~107 ms).

Configure with `PORT`, `CAPACITY`, `SEED_COUNT`, `INTERVAL_MS`.
