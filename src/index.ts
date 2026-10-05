import { basename } from "node:path";
import type { Plugin } from "@opencode/plugin";
import * as Sentry from "@sentry/node";
import {
  loadPluginConfig,
  type PluginLogger,
  type ResolvedPluginConfig,
} from "./config.js";
import { type OpenCodeEvent, SessionMonitor } from "./monitor.js";

export type { PluginConfig } from "./config.js";

const SERVICE = "opencode-sentry-monitor";

// Sentry keeps one client per process, while OpenCode sets the plugin up once
// per open location.
let initializedDsn: string | null = null;

function createLogger(): PluginLogger {
  const write =
    (level: "debug" | "info" | "warn" | "error") =>
    (message: string, extra?: Record<string, unknown>): void => {
      console[level](`[${SERVICE}] ${message}`, extra ?? "");
    };

  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
  };
}

function initSentry(config: ResolvedPluginConfig, logger: PluginLogger): void {
  if (initializedDsn === null) {
    Sentry.init({
      dsn: config.dsn,
      tracesSampleRate: config.tracesSampleRate,
      environment: config.environment,
      release: config.release,
      debug: config.debug,
      sendDefaultPii: false,
    });

    initializedDsn = config.dsn;
    return;
  }

  if (initializedDsn !== config.dsn) {
    logger.warn(
      "Sentry is already initialized with a different DSN. Keeping the original client.",
      {
        initializedDsn,
        requestedDsn: config.dsn,
      },
    );
  }
}

function getProjectName(
  config: ResolvedPluginConfig,
  location: Plugin.Context["location"],
): string {
  if (config.projectName && config.projectName.length > 0) {
    return config.projectName;
  }

  const fromProject = basename(location.project.directory);
  if (fromProject.length > 0) {
    return fromProject;
  }

  const fromDirectory = basename(location.directory);
  return fromDirectory.length > 0 ? fromDirectory : "opencode-project";
}

async function consumeEvents(
  events: AsyncIterable<OpenCodeEvent>,
  monitor: SessionMonitor,
  logger: PluginLogger,
  signal: AbortSignal,
): Promise<void> {
  try {
    for await (const event of events) {
      monitor.handleEvent(event);
    }
  } catch (error) {
    if (!signal.aborted) {
      logger.warn("OpenCode event stream failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

const plugin: Plugin.Plugin = {
  id: "sentry-monitor",
  setup: async (ctx) => {
    const logger = createLogger();
    const loaded = await loadPluginConfig(
      {
        directory: ctx.location.directory,
        projectDirectory: ctx.location.project.directory,
        options: ctx.options,
      },
      logger,
    );

    if (!loaded) {
      return;
    }

    const config = loaded.config;
    const projectName = getProjectName(config, ctx.location);
    const agentName =
      config.agentName && config.agentName.length > 0
        ? config.agentName
        : projectName;

    initSentry(config, logger);

    const monitor = new SessionMonitor({
      config,
      projectName,
      agentName,
      logger,
    });

    const registrations = [
      await ctx.tool.hook("execute.before", (call) => {
        monitor.toolStarted(call);
      }),
      await ctx.tool.hook("execute.after", (call) => {
        monitor.toolFinished(call);
      }),
    ];

    const abort = new AbortController();
    const events = consumeEvents(
      ctx.event.subscribe({ signal: abort.signal }),
      monitor,
      logger,
      abort.signal,
    );

    logger.info("Sentry observability plugin enabled", {
      source: loaded.source,
      opencode: ctx.app.version,
      projectName,
      agentName,
      tracesSampleRate: config.tracesSampleRate,
      recordInputs: config.recordInputs,
      recordOutputs: config.recordOutputs,
      diagnostics: config.diagnostics,
      flushTimeoutMs: config.flushTimeoutMs,
    });

    return async () => {
      abort.abort();
      await events;
      await Promise.all(
        registrations.map((registration) => registration.dispose()),
      );
      monitor.dispose();
      await monitor.flush("plugin.unload");
    };
  },
};

export default plugin;
