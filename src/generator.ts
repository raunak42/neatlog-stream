import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DisplayBlock, NodeType, Span, SpanData, Trace } from "./types.js";

/** Placeholder. Real ids are per-account and have no business in a demo. */
const PROJECT_ID = "00000000-0000-4000-8000-000000000001";

const MODELS = [
    { provider: "anthropic", model: "claude-sonnet-5" },
    { provider: "anthropic", model: "claude-haiku-4-5" },
    { provider: "openai", model: "gpt-5.4-mini" },
    { provider: "openai", model: "gpt-5.4" },
    { provider: "google", model: "gemini-3-flash" },
];

interface Tool {
    name: string;
    description: string;
    args: string[];
    results: string[];
}

interface Workflow {
    name: string;
    version: string;
    env: string;
    tools: Tool[];
    /** Opening user message; later turns continue the same thread. */
    openers: string[];
    /** Assistant replies used when a turn finishes rather than continuing. */
    finals: string[];
    /** Follow-ups the agent works through on intermediate turns. */
    followUps: string[];
}

/*
 * Five workflows, because a real project instruments more than one. A session
 * stays on a single workflow so the transcript reads coherently.
 */
const WORKFLOWS: Workflow[] = [
    {
        name: "support-triage",
        version: "2.4.1",
        env: "production",
        openers: [
            "Customer says checkout fails on Safari after entering the promo code",
            "Refund request for order 88421 — shipped late, wants full refund",
            "User can't log in, says the reset email never arrives",
            "Enterprise account reports the CSV export is truncated at 1000 rows",
            "Billing dispute: charged twice for the November invoice",
        ],
        followUps: [
            "Check whether this matches an existing incident",
            "Pull the customer's plan and recent tickets",
            "Draft a reply in the support voice",
            "Decide whether this needs escalation",
        ],
        finals: [
            "Matched incident INC-2291. Replied with the workaround and linked the status page.",
            "Refund approved under policy 4.2 and processed; customer notified.",
            "Escalated to Tier 2 — reset emails are bouncing for this domain.",
            "Known limit on the Starter plan. Suggested the paginated export endpoint.",
        ],
        tools: [
            { name: "search_tickets", description: "Search historical support tickets",
              args: ['{"query":"checkout safari promo","limit":20}', '{"query":"duplicate charge november"}'],
              results: ["Output: 3 tickets matched (INC-2291, INC-2104, INC-1998)\nIsError: false",
                        "Output: 0 tickets matched\nIsError: false"] },
            { name: "get_customer", description: "Fetch customer account and plan",
              args: ['{"email":"n***@acme.io"}', '{"account_id":"acct_8841"}'],
              results: ['Output: {"plan":"growth","mrr":420,"since":"2024-03-11","tickets_90d":2}\nIsError: false'] },
            { name: "knowledge_search", description: "Search the internal knowledge base",
              args: ['{"query":"promo code validation safari"}', '{"query":"refund policy late shipment"}'],
              results: ["Output: KB-118 'Safari 17 cookie partitioning' (0.89 match)\nIsError: false"] },
            { name: "send_reply", description: "Send a reply on the ticket",
              args: ['{"ticket_id":"TKT-40182","body":"Thanks for flagging this…"}'],
              results: ["Output: Reply posted to TKT-40182\nIsError: false"] },
            { name: "escalate", description: "Escalate the ticket to a human queue",
              args: ['{"ticket_id":"TKT-40182","tier":2,"reason":"email delivery failure"}'],
              results: ["Output: Escalated to Tier 2, assigned to on-call\nIsError: false"] },
        ],
    },
    {
        name: "research-agent",
        version: "0.9.7",
        env: "production",
        openers: [
            "Compare managed vector databases for hybrid search under 10M vectors",
            "What changed in the EU AI Act timeline for general purpose models?",
            "Summarise the last four quarters of Datadog's net retention",
            "Find benchmarks for streaming JSON parsers in Rust",
        ],
        followUps: [
            "Cross-check the pricing claims against the vendor docs",
            "Look for a primary source for that figure",
            "Reconcile the two conflicting numbers",
            "Pull the methodology section",
        ],
        finals: [
            "Wrote a comparison across 5 vendors with pricing at 10M vectors and cited each claim.",
            "Summarised the timeline with article references; two dates are still provisional.",
            "Net retention: 130%, 127%, 124%, 119%. Sourced from the quarterly filings.",
        ],
        tools: [
            { name: "web_search", description: "Search the public web",
              args: ['{"query":"managed vector database pricing 10M vectors","recency":"90d"}'],
              results: ["Output: 8 results (pinecone.io, weaviate.io, qdrant.tech, turbopuffer.com …)\nIsError: false"] },
            { name: "fetch_page", description: "Fetch and extract readable text from a URL",
              args: ['{"url":"https://qdrant.tech/pricing/"}', '{"url":"https://weaviate.io/pricing"}'],
              results: ["Output: 4,812 chars extracted; 3 pricing tables found\nIsError: false"] },
            { name: "summarise", description: "Condense fetched sources",
              args: ['{"sources":4,"max_words":400}'],
              results: ["Output: 380-word synthesis with 9 inline citations\nIsError: false"] },
            { name: "cite", description: "Attach a source to a claim",
              args: ['{"claim":"net retention 119%","url":"https://investors.datadoghq.com/…"}'],
              results: ["Output: Citation attached\nIsError: false"] },
        ],
    },
    {
        name: "code-review",
        version: "1.12.0",
        env: "production",
        openers: [
            "Review the auth middleware change in PR #482",
            "Is the new retry logic in the payments worker safe under partial failure?",
            "Check PR #517 for N+1 queries before it merges",
            "Look at the migration in #530 — does it lock the table?",
        ],
        followUps: [
            "Read the surrounding module for context",
            "Check whether the tests cover the new branch",
            "Verify this against the existing error handling",
            "Confirm the index is used by the new query",
        ],
        finals: [
            "Left 3 comments: a missing await, an unbounded retry, and a test gap on the 401 path.",
            "Approved. The retry is idempotent and capped; added a note about the jitter constant.",
            "Blocking: the migration takes an ACCESS EXCLUSIVE lock. Suggested CREATE INDEX CONCURRENTLY.",
        ],
        tools: [
            { name: "git_diff", description: "Read the diff for a pull request",
              args: ['{"pr":482}', '{"pr":517,"paths":["src/db/**"]}'],
              results: ["Output: 4 files changed, +182 −37\nIsError: false"] },
            { name: "read_file", description: "Read a file at a revision",
              args: ['{"path":"src/middleware/auth.ts","ref":"pr-482"}',
                     '{"path":"src/workers/payments.ts","offset":1,"limit":300}'],
              results: ["Output: 214 lines read\nIsError: false"] },
            { name: "run_tests", description: "Run the project test suite",
              args: ['{"filter":"auth"}', '{"filter":"payments/retry"}'],
              results: ["STDOUT:\n42 passed, 0 failed\n\nEXIT CODE: 0",
                        "STDOUT:\n38 passed, 1 failed\n\nEXIT CODE: 1"] },
            { name: "post_review_comment", description: "Leave a review comment on a line",
              args: ['{"pr":482,"path":"src/middleware/auth.ts","line":88,"body":"Missing await here…"}'],
              results: ["Output: Comment posted\nIsError: false"] },
        ],
    },
    {
        name: "invoice-extraction",
        version: "3.1.4",
        env: "production",
        openers: [
            "Extract line items from invoice_2291.pdf",
            "Process the March vendor invoices in the inbox folder",
            "This scanned receipt failed validation — figure out why",
            "Pull totals and tax from the attached PO",
        ],
        followUps: [
            "The subtotal doesn't reconcile — recheck the table",
            "Normalise the currency and dates",
            "Match this against the purchase order",
        ],
        finals: [
            "Extracted 14 line items, subtotal £8,412.00, VAT £1,682.40. Totals reconcile.",
            "Flagged for review: OCR confidence 0.61 on the quantity column.",
            "Matched to PO-7741 with a £120 discrepancy on freight.",
        ],
        tools: [
            { name: "ocr_document", description: "Run OCR over a document",
              args: ['{"file":"invoice_2291.pdf","pages":"1-3"}'],
              results: ["Output: 3 pages, mean confidence 0.94\nIsError: false",
                        "Output: 1 page, mean confidence 0.61\nIsError: false"] },
            { name: "parse_table", description: "Parse a detected table into rows",
              args: ['{"page":2,"table_index":0}'],
              results: ["Output: 14 rows x 5 columns\nIsError: false"] },
            { name: "validate_totals", description: "Check that line items sum to the stated total",
              args: ['{"subtotal":8412.00,"tax":1682.40,"total":10094.40}'],
              results: ["Output: reconciles (delta 0.00)\nIsError: false",
                        "Output: MISMATCH delta 120.00\nIsError: false"] },
            { name: "write_record", description: "Persist the extracted record",
              args: ['{"table":"invoices","id":"INV-2291"}'],
              results: ["Output: 1 row written\nIsError: false"] },
        ],
    },
    {
        name: "onboarding-copilot",
        version: "1.3.2",
        env: "production",
        openers: [
            "How do I connect a Postgres source with an SSH tunnel?",
            "My first sync has been queued for 20 minutes — is that normal?",
            "Which fields are required for the Salesforce connector?",
            "Can I backfill only the last 90 days?",
        ],
        followUps: [
            "Check the workspace's current connector state",
            "Look up the exact permission the role needs",
            "Verify connectivity before suggesting a fix",
        ],
        finals: [
            "Walked through the tunnel setup and verified the connection — sync is running.",
            "The queue was blocked on a stale lock; cleared it and the sync started.",
            "Backfill window set to 90 days on the source config.",
        ],
        tools: [
            { name: "search_docs", description: "Search product documentation",
              args: ['{"query":"postgres ssh tunnel setup"}', '{"query":"salesforce required scopes"}'],
              results: ["Output: 4 docs matched, top: 'Connect Postgres over SSH'\nIsError: false"] },
            { name: "check_connection", description: "Test a source connection",
              args: ['{"source_id":"src_4471"}'],
              results: ["Output: reachable, latency 84ms, permissions OK\nIsError: false",
                        "Output: FAILED — permission denied for relation _sync_state\nIsError: false"] },
            { name: "create_source", description: "Create a source in the workspace",
              args: ['{"type":"postgres","host":"db.internal","tunnel":true}'],
              results: ["Output: Created src_4471\nIsError: false"] },
            { name: "run_sync", description: "Trigger a sync run",
              args: ['{"source_id":"src_4471","mode":"backfill","window_days":90}'],
              results: ["Output: Sync run_88213 started\nIsError: false"] },
        ],
    },
];

const ERRORS = [
    { type: "rate_limit_error", message: "Rate limit reached: 30000 input tokens per minute. Retry in 12s." },
    { type: "context_length_exceeded", message: "Request exceeds the model's context window (204,821 > 200,000 tokens)." },
    { type: "tool_execution_error", message: "Tool call failed: upstream returned 503 after 3 attempts." },
    { type: "timeout_error", message: "Upstream request timed out after 30000ms." },
    { type: "invalid_request_error", message: "Tool 'send_reply' called with a missing required argument: ticket_id." },
];

function pick<T>(items: readonly T[]): T {
    // Callers only pass non-empty literals, and the assertion keeps the return
    // type non-optional under noUncheckedIndexedAccess.
    return items[Math.floor(Math.random() * items.length)] as T;
}

function randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function hexId(bytes: number): string {
    return randomBytes(bytes).toString("hex");
}

/** A session stays on one workflow, derived from its id so callers need not pass it. */
function workflowFor(sessionId: string): Workflow {
    const h = createHash("sha1").update(sessionId).digest()[0] ?? 0;
    return WORKFLOWS[h % WORKFLOWS.length] as Workflow;
}

/** Occasionally a read returns a whole document, which is what exercises truncation. */
function largeToolOutput(): string {
    const block = [
        "  {",
        '    "sku": "AC-2291-BLK",',
        '    "description": "Aluminium bracket, black anodised",',
        '    "qty": 12,',
        '    "unit_price": 41.50,',
        '    "line_total": 498.00',
        "  },",
        "",
    ].join("\n");
    return `Output: ${block.repeat(randomInt(90, 190))}\nIsError: false`;
}

function emptySpanData(): SpanData {
    return {
        input_value: "", output_value: "", duration: 0, duration_ms: 0, duration_ns: 0,
        duration_seconds: 0, llm_model: "", provider: "", prompt_tokens: 0, completion_tokens: 0,
        total_tokens: 0, tool_name: "", tool_description: "", error_message: "", error_type: "",
        error_stacktrace: "", agent_name: "",
    };
}

function withDuration(data: SpanData, ms: number): SpanData {
    return { ...data, duration: ms, duration_ms: ms, duration_ns: Math.round(ms * 1e6), duration_seconds: ms / 1000 };
}

function makeSpan(params: {
    traceId: string; parentSpanId?: string; nodeType: NodeType; nodeName: string;
    data: SpanData; metadata: Record<string, string> | null; isError: boolean;
    createdAt: string; updatedAt: string;
}): Span {
    const span: Span = {
        span_id: hexId(8),
        traceId: params.traceId,
        node_type: params.nodeType,
        node_name: params.nodeName,
        status: params.isError ? "ERROR" : "SUCCESS",
        framework: "",
        data: params.data,
        span_metadata: params.metadata,
        detection_counts: {},
        detections: [],
        indexed_detections: [],
        createdAt: params.createdAt,
        updatedAt: params.updatedAt,
    };
    if (params.parentSpanId) span.parent_span_id = params.parentSpanId;
    return span;
}

export interface GenerateOptions {
    id: number;
    ts: number;
    sessionId: string;
    step: number;
    /** Last turn of the session, so a conclusive answer only lands at the end. */
    isLast?: boolean;
}

/**
 * Builds one trace: an `agent_action` root with a `chain` model call and zero or
 * more `tool_call` children, matching how an agent step is actually shaped.
 */
export function generateTrace(options: GenerateOptions): Trace {
    const traceId = hexId(16);
    const createdAt = new Date(options.ts).toISOString();
    const wf = workflowFor(options.sessionId);

    const { provider, model } = pick(MODELS);
    const isError = Math.random() < 0.07;
    const toolCount = isError ? 0 : randomInt(0, 3);
    const toolsUsed = Array.from({ length: toolCount }, () => pick(wf.tools));
    const concludes = !isError && options.isLast === true;

    const chainMs = randomInt(400, 9500);
    const toolDurations = toolsUsed.map(() => randomInt(2, 900));
    const rootMs = chainMs + toolDurations.reduce((sum, ms) => sum + ms, 0) + randomInt(5, 60);
    const updatedAt = new Date(options.ts + rootMs).toISOString();

    const promptTokens = randomInt(800, 24_000);
    const completionTokens = randomInt(40, 1_200);
    const totalTokens = promptTokens + completionTokens;

    // Turn 1 opens the thread; later turns continue it. A turn that calls no
    // tools is the one that answers.
    const input = options.step === 1 ? pick(wf.openers) : pick(wf.followUps);
    const toolNames = [...new Set(toolsUsed.map((t) => t.name))];
    const output = isError
        ? ""
        : concludes
            ? pick(wf.finals)
            : toolNames.length > 0
                ? `Ran ${toolNames.join(", ")} — continuing.`
                : "Thinking through the next step — continuing.";

    const spans: Span[] = [];
    const rootSpanId = hexId(8);

    const displayBlocks: DisplayBlock[] = [
        { type: "input", label: "Input", content: input },
        { type: "output", label: "Output", content: output },
    ];

    const root = makeSpan({
        traceId,
        nodeType: "agent_action",
        nodeName: `${wf.name}.turn`,
        data: {
            ...withDuration(emptySpanData(), rootMs),
            input_value: input,
            output_value: output,
            display_blocks: displayBlocks,
            agent_name: wf.name,
        },
        metadata: { "session.id": options.sessionId, "turn.index": String(options.step) },
        isError,
        createdAt,
        updatedAt,
    });
    root.span_id = rootSpanId;
    spans.push(root);

    const errorDetail = isError ? pick(ERRORS) : null;
    spans.push(makeSpan({
        traceId,
        parentSpanId: rootSpanId,
        nodeType: "chain",
        nodeName: `${provider} ${model}`,
        data: {
            ...withDuration(emptySpanData(), chainMs),
            input_value: JSON.stringify({ model, temperature: 0.2, tools: wf.tools.length, messages: options.step * 2 }),
            output_value: errorDetail ? "" : output,
            llm_model: model,
            provider,
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: totalTokens,
            error_message: errorDetail?.message ?? "",
            error_type: errorDetail?.type ?? "",
            error_stacktrace: errorDetail
                ? `ProviderError: ${errorDetail.message}\n    at completions.create (provider/${provider}.ts:214)`
                : "",
        },
        metadata: null,
        isError,
        createdAt,
        updatedAt,
    }));

    for (const [i, durationMs] of toolDurations.entries()) {
        const tool = toolsUsed[i] as Tool;
        spans.push(makeSpan({
            traceId,
            parentSpanId: rootSpanId,
            nodeType: "tool_call",
            nodeName: tool.name,
            data: {
                ...withDuration(emptySpanData(), durationMs),
                input_value: `Name: ${tool.name}\nArguments: ${pick(tool.args)}`,
                output_value: Math.random() < 0.02 ? largeToolOutput() : pick(tool.results),
                tool_name: tool.name,
                tool_description: tool.description,
            },
            metadata: { tool_name: tool.name },
            isError: false,
            createdAt,
            updatedAt,
        }));
    }

    return {
        id: options.id,
        ts: options.ts,
        _id: traceId,
        projectId: PROJECT_ID,
        name: `${wf.name}.turn`,
        framework: "",
        createdAt,
        updatedAt,
        latency: rootMs,
        spanCount: spans.length,
        llmCalls: 1,
        toolCalls: toolCount,
        retrievalCalls: 0,
        hasError: isError ? 1 : 0,
        errorCount: isError ? 1 : 0,
        promptTokens,
        completionTokens,
        totalTokensUsed: totalTokens,
        totalTokensCost: Number(((promptTokens * 3 + completionTokens * 15) / 1_000_000).toFixed(6)),
        input,
        output,
        tags: [wf.name, `v${wf.version}`, wf.env],
        workflowName: wf.name,
        sessionId: options.sessionId,
        spans,
        detection_counts: {},
        detections: [],
        status: isError ? "error" : "success",
        projection: "session",
    };
}

/*
 * Real ingest interleaves many sessions at once and their lengths are heavily
 * skewed: most threads are a handful of turns, a few run for hours. A fixed
 * eight-turn rotation produced neither, which is why nothing downstream ever
 * had to cope with a large session.
 */
function sampleSessionLength(): number {
    const r = Math.random();
    if (r < 0.75) return randomInt(2, 15);      // ordinary exchanges
    if (r < 0.95) return randomInt(20, 90);     // working sessions
    return randomInt(150, 900);                 // long-running agents
}

interface OpenSession {
    id: string;
    workflow: Workflow;
    turn: number;
    target: number;
}

export interface RotatorOptions {
    poolSize?: number;
    /** Long-lived threads that keep receiving turns, so there is always a
     *  session growing live rather than a static transcript. */
    residents?: number;
    /** Share of turns routed to residents. The remainder opens and closes
     *  ordinary short threads, so the conversations view has a mix to show. */
    residentShare?: number;
    /** Where a resident thread rotates. Infinite by default: the live thread
     *  never ends, so whatever is open is always the large one. */
    residentTurns?: number;
}

export function createSessionRotator(options: RotatorOptions = {}) {
    const poolSize = options.poolSize ?? 4;
    // One thread at a time, taking everything. Both views then grow at the same
    // rate, because the list's rate is the sum of all sessions and there is only
    // one. The cost is that the list shows a single conversation at a time
    // rather than a mix, which is the price of the two rates matching.
    //
    // That thread never rotates. A finite ceiling meant the live thread spent
    // half its life too small to be worth opening: it climbed to the ceiling,
    // retired, and its successor started at zero, so whether clicking through
    // reached a large conversation was a matter of when you looked. Left
    // running, it is the buffer that bounds it instead of a counter — the ring
    // evicts its oldest turns and it settles at roughly capacity, permanently
    // live and permanently large.
    const residentCount = options.residents ?? 1;
    // Not quite all of it. At 1.0 the pool never runs and the buffer ends up
    // holding a single conversation, which leaves the conversations view with
    // one row; the few percent held back is enough to keep short threads
    // opening and closing alongside it, and moves the two pages' rates apart
    // by less than the readout's precision.
    const residentShare = options.residentShare ?? 0.95;
    const residentTurns = options.residentTurns ?? Number.POSITIVE_INFINITY;
    const residentTarget = () => residentTurns;

    const open = (target?: number): OpenSession => {
        const id = randomUUID();
        return { id, workflow: workflowFor(id), turn: 0, target: target ?? sampleSessionLength() };
    };

    const pool: OpenSession[] = Array.from({ length: poolSize }, () => open());
    const residents: OpenSession[] = Array.from({ length: residentCount }, () => open(residentTarget()));

    const advance = (group: OpenSession[], index: number, target?: number) => {
        const session = group[index] as OpenSession;
        session.turn += 1;
        const isLast = session.turn >= session.target;
        const result = { sessionId: session.id, step: session.turn, isLast };
        if (isLast) group[index] = open(target);
        return result;
    };

    return function next(): { sessionId: string; step: number; isLast: boolean } {
        if (residentCount > 0 && Math.random() < residentShare) {
            return advance(residents, Math.floor(Math.random() * residents.length), residentTarget());
        }
        return advance(pool, Math.floor(Math.random() * pool.length));
    };
}

export { PROJECT_ID, WORKFLOWS };
