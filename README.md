# opencode-sentry-monitor

Sentry AI Monitoring plugin for OpenCode.

This plugin captures OpenCode agent runs, model requests, tool executions, and token usage into Sentry using AI Monitoring span conventions.

> **Requires OpenCode v2.** Versions 0.2.0 and later use the v2 plugin API and do not load in OpenCode v1. For OpenCode v1, use [0.1.7](https://github.com/thelooter/opencode-sentry-monitor/releases/tag/v0.1.7). See [Upgrading from 0.1.x](#upgrading-from-01x).

## Sentry Project Setup

Before using this plugin, create (or reuse) a Sentry project configured for Node SDK ingestion.

- **Project type**: `JavaScript` -> `Node.js`
- **Why this type**: this plugin uses `@sentry/node`
- **Required**: tracing enabled (`tracesSampleRate` > `0`) so AI Monitoring spans are stored
- **DSN source**: Project Settings -> Client Keys (DSN)

You can use an existing Node project if you already have one.

## Features

- One `gen_ai.invoke_agent` transaction per agent run (from prompt to idle)
- A `gen_ai.request` span per model request, with real timing, token usage, cost, and finish reason
- A `gen_ai.execute_tool` span per tool call (inputs/outputs optional)
- Prompt and response text on request and agent spans (`gen_ai.request.messages`, `gen_ai.response.text`)
- Compaction requests recorded as `gen_ai.request` spans tagged `opencode.request.kind: compaction`
- Error reports for failed runs and failed tool calls
- Custom tags on all spans and error reports
- Unsampled metrics for token usage, response timing, and tool executions
- Config from a sidecar file, OpenCode plugin options, or environment variables
- JSON and JSONC config support
- Redaction and truncation for large/sensitive payload attributes

## Install

1. Add the plugin to your OpenCode config (`~/.config/opencode/opencode.json` or a project `opencode.json`), pinned to a release tag:

```json
{
  "plugins": ["github:thelooter/opencode-sentry-monitor#v0.2.0"]
}
```

   Or let OpenCode do it: `opencode plugin add github:thelooter/opencode-sentry-monitor#v0.2.0`.

   OpenCode v2 installs plugins from the npm registry or from git. This fork is not on npm, so it installs from git; every release tag contains the compiled plugin.

2. Give it your DSN, either as plugin options:

```json
{
  "plugins": [
    {
      "package": "github:thelooter/opencode-sentry-monitor#v0.2.0",
      "options": {
        "dsn": "https://<public-key>@o<org>.ingest.sentry.io/<project-id>"
      }
    }
  ]
}
```

   or in a separate config file:

```json
{
  "dsn": "https://<public-key>@o<org>.ingest.sentry.io/<project-id>",
  "tracesSampleRate": 1,
  "recordInputs": true,
  "recordOutputs": true
}
```

   saved as one of:

- `.opencode/sentry-monitor.json`
- `.opencode/sentry-monitor.jsonc`
- `~/.config/opencode/sentry-monitor.json`
- `~/.config/opencode/sentry-monitor.jsonc`

3. Run `opencode reload`, then check `opencode plugin list` for `sentry-monitor`.

Without a DSN the plugin loads but stays disabled.

## Config Resolution Order

The plugin looks for config in this order:

1. `OPENCODE_SENTRY_CONFIG` (explicit file path)
2. `.opencode/` in the directory OpenCode was opened in, then in the project root
3. `OPENCODE_CONFIG_DIR`
4. Directory of `OPENCODE_CONFIG`
5. Platform defaults:
   - `~/.config/opencode`
   - `~/Library/Application Support/opencode`
   - `~/AppData/Roaming/opencode`

The first file found is used. Values are then layered on top of it, later sources winning:

1. The config file
2. `options` from the OpenCode `plugins` entry
3. Environment variables

No config file is required; options or environment variables alone are enough:

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
  includeMessageUsageSpans?: boolean; // default true (gen_ai.request spans)
  includeSessionEvents?: boolean; // default true (breadcrumb per finished run)
  enableMetrics?: boolean; // default false
  tags?: Record<string, string>; // custom tags on all spans/metrics
};
```

## Metrics

When `enableMetrics: true`, the plugin emits Sentry metrics (unsampled, 100% accurate) for usage attribution:

| Metric | Type | Unit | Emitted |
|--------|------|------|---------|
| `gen_ai.client.token.usage` | distribution | token | Per model request (including compaction), tagged by token type (input/output/reasoning/cached_input) |
| `gen_ai.client.response.duration` | distribution | millisecond | Per model request, from dispatch to the end of the response |
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

To cut a release, run the **Release** workflow from the Actions tab and pick a version bump. It bumps `package.json`, runs the checks, and publishes:

- a `v<version>` tag, which is what OpenCode installs. The tag points at a build commit that adds the compiled `dist/` on top of the release commit, because OpenCode does not run build scripts when it installs from git.
- a [GitHub release](https://github.com/thelooter/opencode-sentry-monitor/releases) with generated notes, the packed `opencode-sentry-monitor-<version>.tgz`, and a `SHA256SUMS` file.

Build output and tarballs are never committed to `main`.

The `pre*` bumps produce versions like `1.2.0-rc.0`, published as GitHub pre-releases. They are the only bumps allowed from a branch other than `main`.

## Upgrading from 0.1.x

0.2.0 moves to the OpenCode v2 plugin API. Your config file and environment variables keep working unchanged. What is different:

- **Install spec.** `"plugin": ["opencode-sentry-monitor"]` resolves to the upstream 0.1.x package on npm, which OpenCode v2 cannot load. Replace it with the git spec from [Install](#install).
- **Transactions.** 0.1.x kept one `gen_ai.invoke_agent` span open from session creation until the session went idle. 0.2.0 opens one per agent run, so a session with five prompts is five transactions sharing a `gen_ai.conversation.id`.
- **Request spans.** `gen_ai.request` spans now cover the real duration of each model request. In 0.1.x they were zero-length markers created after the fact.
- **Tool errors.** A tool call counts as failed when OpenCode reports it failed. 0.1.x guessed from the tool's title and metadata.
- **New attributes.** `opencode.agent`, `opencode.session.parent_id` (subagent sessions), `opencode.cost.usd`, `gen_ai.response.finish_reasons`, and `error.message`.

## Notes

- DSN is not a secret, but this plugin does not require hardcoding it.
- If `recordInputs`/`recordOutputs` are enabled, payloads are redacted and truncated before being attached as span attributes.
- Spans are flushed when an agent run finishes, when a session is deleted, and when the plugin is unloaded.

## License

MIT
