import type { Plugin } from "@opencode/plugin";
import * as Sentry from "@sentry/node";
import type { PluginLogger, ResolvedPluginConfig } from "./config.js";
import { serializeAttribute } from "./serialize.js";

type SentrySpan = ReturnType<typeof Sentry.startInactiveSpan>;

export type OpenCodeEvent =
  ReturnType<Plugin.Context["event"]["subscribe"]> extends AsyncIterable<
    infer Event
  >
    ? Event
    : never;

type EventOf<Type extends OpenCodeEvent["type"]> = Extract<
  OpenCodeEvent,
  { type: Type }
>;

interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cache: {
    read: number;
    write: number;
  };
}

export interface ToolCallStart {
  readonly tool: string;
  readonly sessionID: string;
  readonly id: string;
  readonly input: unknown;
}

export type ToolCallEnd = ToolCallStart &
  (
    | { readonly status: "completed"; readonly result: unknown }
    | { readonly status: "error"; readonly error: { readonly message: string } }
  );

interface StepState {
  span: SentrySpan;
  startedAt: number;
  providerID: string;
  modelID: string;
  textParts: string[];
  textLength: number;
}

interface SessionState {
  providerID: string;
  modelID: string;
  agent?: string;
  parentID?: string;
  inputText?: string;
  outputText?: string;
  executionSpan?: SentrySpan;
  compactionSpan?: SentrySpan;
  steps: Map<string, StepState>;
  toolSpans: Map<string, SentrySpan>;
}

export interface SessionMonitorOptions {
  config: ResolvedPluginConfig;
  projectName: string;
  agentName: string;
  logger: PluginLogger;
}

const MAX_SESSIONS = 1024;
const MAX_STEP_TEXT_PARTS = 128;
const UNKNOWN_PROVIDER = "unknown";
const UNKNOWN_MODEL = "unknown-model";

function setSpanStatus(span: SentrySpan, isError: boolean): void {
  span.setStatus({ code: isError ? 2 : 1 });
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const omitted = value.length - maxLength;
  return `${value.slice(0, maxLength)}...[truncated ${omitted} chars]`;
}

function attachTokenUsage(span: SentrySpan, tokens: TokenUsage): void {
  span.setAttribute("gen_ai.usage.input_tokens", tokens.input);
  span.setAttribute("gen_ai.usage.output_tokens", tokens.output);
  span.setAttribute("gen_ai.usage.output_tokens.reasoning", tokens.reasoning);
  span.setAttribute("gen_ai.usage.input_tokens.cached", tokens.cache.read);
  span.setAttribute(
    "gen_ai.usage.input_tokens.cache_write",
    tokens.cache.write,
  );
  span.setAttribute("gen_ai.usage.total_tokens", tokens.input + tokens.output);
}

/**
 * Turns the OpenCode event stream and tool hooks of one location into Sentry
 * AI Monitoring spans, metrics, and error reports.
 */
export class SessionMonitor {
  private readonly config: ResolvedPluginConfig;
  private readonly projectName: string;
  private readonly agentName: string;
  private readonly logger: PluginLogger;
  private readonly sessions = new Map<string, SessionState>();
  private flushing: Promise<void> | undefined;

  constructor(options: SessionMonitorOptions) {
    this.config = options.config;
    this.projectName = options.projectName;
    this.agentName = options.agentName;
    this.logger = options.logger;
  }

  handleEvent(event: OpenCodeEvent): void {
    try {
      this.dispatch(event);
    } catch (error) {
      this.logger.warn("Failed to process OpenCode event", {
        error: error instanceof Error ? error.message : String(error),
        eventType: event.type,
      });
    }
  }

  toolStarted(call: ToolCallStart): void {
    try {
      this.diagnostics("tool.execute.before", () => ({
        sessionID: call.sessionID,
        callID: call.id,
        tool: call.tool,
      }));

      const state = this.session(call.sessionID);
      this.endToolSpan(state, call.id, true);

      const span = Sentry.startInactiveSpan({
        parentSpan: state.executionSpan ?? null,
        op: "gen_ai.execute_tool",
        name: `execute_tool ${call.tool}`,
        attributes: {
          ...this.baseAttributes(call.sessionID, state),
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": call.tool,
          "opencode.call.id": call.id,
        },
      });
      state.toolSpans.set(call.id, span);

      if (this.config.recordInputs) {
        span.setAttribute(
          "gen_ai.tool.input",
          serializeAttribute(call.input, this.config.maxAttributeLength),
        );
      }
    } catch (error) {
      this.logger.warn("Failed to start tool span", {
        error: error instanceof Error ? error.message : String(error),
        sessionID: call.sessionID,
        callID: call.id,
        tool: call.tool,
      });
    }
  }

  toolFinished(call: ToolCallEnd): void {
    try {
      this.diagnostics("tool.execute.after", () => ({
        sessionID: call.sessionID,
        callID: call.id,
        tool: call.tool,
        status: call.status,
      }));

      const isError = call.status === "error";
      const state = this.sessions.get(call.sessionID);
      const span = state?.toolSpans.get(call.id);

      if (span) {
        const output = call.status === "error" ? call.error : call.result;
        const serializedOutput =
          this.config.recordOutputs || isError
            ? serializeAttribute(output, this.config.maxAttributeLength)
            : undefined;

        if (this.config.recordOutputs && serializedOutput !== undefined) {
          span.setAttribute("gen_ai.tool.output", serializedOutput);
        }

        if (call.status === "error") {
          span.setAttribute("error.message", call.error.message);
          Sentry.captureMessage(`Tool execution error: ${call.tool}`, {
            level: "error",
            tags: {
              "opencode.session.id": call.sessionID,
              "opencode.call.id": call.id,
              "opencode.tool": call.tool,
              ...this.config.tags,
            },
            extra: {
              output: serializedOutput,
            },
          });
        }

        setSpanStatus(span, isError);
        span.end();
        state?.toolSpans.delete(call.id);
      } else {
        this.diagnostics("Missing tool span for tool.execute.after", () => ({
          sessionID: call.sessionID,
          callID: call.id,
          tool: call.tool,
        }));
      }

      if (this.config.enableMetrics) {
        Sentry.metrics.count("gen_ai.client.tool.execution", 1, {
          attributes: {
            "gen_ai.agent.name": this.agentName,
            "gen_ai.tool.name": call.tool,
            "opencode.project.name": this.projectName,
            status: isError ? "error" : "ok",
            ...this.config.tags,
          },
        });
      }
    } catch (error) {
      this.logger.warn("Failed to finish tool span", {
        error: error instanceof Error ? error.message : String(error),
        sessionID: call.sessionID,
        callID: call.id,
        tool: call.tool,
      });
    }
  }

  /** Sends buffered data to Sentry. Concurrent calls share one flush. */
  flush(reason: string): Promise<void> {
    if (this.flushing) {
      return this.flushing;
    }

    const started = Date.now();
    const { flushTimeoutMs } = this.config;

    this.flushing = Sentry.flush(flushTimeoutMs)
      .then(
        (flushed) => {
          this.diagnostics("Sentry flush completed", () => ({
            reason,
            flushed,
            flushTimeoutMs,
            durationMs: Date.now() - started,
          }));
        },
        (error: unknown) => {
          this.logger.warn("Sentry flush failed", {
            reason,
            flushTimeoutMs,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      )
      .finally(() => {
        this.flushing = undefined;
      });

    return this.flushing;
  }

  /** Ends every open span. Called when the plugin is unloaded. */
  dispose(): void {
    for (const state of this.sessions.values()) {
      this.closeOpenSpans(state, false);
      state.executionSpan?.end();
    }
    this.sessions.clear();
  }

  private dispatch(event: OpenCodeEvent): void {
    switch (event.type) {
      case "session.created": {
        const state = this.session(event.data.sessionID);
        state.parentID = event.data.parentID;
        state.agent = event.data.agent;
        if (event.data.model) {
          state.providerID = event.data.model.providerID;
          state.modelID = event.data.model.id;
        }
        break;
      }

      case "session.model.selected": {
        this.setModel(
          this.session(event.data.sessionID),
          event.data.model.providerID,
          event.data.model.id,
        );
        break;
      }

      case "session.agent.selected": {
        this.session(event.data.sessionID).agent = event.data.agent;
        break;
      }

      case "session.inbox.enqueued": {
        const { item } = event.data;
        if (item.type !== "user" && item.type !== "synthetic") {
          break;
        }
        if (!this.config.recordInputs) {
          break;
        }

        const text = item.payload.text.trim();
        if (text.length > 0) {
          this.session(event.data.sessionID).inputText = truncateText(
            text,
            this.config.maxAttributeLength,
          );
        }
        break;
      }

      case "session.execution.started": {
        this.startExecution(event.data.sessionID);
        break;
      }

      case "session.execution.succeeded": {
        this.finishExecution(event.data.sessionID, event.type, false);
        break;
      }

      case "session.execution.interrupted": {
        const state = this.sessions.get(event.data.sessionID);
        state?.executionSpan?.setAttribute(
          "opencode.execution.interrupted",
          event.data.reason,
        );
        this.finishExecution(event.data.sessionID, event.type, false);
        break;
      }

      case "session.execution.failed": {
        const state = this.sessions.get(event.data.sessionID);
        state?.executionSpan?.setAttribute(
          "error.message",
          event.data.error.message,
        );

        Sentry.captureMessage("OpenCode session.error", {
          level: "error",
          tags: {
            "opencode.session.id": event.data.sessionID,
            ...this.config.tags,
          },
          extra: {
            payload: serializeAttribute(
              event.data.error,
              this.config.maxAttributeLength,
            ),
          },
        });

        this.finishExecution(event.data.sessionID, event.type, true);
        break;
      }

      case "session.step.started": {
        this.startStep(event);
        break;
      }

      case "session.text.ended": {
        this.recordStepText(event);
        break;
      }

      case "session.step.ended": {
        this.finishStep(
          event.data.sessionID,
          event.data.assistantMessageID,
          event.created,
          {
            tokens: event.data.tokens,
            cost: event.data.cost,
            finish: event.data.finish,
          },
        );
        break;
      }

      case "session.step.failed": {
        this.finishStep(
          event.data.sessionID,
          event.data.assistantMessageID,
          event.created,
          {
            tokens: event.data.tokens,
            cost: event.data.cost,
            finish: event.data.finish,
            error: event.data.error.message,
          },
        );
        break;
      }

      case "session.compaction.started": {
        this.startCompaction(event);
        break;
      }

      case "session.compaction.ended": {
        const state = this.sessions.get(event.data.sessionID);
        if (state && event.data.model) {
          state.compactionSpan?.setAttribute(
            "gen_ai.request.model",
            event.data.model.id,
          );
          state.compactionSpan?.setAttribute(
            "opencode.model.provider",
            event.data.model.providerID,
          );
        }
        this.finishCompaction(event.data.sessionID, {
          tokens: event.data.tokens,
          cost: event.data.cost,
          providerID: event.data.model?.providerID,
          modelID: event.data.model?.id,
        });
        break;
      }

      case "session.compaction.failed": {
        this.finishCompaction(event.data.sessionID, {
          tokens: event.data.tokens,
          cost: event.data.cost,
          error: event.data.error.message,
        });
        break;
      }

      case "session.deleted": {
        const state = this.sessions.get(event.data.sessionID);
        if (state) {
          this.closeOpenSpans(state, false);
          state.executionSpan?.end();
          this.sessions.delete(event.data.sessionID);
          void this.flush(event.type);
        }
        break;
      }

      default:
        break;
    }
  }

  private session(sessionID: string): SessionState {
    const existing = this.sessions.get(sessionID);
    if (existing) {
      // Re-insert so the map stays ordered by last use.
      this.sessions.delete(sessionID);
      this.sessions.set(sessionID, existing);
      return existing;
    }

    if (this.sessions.size >= MAX_SESSIONS) {
      for (const [id, state] of this.sessions) {
        if (!state.executionSpan) {
          this.closeOpenSpans(state, false);
          this.sessions.delete(id);
          break;
        }
      }
    }

    const created: SessionState = {
      providerID: UNKNOWN_PROVIDER,
      modelID: UNKNOWN_MODEL,
      steps: new Map(),
      toolSpans: new Map(),
    };
    this.sessions.set(sessionID, created);
    return created;
  }

  private setModel(
    state: SessionState,
    providerID: string,
    modelID: string,
  ): void {
    state.providerID = providerID;
    state.modelID = modelID;
    state.executionSpan?.setAttribute("gen_ai.request.model", modelID);
    state.executionSpan?.setAttribute("opencode.model.provider", providerID);
  }

  private baseAttributes(
    sessionID: string,
    state: SessionState,
  ): Record<string, string> {
    return {
      "gen_ai.agent.name": this.agentName,
      "gen_ai.request.model": state.modelID,
      "gen_ai.conversation.id": sessionID,
      "opencode.model.provider": state.providerID,
      "opencode.session.id": sessionID,
      "opencode.project.name": this.projectName,
      ...(state.agent ? { "opencode.agent": state.agent } : {}),
      ...(state.parentID
        ? { "opencode.session.parent_id": state.parentID }
        : {}),
      ...this.config.tags,
    };
  }

  private metricAttributes(
    providerID: string,
    modelID: string,
  ): Record<string, string> {
    return {
      "gen_ai.agent.name": this.agentName,
      "opencode.project.name": this.projectName,
      "gen_ai.request.model": modelID,
      "opencode.model.provider": providerID,
      ...this.config.tags,
    };
  }

  private startExecution(sessionID: string): void {
    const state = this.session(sessionID);
    if (state.executionSpan) {
      this.finishExecution(sessionID, "session.execution.started", false);
    }

    state.outputText = undefined;
    state.executionSpan = Sentry.startInactiveSpan({
      parentSpan: null,
      forceTransaction: true,
      op: "gen_ai.invoke_agent",
      name: `invoke_agent ${this.agentName}`,
      attributes: {
        ...this.baseAttributes(sessionID, state),
        "gen_ai.operation.name": "invoke_agent",
        "opencode.capture.session_events": this.config.includeSessionEvents,
      },
    });
  }

  private finishExecution(
    sessionID: string,
    reason: string,
    isError: boolean,
  ): void {
    const state = this.sessions.get(sessionID);
    if (!state) {
      return;
    }

    if (this.config.includeSessionEvents) {
      Sentry.addBreadcrumb({
        category: "opencode.session",
        level: isError ? "error" : "info",
        message: reason,
        data: { sessionID },
      });
    }

    const pendingSpans = this.closeOpenSpans(state, true);
    const span = state.executionSpan;
    state.executionSpan = undefined;

    if (!span) {
      this.diagnostics("Execution ended with no active span", () => ({
        sessionID,
        reason,
        pendingSpans,
      }));
      return;
    }

    if (this.config.recordOutputs && state.outputText) {
      span.setAttribute(
        "gen_ai.response.text",
        serializeAttribute([state.outputText], this.config.maxAttributeLength),
      );
    }

    setSpanStatus(span, isError);
    span.end();
    void this.flush(reason);
  }

  /** Ends step, tool, and compaction spans that never saw their end event. */
  private closeOpenSpans(state: SessionState, isError: boolean): number {
    let closed = 0;

    for (const callID of [...state.toolSpans.keys()]) {
      this.endToolSpan(state, callID, isError);
      closed += 1;
    }

    for (const step of state.steps.values()) {
      setSpanStatus(step.span, isError);
      step.span.end();
      closed += 1;
    }
    state.steps.clear();

    if (state.compactionSpan) {
      setSpanStatus(state.compactionSpan, isError);
      state.compactionSpan.end();
      state.compactionSpan = undefined;
      closed += 1;
    }

    return closed;
  }

  private endToolSpan(
    state: SessionState,
    callID: string,
    isError: boolean,
  ): void {
    const span = state.toolSpans.get(callID);
    if (!span) {
      return;
    }

    setSpanStatus(span, isError);
    span.end();
    state.toolSpans.delete(callID);
  }

  private startStep(event: EventOf<"session.step.started">): void {
    const { sessionID, assistantMessageID, model, agent, started } = event.data;
    const state = this.session(sessionID);
    state.agent = agent;
    state.executionSpan?.setAttribute("opencode.agent", agent);
    this.setModel(state, model.providerID, model.id);

    if (!this.config.includeMessageUsageSpans) {
      return;
    }

    const previous = state.steps.get(assistantMessageID);
    if (previous) {
      setSpanStatus(previous.span, true);
      previous.span.end();
    }

    const span = Sentry.startInactiveSpan({
      parentSpan: state.executionSpan ?? null,
      op: "gen_ai.request",
      name: `request ${model.id}`,
      startTime: started / 1000,
      attributes: {
        ...this.baseAttributes(sessionID, state),
        "gen_ai.operation.name": "request",
        "opencode.message.id": assistantMessageID,
      },
    });

    if (this.config.recordInputs && state.inputText) {
      const messages = serializeAttribute(
        [{ role: "user", content: state.inputText }],
        this.config.maxAttributeLength,
      );
      span.setAttribute("gen_ai.request.messages", messages);
      state.executionSpan?.setAttribute("gen_ai.request.messages", messages);
    }

    state.steps.set(assistantMessageID, {
      span,
      startedAt: started,
      providerID: model.providerID,
      modelID: model.id,
      textParts: [],
      textLength: 0,
    });
  }

  private recordStepText(event: EventOf<"session.text.ended">): void {
    if (!this.config.recordOutputs) {
      return;
    }

    const step = this.sessions
      .get(event.data.sessionID)
      ?.steps.get(event.data.assistantMessageID);
    if (!step) {
      return;
    }

    const text = event.data.text.trim();
    if (
      text.length === 0 ||
      step.textParts.length >= MAX_STEP_TEXT_PARTS ||
      step.textLength >= this.config.maxAttributeLength
    ) {
      return;
    }

    step.textParts.push(text);
    step.textLength += text.length;
  }

  private finishStep(
    sessionID: string,
    assistantMessageID: string,
    endedAt: number,
    result: {
      tokens?: TokenUsage;
      cost?: number;
      finish?: string;
      error?: string;
    },
  ): void {
    const state = this.sessions.get(sessionID);
    const step = state?.steps.get(assistantMessageID);
    if (!state || !step) {
      return;
    }
    state.steps.delete(assistantMessageID);

    const { span } = step;

    if (step.textParts.length > 0) {
      const text = truncateText(
        step.textParts.join("\n\n"),
        this.config.maxAttributeLength,
      );
      state.outputText = text;
      span.setAttribute(
        "gen_ai.response.text",
        serializeAttribute([text], this.config.maxAttributeLength),
      );
    }

    if (result.finish) {
      span.setAttribute("gen_ai.response.finish_reasons", [result.finish]);
    }
    if (result.cost !== undefined) {
      span.setAttribute("opencode.cost.usd", result.cost);
    }
    if (result.error !== undefined) {
      span.setAttribute("error.message", result.error);
    }
    if (result.tokens) {
      attachTokenUsage(span, result.tokens);
    }

    setSpanStatus(span, result.error !== undefined);
    span.end();

    if (this.config.enableMetrics) {
      const attributes = this.metricAttributes(step.providerID, step.modelID);
      if (result.tokens) {
        this.recordTokenMetrics(result.tokens, attributes);
      }

      const durationMs = endedAt - step.startedAt;
      if (durationMs > 0) {
        Sentry.metrics.distribution(
          "gen_ai.client.response.duration",
          durationMs,
          { attributes, unit: "millisecond" },
        );
      }
    }
  }

  private startCompaction(event: EventOf<"session.compaction.started">): void {
    if (!this.config.includeMessageUsageSpans) {
      return;
    }

    const { sessionID } = event.data;
    const state = this.session(sessionID);
    if (state.compactionSpan) {
      setSpanStatus(state.compactionSpan, true);
      state.compactionSpan.end();
    }

    state.compactionSpan = Sentry.startInactiveSpan({
      parentSpan: state.executionSpan ?? null,
      op: "gen_ai.request",
      name: `compaction ${state.modelID}`,
      attributes: {
        ...this.baseAttributes(sessionID, state),
        "gen_ai.operation.name": "request",
        "opencode.request.kind": "compaction",
        "opencode.compaction.reason": event.data.reason,
      },
    });
  }

  private finishCompaction(
    sessionID: string,
    result: {
      tokens?: TokenUsage;
      cost?: number;
      providerID?: string;
      modelID?: string;
      error?: string;
    },
  ): void {
    const state = this.sessions.get(sessionID);
    if (!state) {
      return;
    }

    const span = state.compactionSpan;
    state.compactionSpan = undefined;

    if (span) {
      if (result.cost !== undefined) {
        span.setAttribute("opencode.cost.usd", result.cost);
      }
      if (result.error !== undefined) {
        span.setAttribute("error.message", result.error);
      }
      if (result.tokens) {
        attachTokenUsage(span, result.tokens);
      }
      setSpanStatus(span, result.error !== undefined);
      span.end();
    }

    if (this.config.enableMetrics && result.tokens) {
      this.recordTokenMetrics(
        result.tokens,
        this.metricAttributes(
          result.providerID ?? state.providerID,
          result.modelID ?? state.modelID,
        ),
      );
    }
  }

  private recordTokenMetrics(
    tokens: TokenUsage,
    attributes: Record<string, string>,
  ): void {
    const byType = {
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning,
      cached_input: tokens.cache.read,
    };

    for (const [type, value] of Object.entries(byType)) {
      if (value > 0) {
        Sentry.metrics.distribution("gen_ai.client.token.usage", value, {
          attributes: { ...attributes, "gen_ai.token.type": type },
          unit: "token",
        });
      }
    }
  }

  private diagnostics(
    message: string,
    createExtra: () => Record<string, unknown>,
  ): void {
    if (this.config.diagnostics) {
      this.logger.debug(message, createExtra());
    }
  }
}
