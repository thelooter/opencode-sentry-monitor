# opencode-sentry-monitor

Sentry AI Monitoring plugin for OpenCode.

This plugin captures OpenCode session lifecycle, tool execution spans, and assistant token usage into Sentry using AI Monitoring span conventions.

## Sentry Project Setup

Before using this plugin, create (or reuse) a Sentry project configured for Node SDK ingestion.

- **Project type**: `JavaScript` -> `Node.js`
- **Why this type**: OpenCode plugins run in a Node runtime, and this plugin uses `@sentry/node`
- **Required**: tracing enabled (`tracesSampleRate` > `0`) so AI Monitoring spans are stored
- **DSN source**: Project Settings -> Client Keys (DSN)

You can use an existing Node project if you already have one.

## Features

- Session-level `gen_ai.invoke_agent` spans
- Tool-level `gen_ai.execute_tool` spans (inputs/outputs optional)
- Assistant token usage spans via `message.updated` events
- Model request/response attributes on `gen_ai.request` and `gen_ai.invoke_agent` spans (`gen_ai.request.messages`, `gen_ai.response.text`)
- Custom tags on all spans and error reports
- Unsampled metrics for token usage, response timing, and tool executions
- Sidecar config file support (no hardcoded DSN required)
- JSON and JSONC config support
- Redaction and truncation for large/sensitive payload attributes

## Install

1. Add plugin package to OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-sentry-monitor"]
}
```

2. Create a plugin config file with your DSN:

```json
{
  "dsn": "https://<public-key>@o<org>.ingest.sentry.io/<project-id>",
  "tracesSampleRate": 1,
  "recordInputs": true,
  "recordOutputs": true
}
```

3. Save that file as one of:

- `.opencode/sentry-monitor.json`
- `.opencode/sentry-monitor.jsonc`
- `~/.config/opencode/sentry-monitor.json`
- `~/.config/opencode/sentry-monitor.jsonc`

Restart OpenCode after installation.

## Config Resolution Order

The plugin looks for config in this order:

1. `OPENCODE_SENTRY_CONFIG` (explicit file path)
2. Project `.opencode/`
3. `OPENCODE_CONFIG_DIR`
4. Directory of `OPENCODE_CONFIG`
5. Platform defaults:
   - `~/.config/opencode`
   - `~/Library/Application Support/opencode`
   - `~/AppData/Roaming/opencode`

If no config file exists, environment overrides are still supported:

- `OPENCODE_SENTRY_DSN` (or `SENTRY_DSN`)
- `OPENCODE_SENTRY_TRACES_SAMPLE_RATE`
- `OPENCODE_SENTRY_RECORD_INPUTS`
- `OPENCODE_SENTRY_RECORD_OUTPUTS`
- `OPENCODE_SENTRY_MAX_ATTRIBUTE_LENGTH`
- `OPENCODE_SENTRY_DIAGNOSTICS`
- `OPENCODE_SENTRY_FLUSH_TIMEOUT_MS`
- `OPENCODE_SENTRY_DEBUG`
- `OPENCODE_SENTRY_ENABLE_METRICS`
- `OPENCODE_SENTRY_TAGS` (format: `key:value,key:value`)
- `SENTRY_ENVIRONMENT`
- `SENTRY_RELEASE`

## Config Reference

```ts
type PluginConfig = {
  dsn: string;
  tracesSampleRate?: number; // 0..1, default 1
  environment?: string;
  release?: string;
  debug?: boolean;
  diagnostics?: boolean; // default false
  flushTimeoutMs?: number; // default 5000, 1000..60000
  agentName?: string;
  projectName?: string;
  recordInputs?: boolean; // default true (tool input + model request messages)
  recordOutputs?: boolean; // default true (tool output + model response text)
  maxAttributeLength?: number; // default 12000
  includeMessageUsageSpans?: boolean; // default true
  includeSessionEvents?: boolean; // default true
  enableMetrics?: boolean; // default false
  tags?: Record<string, string>; // custom tags on all spans/metrics
};
```

## Metrics

When `enableMetrics: true`, the plugin emits Sentry metrics (unsampled, 100% accurate) for usage attribution:

| Metric | Type | Unit | Emitted |
|--------|------|------|---------|
| `gen_ai.client.token.usage` | distribution | token | Per assistant message, tagged by token type (input/output/reasoning/cached_input) |
| `gen_ai.client.response.duration` | distribution | millisecond | Per assistant message response time |
| `gen_ai.client.tool.execution` | counter | — | Per tool execution, tagged with status (ok/error) |

All metrics include `gen_ai.agent.name`, `opencode.project.name`, `gen_ai.request.model`, `opencode.model.provider`, plus any custom `tags`.

Example config for team attribution:

```json
{
  "dsn": "https://...",
  "enableMetrics": true,
  "agentName": "my-agent",
  "tags": {
    "team": "platform",
    "developer": "sergiy"
  }
}
```

## Development

```bash
npm install
npm run check   # lint, typecheck, and tests
npm run build
```

| Script | What it does |
|--------|--------------|
| `npm run lint` | Lint and format check with [Biome](https://biomejs.dev) |
| `npm run format` | Apply formatting and safe lint fixes |
| `npm run typecheck` | Type-check sources and tests |
| `npm test` | Run the [Vitest](https://vitest.dev) suite |
| `npm run build` | Compile `src/` to `dist/` |

CI runs the same checks on every pull request and push to `main`, and uploads the packed tarball as a workflow artifact.

## Releasing

Releases live on the [GitHub releases page](https://github.com/thelooter/opencode-sentry-monitor/releases). Each one has the packed `opencode-sentry-monitor-<version>.tgz` and a `SHA256SUMS` file attached. Tarballs are never committed to the repository.

To cut a release, run the **Release** workflow from the Actions tab and pick a version bump. It bumps `package.json`, runs the checks, pushes the version commit and tag, and publishes the release with generated notes.

Pushing a tag does the same thing if you would rather bump locally:

```bash
npm version minor
git push --follow-tags
```

Versions with a pre-release suffix (`1.2.0-rc.0`) are published as GitHub pre-releases.

## Notes

- DSN is not a secret, but this plugin does not require hardcoding it.
- If `recordInputs`/`recordOutputs` are enabled, payloads are redacted and truncated before being attached as span attributes.
- AI spans are flushed on `session.idle` and `session.deleted`.

## License

MIT
