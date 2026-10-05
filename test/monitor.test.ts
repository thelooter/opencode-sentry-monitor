import * as Sentry from "@sentry/node";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginLogger, ResolvedPluginConfig } from "../src/config.js";
import { type OpenCodeEvent, SessionMonitor } from "../src/monitor.js";

interface FakeSpan {
  options: {
    op: string;
    name: string;
    parentSpan?: FakeSpan | null;
    forceTransaction?: boolean;
    startTime?: number;
  };
  attributes: Record<string, unknown>;
  status?: { code: number };
  ended: boolean;
  setAttribute(key: string, value: unknown): void;
  setStatus(status: { code: number }): void;
  end(): void;
}

const spans: FakeSpan[] = [];

vi.mock("@sentry/node", () => ({
  startInactiveSpan: vi.fn(
    (options: FakeSpan["options"] & { attributes?: object }) => {
      const span: FakeSpan = {
        options,
        attributes: { ...options.attributes },
        ended: false,
        setAttribute(key, value) {
          this.attributes[key] = value;
        },
        setStatus(status) {
          this.status = status;
        },
        end() {
          this.ended = true;
        },
      };
      spans.push(span);
      return span;
    },
  ),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
  flush: vi.fn(async () => true),
  metrics: {
    count: vi.fn(),
    distribution: vi.fn(),
  },
}));

const SESSION = "ses_1";
const MODEL = { providerID: "anthropic", id: "claude-sonnet" };
const TOKENS = {
  input: 100,
  output: 20,
  reasoning: 5,
  cache: { read: 40, write: 0 },
};
const OK = { code: 1 };
const ERROR = { code: 2 };

const logger: PluginLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function createMonitor(overrides: Partial<ResolvedPluginConfig> = {}) {
  return new SessionMonitor({
    config: {
      dsn: "https://public@o1.ingest.sentry.io/1",
      tracesSampleRate: 1,
      diagnostics: false,
      flushTimeoutMs: 5000,
      recordInputs: true,
      recordOutputs: true,
      maxAttributeLength: 12000,
      includeMessageUsageSpans: true,
      includeSessionEvents: true,
      enableMetrics: false,
      tags: {},
      ...overrides,
    },
    projectName: "my-project",
    agentName: "my-agent",
    logger,
  });
}

let created = 1_000;

// The monitor only reads `type`, `created`, and `data`, so the tests leave out
// the rest of the event envelope.
function event(type: OpenCodeEvent["type"], data: object = {}): OpenCodeEvent {
  created += 100;
  return {
    type,
    created,
    data: { sessionID: SESSION, ...data },
  } as unknown as OpenCodeEvent;
}

function spanByOp(op: string): FakeSpan {
  const span = spans.find((candidate) => candidate.options.op === op);
  if (!span) {
    throw new Error(`no ${op} span was started`);
  }
  return span;
}

const prompt = (text: string) =>
  event("session.inbox.enqueued", {
    inboxID: "msg_user",
    item: { type: "user", payload: { text }, delivery: "queue" },
  });

const stepStarted = (assistantMessageID = "msg_1") =>
  event("session.step.started", {
    assistantMessageID,
    agent: "build",
    model: MODEL,
    started: 500,
  });

const stepEnded = (assistantMessageID = "msg_1") =>
  event("session.step.ended", {
    assistantMessageID,
    finish: "stop",
    cost: 0.25,
    tokens: TOKENS,
  });

const toolCall = { tool: "shell", sessionID: SESSION, id: "call_1" };

beforeEach(() => {
  spans.length = 0;
  created = 1_000;
  vi.clearAllMocks();
});

describe("SessionMonitor", () => {
  it("records one execution as an invoke_agent transaction", () => {
    const monitor = createMonitor({ tags: { team: "platform" } });

    monitor.handleEvent(
      event("session.created", { model: MODEL, parentID: "ses_parent" }),
    );
    monitor.handleEvent(event("session.execution.started"));

    const span = spanByOp("gen_ai.invoke_agent");
    expect(span.options).toMatchObject({
      name: "invoke_agent my-agent",
      parentSpan: null,
      forceTransaction: true,
    });
    expect(span.attributes).toMatchObject({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "my-agent",
      "gen_ai.request.model": "claude-sonnet",
      "gen_ai.conversation.id": SESSION,
      "opencode.model.provider": "anthropic",
      "opencode.session.id": SESSION,
      "opencode.session.parent_id": "ses_parent",
      "opencode.project.name": "my-project",
      team: "platform",
    });
    expect(span.ended).toBe(false);

    monitor.handleEvent(event("session.execution.succeeded"));

    expect(span.ended).toBe(true);
    expect(span.status).toEqual(OK);
    expect(Sentry.flush).toHaveBeenCalledWith(5000);
  });

  it("records each model step as a request span with usage", () => {
    const monitor = createMonitor();

    monitor.handleEvent(prompt("  fix the bug  "));
    monitor.handleEvent(event("session.execution.started"));
    monitor.handleEvent(stepStarted());
    monitor.handleEvent(
      event("session.text.ended", {
        assistantMessageID: "msg_1",
        ordinal: 0,
        text: "All fixed.",
      }),
    );
    monitor.handleEvent(stepEnded());

    const execution = spanByOp("gen_ai.invoke_agent");
    const step = spanByOp("gen_ai.request");

    expect(step.options).toMatchObject({
      name: "request claude-sonnet",
      parentSpan: execution,
      startTime: 0.5,
    });
    expect(step.attributes).toMatchObject({
      "gen_ai.request.model": "claude-sonnet",
      "opencode.model.provider": "anthropic",
      "opencode.agent": "build",
      "opencode.message.id": "msg_1",
      "gen_ai.request.messages": '[{"role":"user","content":"fix the bug"}]',
      "gen_ai.response.text": '["All fixed."]',
      "gen_ai.response.finish_reasons": ["stop"],
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 20,
      "gen_ai.usage.output_tokens.reasoning": 5,
      "gen_ai.usage.input_tokens.cached": 40,
      "gen_ai.usage.input_tokens.cache_write": 0,
      "gen_ai.usage.total_tokens": 120,
      "opencode.cost.usd": 0.25,
    });
    expect(step.status).toEqual(OK);
    expect(step.ended).toBe(true);

    // The model is only known once the first step starts.
    expect(execution.attributes).toMatchObject({
      "gen_ai.request.model": "claude-sonnet",
      "opencode.agent": "build",
      "gen_ai.request.messages": '[{"role":"user","content":"fix the bug"}]',
    });

    monitor.handleEvent(event("session.execution.succeeded"));
    expect(execution.attributes["gen_ai.response.text"]).toBe('["All fixed."]');
  });

  it("leaves prompts and responses out when recording is disabled", () => {
    const monitor = createMonitor({
      recordInputs: false,
      recordOutputs: false,
    });

    monitor.handleEvent(prompt("secret prompt"));
    monitor.handleEvent(event("session.execution.started"));
    monitor.handleEvent(stepStarted());
    monitor.handleEvent(
      event("session.text.ended", {
        assistantMessageID: "msg_1",
        ordinal: 0,
        text: "secret answer",
      }),
    );
    monitor.handleEvent(stepEnded());
    monitor.toolStarted({ ...toolCall, input: { command: "secret" } });
    monitor.toolFinished({
      ...toolCall,
      input: { command: "secret" },
      status: "completed",
      result: { content: "secret output" },
    });
    monitor.handleEvent(event("session.execution.succeeded"));

    expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain(
      "secret",
    );
  });

  it("skips request spans when includeMessageUsageSpans is off", () => {
    const monitor = createMonitor({ includeMessageUsageSpans: false });

    monitor.handleEvent(event("session.execution.started"));
    monitor.handleEvent(stepStarted());
    monitor.handleEvent(stepEnded());

    expect(spans.map((span) => span.options.op)).toEqual([
      "gen_ai.invoke_agent",
    ]);
    expect(spans[0]?.attributes["gen_ai.request.model"]).toBe("claude-sonnet");
  });

  it("marks failed steps and executions as errors and reports them", () => {
    const monitor = createMonitor({ tags: { team: "platform" } });
    const error = { type: "provider.auth", message: "not permitted" };

    monitor.handleEvent(event("session.execution.started"));
    monitor.handleEvent(stepStarted());
    monitor.handleEvent(
      event("session.step.failed", { assistantMessageID: "msg_1", error }),
    );
    monitor.handleEvent(event("session.execution.failed", { error }));

    const step = spanByOp("gen_ai.request");
    expect(step.status).toEqual(ERROR);
    expect(step.attributes["error.message"]).toBe("not permitted");

    const execution = spanByOp("gen_ai.invoke_agent");
    expect(execution.status).toEqual(ERROR);
    expect(execution.ended).toBe(true);

    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      "OpenCode session.error",
      {
        level: "error",
        tags: { "opencode.session.id": SESSION, team: "platform" },
        extra: { payload: JSON.stringify(error) },
      },
    );
  });

  it("treats an interrupted execution as finished, not failed", () => {
    const monitor = createMonitor();

    monitor.handleEvent(event("session.execution.started"));
    monitor.handleEvent(stepStarted());
    monitor.handleEvent(
      event("session.execution.interrupted", { reason: "user" }),
    );

    const execution = spanByOp("gen_ai.invoke_agent");
    expect(execution.status).toEqual(OK);
    expect(execution.attributes["opencode.execution.interrupted"]).toBe("user");
    expect(Sentry.captureMessage).not.toHaveBeenCalled();

    // The step never saw its end event; it must not stay open.
    const step = spanByOp("gen_ai.request");
    expect(step.ended).toBe(true);
    expect(step.status).toEqual(ERROR);
  });

  it("records tool calls as child spans", () => {
    const monitor = createMonitor();

    monitor.handleEvent(event("session.execution.started"));
    monitor.handleEvent(stepStarted());
    monitor.toolStarted({
      ...toolCall,
      input: { command: "ls", apiKey: "sk-1" },
    });

    const tool = spanByOp("gen_ai.execute_tool");
    expect(tool.options).toMatchObject({
      name: "execute_tool shell",
      parentSpan: spanByOp("gen_ai.invoke_agent"),
    });
    expect(tool.attributes).toMatchObject({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "shell",
      "gen_ai.request.model": "claude-sonnet",
      "opencode.call.id": "call_1",
      "gen_ai.tool.input": '{"command":"ls","apiKey":"[REDACTED]"}',
    });

    monitor.toolFinished({
      ...toolCall,
      input: {},
      status: "completed",
      result: { content: "file.txt" },
    });

    expect(tool.attributes["gen_ai.tool.output"]).toBe(
      '{"content":"file.txt"}',
    );
    expect(tool.status).toEqual(OK);
    expect(tool.ended).toBe(true);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it("reports failed tool calls", () => {
    const monitor = createMonitor({ recordOutputs: false });

    monitor.toolStarted({ ...toolCall, input: {} });
    monitor.toolFinished({
      ...toolCall,
      input: {},
      status: "error",
      error: { message: "command not found" },
    });

    const tool = spanByOp("gen_ai.execute_tool");
    // A tool call outside an execution becomes its own root span.
    expect(tool.options.parentSpan).toBeNull();
    expect(tool.status).toEqual(ERROR);
    expect(tool.attributes["error.message"]).toBe("command not found");
    expect(tool.attributes["gen_ai.tool.output"]).toBeUndefined();
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      "Tool execution error: shell",
      expect.objectContaining({
        level: "error",
        tags: {
          "opencode.session.id": SESSION,
          "opencode.call.id": "call_1",
          "opencode.tool": "shell",
        },
        extra: { output: '{"message":"command not found"}' },
      }),
    );
  });

  it("records compaction as a request span", () => {
    const monitor = createMonitor();

    monitor.handleEvent(event("session.execution.started"));
    monitor.handleEvent(
      event("session.compaction.started", { reason: "auto", recent: "" }),
    );
    monitor.handleEvent(
      event("session.compaction.ended", {
        reason: "auto",
        model: MODEL,
        cost: 0.1,
        tokens: TOKENS,
      }),
    );

    const compaction = spanByOp("gen_ai.request");
    expect(compaction.attributes).toMatchObject({
      "opencode.request.kind": "compaction",
      "opencode.compaction.reason": "auto",
      "gen_ai.request.model": "claude-sonnet",
      "gen_ai.usage.input_tokens": 100,
      "opencode.cost.usd": 0.1,
    });
    expect(compaction.status).toEqual(OK);
    expect(compaction.ended).toBe(true);
  });

  it("emits metrics when enabled", () => {
    const monitor = createMonitor({
      enableMetrics: true,
      tags: { team: "platform" },
    });
    const attributes = {
      "gen_ai.agent.name": "my-agent",
      "opencode.project.name": "my-project",
      "gen_ai.request.model": "claude-sonnet",
      "opencode.model.provider": "anthropic",
      team: "platform",
    };

    monitor.handleEvent(event("session.execution.started"));
    monitor.handleEvent(stepStarted());
    monitor.handleEvent(stepEnded());
    const endedAt = created;
    monitor.toolStarted({ ...toolCall, input: {} });
    monitor.toolFinished({
      ...toolCall,
      input: {},
      status: "completed",
      result: {},
    });

    const distribution = vi.mocked(Sentry.metrics.distribution);
    const usage = distribution.mock.calls.filter(
      ([name]) => name === "gen_ai.client.token.usage",
    );
    // cache.write is 0 and zero-valued token types are not emitted.
    expect(usage).toEqual([
      [
        "gen_ai.client.token.usage",
        100,
        {
          attributes: { ...attributes, "gen_ai.token.type": "input" },
          unit: "token",
        },
      ],
      [
        "gen_ai.client.token.usage",
        20,
        {
          attributes: { ...attributes, "gen_ai.token.type": "output" },
          unit: "token",
        },
      ],
      [
        "gen_ai.client.token.usage",
        5,
        {
          attributes: { ...attributes, "gen_ai.token.type": "reasoning" },
          unit: "token",
        },
      ],
      [
        "gen_ai.client.token.usage",
        40,
        {
          attributes: { ...attributes, "gen_ai.token.type": "cached_input" },
          unit: "token",
        },
      ],
    ]);
    expect(distribution).toHaveBeenCalledWith(
      "gen_ai.client.response.duration",
      endedAt - 500,
      { attributes, unit: "millisecond" },
    );
    expect(Sentry.metrics.count).toHaveBeenCalledWith(
      "gen_ai.client.tool.execution",
      1,
      {
        attributes: {
          "gen_ai.agent.name": "my-agent",
          "gen_ai.tool.name": "shell",
          "opencode.project.name": "my-project",
          status: "ok",
          team: "platform",
        },
      },
    );
  });

  it("emits no metrics by default", () => {
    const monitor = createMonitor();

    monitor.handleEvent(event("session.execution.started"));
    monitor.handleEvent(stepStarted());
    monitor.handleEvent(stepEnded());

    expect(Sentry.metrics.distribution).not.toHaveBeenCalled();
    expect(Sentry.metrics.count).not.toHaveBeenCalled();
  });

  it("starts a fresh transaction for every execution of a session", () => {
    const monitor = createMonitor();

    monitor.handleEvent(event("session.execution.started"));
    monitor.handleEvent(event("session.execution.succeeded"));
    monitor.handleEvent(event("session.execution.started"));
    monitor.handleEvent(event("session.execution.succeeded"));

    expect(spans.map((span) => span.options.op)).toEqual([
      "gen_ai.invoke_agent",
      "gen_ai.invoke_agent",
    ]);
    expect(spans.every((span) => span.ended)).toBe(true);
  });

  it("ends every open span when disposed or when the session is deleted", () => {
    const monitor = createMonitor();

    monitor.handleEvent(event("session.execution.started"));
    monitor.handleEvent(stepStarted());
    monitor.toolStarted({ ...toolCall, input: {} });
    monitor.handleEvent(event("session.deleted"));
    expect(spans).toHaveLength(3);
    expect(spans.every((span) => span.ended)).toBe(true);

    monitor.handleEvent(event("session.execution.started", { sessionID: "b" }));
    monitor.dispose();
    expect(spans.every((span) => span.ended)).toBe(true);
  });

  it("never throws out of an event handler or tool hook", () => {
    const monitor = createMonitor();
    vi.mocked(Sentry.startInactiveSpan).mockImplementation(() => {
      throw new Error("sentry is down");
    });

    expect(() =>
      monitor.handleEvent(event("session.execution.started")),
    ).not.toThrow();
    expect(() => monitor.toolStarted({ ...toolCall, input: {} })).not.toThrow();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});
