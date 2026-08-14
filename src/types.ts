/**
 * Trace and span shapes mirroring the Neatlogs read API
 * (`GET /api/traces/v3/:traceId?projection=session`).
 *
 * Two fields are additions rather than part of that API:
 *
 *  - `id`  a monotonically increasing integer. Neatlogs identifies a trace by a
 *          hex `_id`, which cannot be ordered or compared, so cursor pagination
 *          and the WebSocket handshake anchor on this instead.
 *  - `ts`  the creation time as unix milliseconds, alongside the ISO
 *          `createdAt` the real API returns. Cheaper to sort and compare.
 *
 * Everything else matches the observed response, including the quirk that
 * `data` is a fixed set of fields rather than an attribute bag: every span
 * carries every key, empty or zero where it does not apply.
 */

export type NodeType = "agent_action" | "chain" | "tool_call" | "retrieval";

export type SpanStatus = "SUCCESS" | "ERROR";

export type TraceStatus = "success" | "error";

export interface DisplayBlock {
    type: "input" | "output";
    label: string;
    content: string;
}

/** Fixed-schema span payload. Absent values are "" or 0, never omitted. */
export interface SpanData {
    input_value: string;
    output_value: string;
    display_blocks?: DisplayBlock[];
    duration: number;
    duration_ms: number;
    duration_ns: number;
    duration_seconds: number;
    llm_model: string;
    provider: string;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    tool_name: string;
    tool_description: string;
    error_message: string;
    error_type: string;
    error_stacktrace: string;
    agent_name: string;
}

export interface Span {
    span_id: string;
    /** Absent on the root span — that is how the root is identified. */
    parent_span_id?: string;
    traceId: string;
    node_type: NodeType;
    node_name: string;
    status: SpanStatus;
    framework: string;
    data: SpanData;
    span_metadata: Record<string, string> | null;
    detection_counts: Record<string, number>;
    detections: unknown[];
    indexed_detections: unknown[];
    createdAt: string;
    updatedAt: string;
    output_truncated?: boolean;
    payload_signed_url?: string;
    session_projection?: {
        content_limit: number;
        truncated: boolean;
        truncated_fields: string[];
    };
}

export interface Trace {
    /** Cursor. Not part of the Neatlogs API; see the note at the top of this file. */
    id: number;
    /** Creation time in unix ms. Not part of the Neatlogs API. */
    ts: number;

    _id: string;
    projectId: string;
    name: string;
    framework: string;
    createdAt: string;
    updatedAt: string;

    /** Rollups the UI header reads directly rather than reducing `spans`. */
    latency: number;
    spanCount: number;
    llmCalls: number;
    toolCalls: number;
    retrievalCalls: number;
    hasError: 0 | 1;
    errorCount: number;
    promptTokens: number;
    completionTokens: number;
    totalTokensUsed: number;
    totalTokensCost: number;

    tags: string[];
    workflowName: string;
    sessionId: string;

    spans: Span[];

    detection_counts: Record<string, number>;
    detections: unknown[];
    status: TraceStatus;
    projection: "session";
}

export interface HistoryResponse {
    logs: Trace[];
    nextCursor: number | null;
    hasMore: boolean;
}

export type ServerMessage =
    | { type: "connected"; lastLogId: number }
    | { type: "log"; data: Trace };
