import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginConfig, type PluginLogger } from "../src/config.js";

const DSN = "https://public@o1.ingest.sentry.io/1";

const ENV_KEYS = [
  "OPENCODE_SENTRY_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_CONFIG",
  "OPENCODE_SENTRY_DSN",
  "SENTRY_DSN",
  "OPENCODE_SENTRY_TRACES_SAMPLE_RATE",
  "OPENCODE_SENTRY_RECORD_INPUTS",
  "OPENCODE_SENTRY_RECORD_OUTPUTS",
  "OPENCODE_SENTRY_INCLUDE_SESSION_EVENTS",
  "OPENCODE_SENTRY_INCLUDE_MESSAGE_USAGE_SPANS",
  "OPENCODE_SENTRY_MAX_ATTRIBUTE_LENGTH",
  "OPENCODE_SENTRY_ENABLE_METRICS",
  "OPENCODE_SENTRY_TAGS",
  "OPENCODE_SENTRY_DIAGNOSTICS",
  "OPENCODE_SENTRY_FLUSH_TIMEOUT_MS",
  "OPENCODE_SENTRY_DEBUG",
  "SENTRY_ENVIRONMENT",
  "SENTRY_RELEASE",
];

let root: string;
let project: string;
let home: string;
let logger: PluginLogger;

function load() {
  return loadPluginConfig({ directory: project } as PluginInput, logger);
}

async function writeProjectConfig(
  content: unknown,
  fileName = "sentry-monitor.json",
): Promise<string> {
  const dir = join(project, ".opencode");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, fileName);
  await writeFile(
    filePath,
    typeof content === "string" ? content : JSON.stringify(content),
  );
  return filePath;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sentry-monitor-test-"));
  project = join(root, "project");
  home = join(root, "home");
  await mkdir(project, { recursive: true });
  await mkdir(home, { recursive: true });

  // Keep the developer's real OpenCode config and environment out of the tests.
  for (const key of ENV_KEYS) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);

  logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("loadPluginConfig", () => {
  it("stays disabled when no DSN is configured", async () => {
    expect(await load()).toBeNull();
    expect(logger.info).toHaveBeenCalledOnce();
  });

  it("loads a project config file and applies defaults", async () => {
    const filePath = await writeProjectConfig({ dsn: DSN });

    expect(await load()).toEqual({
      source: filePath,
      config: {
        dsn: DSN,
        tracesSampleRate: 1,
        environment: undefined,
        release: undefined,
        debug: undefined,
        diagnostics: false,
        flushTimeoutMs: 5000,
        agentName: undefined,
        projectName: undefined,
        recordInputs: true,
        recordOutputs: true,
        maxAttributeLength: 12000,
        includeMessageUsageSpans: true,
        includeSessionEvents: true,
        enableMetrics: false,
        tags: {},
      },
    });
  });

  it("parses JSONC config files", async () => {
    await writeProjectConfig(
      `{
        // comments are allowed
        "dsn": "${DSN}",
        "recordInputs": false /* inline too */
      }`,
      "sentry-monitor.jsonc",
    );

    const loaded = await load();
    expect(loaded?.config.recordInputs).toBe(false);
  });

  it("prefers the project config over the global config", async () => {
    const globalDir = join(home, ".config", "opencode");
    await mkdir(globalDir, { recursive: true });
    await writeFile(
      join(globalDir, "sentry-monitor.json"),
      JSON.stringify({ dsn: DSN, agentName: "global" }),
    );

    expect((await load())?.config.agentName).toBe("global");

    await writeProjectConfig({ dsn: DSN, agentName: "project" });
    expect((await load())?.config.agentName).toBe("project");
  });

  it("prefers an explicit OPENCODE_SENTRY_CONFIG path", async () => {
    await writeProjectConfig({ dsn: DSN, agentName: "project" });
    const explicit = join(root, "explicit.json");
    await writeFile(explicit, JSON.stringify({ dsn: DSN, agentName: "env" }));
    vi.stubEnv("OPENCODE_SENTRY_CONFIG", explicit);

    const loaded = await load();
    expect(loaded?.source).toBe(explicit);
    expect(loaded?.config.agentName).toBe("env");
  });

  it("works from environment variables alone", async () => {
    vi.stubEnv("SENTRY_DSN", DSN);

    const loaded = await load();
    expect(loaded?.source).toBe("environment");
    expect(loaded?.config.dsn).toBe(DSN);
  });

  it("lets environment variables override file values", async () => {
    await writeProjectConfig({
      dsn: "https://file@o1.ingest.sentry.io/2",
      tracesSampleRate: 1,
      recordInputs: true,
      tags: { team: "platform", source: "file" },
    });
    vi.stubEnv("OPENCODE_SENTRY_DSN", DSN);
    vi.stubEnv("OPENCODE_SENTRY_TRACES_SAMPLE_RATE", "0.25");
    vi.stubEnv("OPENCODE_SENTRY_RECORD_INPUTS", "off");
    vi.stubEnv("OPENCODE_SENTRY_ENABLE_METRICS", "yes");
    vi.stubEnv("OPENCODE_SENTRY_FLUSH_TIMEOUT_MS", "2000");
    vi.stubEnv("OPENCODE_SENTRY_TAGS", "source:env, developer:eve ,broken");
    vi.stubEnv("SENTRY_ENVIRONMENT", "staging");

    expect((await load())?.config).toMatchObject({
      dsn: DSN,
      tracesSampleRate: 0.25,
      recordInputs: false,
      enableMetrics: true,
      flushTimeoutMs: 2000,
      environment: "staging",
      tags: { team: "platform", source: "env", developer: "eve" },
    });
  });

  it("ignores environment values it cannot parse", async () => {
    await writeProjectConfig({ dsn: DSN, tracesSampleRate: 0.5 });
    vi.stubEnv("OPENCODE_SENTRY_TRACES_SAMPLE_RATE", "lots");
    vi.stubEnv("OPENCODE_SENTRY_RECORD_OUTPUTS", "maybe");

    expect((await load())?.config).toMatchObject({
      tracesSampleRate: 0.5,
      recordOutputs: true,
    });
  });

  it.each([
    [{ dsn: "not a url" }, '"dsn" must be a valid URL'],
    [{ dsn: "ftp://example.com/1" }, '"dsn" must use "https" or "http"'],
    [{ dsn: DSN, tracesSampleRate: 2 }, '"tracesSampleRate" must be between'],
    [{ dsn: DSN, maxAttributeLength: 10 }, '"maxAttributeLength" must be'],
    [{ dsn: DSN, flushTimeoutMs: 10 }, '"flushTimeoutMs" must be'],
    [{ dsn: DSN, recordInputs: "yes" }, '"recordInputs" must be a boolean'],
    [{ dsn: DSN, tags: { team: 1 } }, '"tags.team" must be a string'],
    [{ dsn: DSN, tags: ["a"] }, '"tags" must be an object'],
  ])("rejects invalid config %j", async (config, message) => {
    await writeProjectConfig(config);

    await expect(load()).rejects.toThrow(message);
  });

  it("reports the file name for malformed config files", async () => {
    const filePath = await writeProjectConfig("{ not json");

    await expect(load()).rejects.toThrow(`Invalid config in ${filePath}`);
  });
});
