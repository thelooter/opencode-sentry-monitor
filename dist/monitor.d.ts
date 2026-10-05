import type { Plugin } from "@opencode/plugin";
import type { PluginLogger, ResolvedPluginConfig } from "./config.js";
export type OpenCodeEvent = ReturnType<Plugin.Context["event"]["subscribe"]> extends AsyncIterable<infer Event> ? Event : never;
export interface ToolCallStart {
    readonly tool: string;
    readonly sessionID: string;
    readonly id: string;
    readonly input: unknown;
}
export type ToolCallEnd = ToolCallStart & ({
    readonly status: "completed";
    readonly result: unknown;
} | {
    readonly status: "error";
    readonly error: {
        readonly message: string;
    };
});
export interface SessionMonitorOptions {
    config: ResolvedPluginConfig;
    projectName: string;
    agentName: string;
    logger: PluginLogger;
}
/**
 * Turns the OpenCode event stream and tool hooks of one location into Sentry
 * AI Monitoring spans, metrics, and error reports.
 */
export declare class SessionMonitor {
    private readonly config;
    private readonly projectName;
    private readonly agentName;
    private readonly logger;
    private readonly sessions;
    private flushing;
    constructor(options: SessionMonitorOptions);
    handleEvent(event: OpenCodeEvent): void;
    toolStarted(call: ToolCallStart): void;
    toolFinished(call: ToolCallEnd): void;
    /** Sends buffered data to Sentry. Concurrent calls share one flush. */
    flush(reason: string): Promise<void>;
    /** Ends every open span. Called when the plugin is unloaded. */
    dispose(): void;
    private dispatch;
    private session;
    private setModel;
    private baseAttributes;
    private metricAttributes;
    private startExecution;
    private finishExecution;
    /** Ends step, tool, and compaction spans that never saw their end event. */
    private closeOpenSpans;
    private endToolSpan;
    private startStep;
    private recordStepText;
    private finishStep;
    private startCompaction;
    private finishCompaction;
    private recordTokenMetrics;
    private diagnostics;
}
//# sourceMappingURL=monitor.d.ts.map