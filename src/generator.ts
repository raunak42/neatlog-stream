import { randomBytes, randomUUID } from "node:crypto";
import type { DisplayBlock, NodeType, Span, SpanData, Trace } from "./types.js";

/** Placeholder. Real ids are per-account and have no business in a demo. */
const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const WORKFLOW = "perry";

const MODELS = [
    { provider: "opencode", model: "deepseek-v4-flash-free" },
    { provider: "opencode", model: "claude-sonnet-5" },
    { provider: "opencode", model: "gpt-5.4-mini" },
    { provider: "openai-codex", model: "gpt-5.4" },
    { provider: "openrouter", model: "anthropic/claude-opus-4-6" },
];

const TOOLS = [
    { name: "read", description: "Read a file from the project" },
    { name: "write", description: "Create or overwrite a file" },
    { name: "edit", description: "Exact-text replacement in a file" },
    { name: "run_command", description: "Execute a shell command" },
    { name: "mcp__github__search_issues", description: "Search GitHub issues" },
];

const TOOL_INPUTS: Record<string, string[]> = {
    read: ['{"path":"src/server.ts","offset":1,"limit":300}', '{"path":"package.json"}'],
    write: ['{"path":"src/store.ts","content":"…"}', '{"path":"README.md","content":"…"}'],
    edit: ['{"path":"src/rest.ts","old":"limit","new":"pageSize"}'],
    run_command: ['{"command":"npm test"}', '{"command":"git status --short"}', '{"command":"ls -la"}'],
    mcp__github__search_issues: ['{"query":"is:open label:bug"}'],
};

/** Occasionally a read returns a whole file, which is what exercises truncation. */
function largeFileOutput(): string {
    const block = [
        ".calc {",
        "  position: relative;",
        "  border-radius: 40px;",
        "  background: linear-gradient(180deg, rgba(255,255,255,0.1), rgba(255,255,255,0.04));",
        "  box-shadow: 0 30px 60px -15px rgba(0,0,0,0.6);",
        "}",
        "",
    ].join("\n");
    return `Output: ${block.repeat(randomInt(140, 420))}\nIsError: false`;
}

const TOOL_OUTPUTS: Record<string, string[]> = {
    read: ["Output: import express from 'express';\n…\nIsError: false"],
    write: ["Output: Wrote 42 lines to src/store.ts\nIsError: false"],
    edit: ["Output: Applied 1 replacement\nIsError: false"],
    run_command: ["STDOUT:\n238 pass\n0 fail\n\nEXIT CODE: 0", "STDOUT:\n M src/server.ts\n\nEXIT CODE: 0"],
    mcp__github__search_issues: ["Output: 3 issues matched\nIsError: false"],
};

const TASKS = [
    "add cursor pagination to the history endpoint",
    "why did the live tail drop a message?",
    "refactor the ring buffer to avoid array shift",
    "wire the websocket handshake to the store",
    "explain the reconciliation contract",
    "cap memory growth over long uptime",
    "make the generator run without clients connected",
];

const ERRORS = [
    { type: "invalid_request_error", message: "The reasoning_content in the thinking mode must be passed back to the API." },
    { type: "rate_limit_error", message: "Rate limit exceeded. Please try again later." },
    { type: "timeout_error", message: "Upstream request timed out after 30000ms." },
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

function emptySpanData(): SpanData {
    return {
        input_value: "",
        output_value: "",
        duration: 0,
        duration_ms: 0,
        duration_ns: 0,
        duration_seconds: 0,
        llm_model: "",
        provider: "",
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        tool_name: "",
        tool_description: "",
        error_message: "",
        error_type: "",
        error_stacktrace: "",
        agent_name: "",
    };
}

function withDuration(data: SpanData, ms: number): SpanData {
    return {
        ...data,
        duration: ms,
        duration_ms: ms,
        duration_ns: Math.round(ms * 1e6),
        duration_seconds: ms / 1000,
    };
}

function makeSpan(params: {
    traceId: string;
    parentSpanId?: string;
    nodeType: NodeType;
    nodeName: string;
    data: SpanData;
    metadata: Record<string, string> | null;
    isError: boolean;
    createdAt: string;
    updatedAt: string;
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
}

/**
 * Builds one trace: an `agent_action` root with a `chain` model call and zero or
 * more `tool_call` children, matching how an agent step is actually shaped.
 */
export function generateTrace(options: GenerateOptions): Trace {
    const traceId = hexId(16);
    const createdAt = new Date(options.ts).toISOString();

    const { provider, model } = pick(MODELS);
    const isError = Math.random() < 0.07;
    const toolCount = isError ? 0 : randomInt(0, 3);

    const chainMs = randomInt(400, 9500);
    const toolDurations = Array.from({ length: toolCount }, () => randomInt(2, 900));
    const rootMs = chainMs + toolDurations.reduce((sum, ms) => sum + ms, 0) + randomInt(5, 60);
    const updatedAt = new Date(options.ts + rootMs).toISOString();

    const promptTokens = randomInt(800, 24_000);
    const completionTokens = randomInt(40, 1_200);
    const cachedTokens = Math.floor(promptTokens * (Math.random() * 0.8));
    const totalTokens = promptTokens + completionTokens;

    const spans: Span[] = [];
    const rootSpanId = hexId(8);
    const task = pick(TASKS);

    const displayBlocks: DisplayBlock[] = [
        { type: "input", label: "Input", content: options.step === 1 ? task : `step ${options.step}` },
        { type: "output", label: "Output", content: toolCount > 0 ? "continue" : "done" },
    ];

    const root = makeSpan({
        traceId,
        nodeType: "agent_action",
        nodeName: `perry.turn step ${options.step}`,
        data: {
            ...withDuration(emptySpanData(), rootMs),
            input_value: options.step === 1 ? task : `step ${options.step}`,
            output_value: toolCount > 0 ? "continue" : "done",
            display_blocks: displayBlocks,
            agent_name: WORKFLOW,
        },
        metadata: { "session.id": options.sessionId },
        isError,
        createdAt,
        updatedAt,
    });
    root.span_id = rootSpanId;
    spans.push(root);

    const errorDetail = isError ? pick(ERRORS) : null;
    const chainData: SpanData = {
        ...withDuration(emptySpanData(), chainMs),
        input_value: JSON.stringify({ provider, model, reasoningLevel: "high", toolCount: 5 }),
        output_value: errorDetail
            ? ""
            : `Output: ${toolCount > 0 ? `${toolCount} tool call(s) requested` : "final assistant message"}`,
        llm_model: model,
        provider,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
        error_message: errorDetail?.message ?? "",
        error_type: errorDetail?.type ?? "",
        error_stacktrace: errorDetail ? `ProviderRequestError: ${errorDetail.message}\n    at getOpencodeResponse` : "",
    };

    spans.push(makeSpan({
        traceId,
        parentSpanId: rootSpanId,
        nodeType: "chain",
        nodeName: `${provider} ${model}`,
        data: chainData,
        metadata: null,
        isError,
        createdAt,
        updatedAt,
    }));

    for (const durationMs of toolDurations) {
        const tool = pick(TOOLS);
        const toolSpan = makeSpan({
            traceId,
            parentSpanId: rootSpanId,
            nodeType: "tool_call",
            nodeName: tool.name,
            data: {
                ...withDuration(emptySpanData(), durationMs),
                input_value: `Name: ${tool.name}\nArguments: ${pick(TOOL_INPUTS[tool.name] ?? ["{}"])}`,
                output_value: tool.name === "read" && Math.random() < 0.25
                    ? largeFileOutput()
                    : pick(TOOL_OUTPUTS[tool.name] ?? ["Output: ok"]),
                tool_name: tool.name,
                tool_description: tool.description,
            },
            metadata: { tool_name: tool.name },
            isError: false,
            createdAt,
            updatedAt,
        });
        spans.push(toolSpan);
    }

    return {
        id: options.id,
        ts: options.ts,
        _id: traceId,
        projectId: PROJECT_ID,
        name: `perry.turn step ${options.step}`,
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
        tags: [WORKFLOW, `${WORKFLOW}@0.1.10`],
        workflowName: WORKFLOW,
        sessionId: options.sessionId,
        spans,
        detection_counts: {},
        detections: [],
        status: isError ? "error" : "success",
        projection: "session",
    };
}

/** Sessions span several consecutive traces, as a real agent session does. */
export function createSessionRotator(stepsPerSession = 8) {
    let sessionId = randomUUID();
    let step = 0;

    return function next(): { sessionId: string; step: number } {
        step += 1;
        if (step > stepsPerSession) {
            sessionId = randomUUID();
            step = 1;
        }
        return { sessionId, step };
    };
}

export { PROJECT_ID, WORKFLOW };
