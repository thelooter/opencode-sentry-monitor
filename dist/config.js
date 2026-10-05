import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import stripJsonComments from "strip-json-comments";
const CONFIG_FILE_NAMES = [
    "sentry-monitor.json",
    "sentry-monitor.jsonc",
    "opencode-sentry-monitor.json",
    "opencode-sentry-monitor.jsonc",
    "sentry-observability.json",
    "sentry-observability.jsonc",
    "opencode-sentry-observability.json",
    "opencode-sentry-observability.jsonc",
];
const DEFAULTS = {
    tracesSampleRate: 1,
    recordInputs: true,
    recordOutputs: true,
    maxAttributeLength: 12000,
    includeMessageUsageSpans: true,
    includeSessionEvents: true,
    diagnostics: false,
    flushTimeoutMs: 5000,
    enableMetrics: false,
    tags: {},
};
function asString(value, fieldName) {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`"${fieldName}" must be a non-empty string`);
    }
    return value.trim();
}
function asOptionalString(value, fieldName) {
    if (value === undefined) {
        return undefined;
    }
    return asString(value, fieldName);
}
function asOptionalBoolean(value, fieldName) {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "boolean") {
        throw new Error(`"${fieldName}" must be a boolean`);
    }
    return value;
}
function asOptionalNumber(value, fieldName) {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`"${fieldName}" must be a finite number`);
    }
    return value;
}
function asOptionalTags(value, fieldName) {
    if (value === undefined) {
        return undefined;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`"${fieldName}" must be an object`);
    }
    for (const [k, v] of Object.entries(value)) {
        if (typeof v !== "string") {
            throw new Error(`"${fieldName}.${k}" must be a string`);
        }
    }
    return value;
}
function parseBooleanEnv(name) {
    const value = process.env[name];
    if (value === undefined) {
        return undefined;
    }
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
        return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
        return false;
    }
    return undefined;
}
function parseNumberEnv(name) {
    const value = process.env[name];
    if (value === undefined) {
        return undefined;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return undefined;
    }
    return parsed;
}
function parseConfigContent(raw, source) {
    try {
        const parsed = JSON.parse(stripJsonComments(raw));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("Config root must be an object");
        }
        return parsed;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid config in ${source}: ${message}`);
    }
}
function normalizeConfig(raw) {
    const dsn = asString(raw.dsn, "dsn");
    let dsnUrl;
    try {
        dsnUrl = new URL(dsn);
    }
    catch {
        throw new Error('"dsn" must be a valid URL');
    }
    if (!/^https?:$/.test(dsnUrl.protocol)) {
        throw new Error('"dsn" must use "https" or "http" protocol');
    }
    const tracesSampleRate = asOptionalNumber(raw.tracesSampleRate, "tracesSampleRate") ??
        DEFAULTS.tracesSampleRate;
    if (tracesSampleRate < 0 || tracesSampleRate > 1) {
        throw new Error('"tracesSampleRate" must be between 0 and 1');
    }
    const maxAttributeLength = asOptionalNumber(raw.maxAttributeLength, "maxAttributeLength") ??
        DEFAULTS.maxAttributeLength;
    if (!Number.isInteger(maxAttributeLength) || maxAttributeLength < 128) {
        throw new Error('"maxAttributeLength" must be an integer >= 128');
    }
    const flushTimeoutMs = asOptionalNumber(raw.flushTimeoutMs, "flushTimeoutMs") ??
        DEFAULTS.flushTimeoutMs;
    if (!Number.isInteger(flushTimeoutMs) ||
        flushTimeoutMs < 1000 ||
        flushTimeoutMs > 60000) {
        throw new Error('"flushTimeoutMs" must be an integer between 1000 and 60000');
    }
    return {
        dsn,
        tracesSampleRate,
        environment: asOptionalString(raw.environment, "environment"),
        release: asOptionalString(raw.release, "release"),
        debug: asOptionalBoolean(raw.debug, "debug"),
        diagnostics: asOptionalBoolean(raw.diagnostics, "diagnostics") ?? DEFAULTS.diagnostics,
        flushTimeoutMs,
        agentName: asOptionalString(raw.agentName, "agentName"),
        projectName: asOptionalString(raw.projectName, "projectName"),
        recordInputs: asOptionalBoolean(raw.recordInputs, "recordInputs") ??
            DEFAULTS.recordInputs,
        recordOutputs: asOptionalBoolean(raw.recordOutputs, "recordOutputs") ??
            DEFAULTS.recordOutputs,
        maxAttributeLength,
        includeMessageUsageSpans: asOptionalBoolean(raw.includeMessageUsageSpans, "includeMessageUsageSpans") ?? DEFAULTS.includeMessageUsageSpans,
        includeSessionEvents: asOptionalBoolean(raw.includeSessionEvents, "includeSessionEvents") ??
            DEFAULTS.includeSessionEvents,
        enableMetrics: asOptionalBoolean(raw.enableMetrics, "enableMetrics") ??
            DEFAULTS.enableMetrics,
        tags: asOptionalTags(raw.tags, "tags") ?? DEFAULTS.tags,
    };
}
async function fileExists(filePath) {
    try {
        await access(filePath, fsConstants.F_OK);
        return true;
    }
    catch {
        return false;
    }
}
function addUnique(list, value) {
    if (!value) {
        return;
    }
    if (!list.includes(value)) {
        list.push(value);
    }
}
function resolveMaybeRelative(filePath, cwd) {
    return isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
}
function getCandidatePaths(input) {
    const candidates = [];
    const explicitPath = process.env.OPENCODE_SENTRY_CONFIG;
    if (explicitPath) {
        addUnique(candidates, resolveMaybeRelative(explicitPath, input.directory));
    }
    const configDirs = [];
    addUnique(configDirs, join(input.directory, ".opencode"));
    if (input.projectDirectory) {
        addUnique(configDirs, join(input.projectDirectory, ".opencode"));
    }
    if (process.env.OPENCODE_CONFIG_DIR) {
        addUnique(configDirs, resolve(process.env.OPENCODE_CONFIG_DIR));
    }
    if (process.env.OPENCODE_CONFIG) {
        addUnique(configDirs, dirname(resolve(process.env.OPENCODE_CONFIG)));
    }
    const home = homedir();
    if (home) {
        addUnique(configDirs, join(home, ".config", "opencode"));
        addUnique(configDirs, join(home, "Library", "Application Support", "opencode"));
        addUnique(configDirs, join(home, "AppData", "Roaming", "opencode"));
    }
    for (const configDir of configDirs) {
        for (const fileName of CONFIG_FILE_NAMES) {
            addUnique(candidates, join(configDir, fileName));
        }
    }
    return candidates;
}
function addEnvOverrides(raw) {
    const withEnv = { ...raw };
    const dsn = process.env.OPENCODE_SENTRY_DSN ?? process.env.SENTRY_DSN;
    if (dsn) {
        withEnv.dsn = dsn;
    }
    const tracesSampleRate = parseNumberEnv("OPENCODE_SENTRY_TRACES_SAMPLE_RATE");
    if (tracesSampleRate !== undefined) {
        withEnv.tracesSampleRate = tracesSampleRate;
    }
    const recordInputs = parseBooleanEnv("OPENCODE_SENTRY_RECORD_INPUTS");
    if (recordInputs !== undefined) {
        withEnv.recordInputs = recordInputs;
    }
    const recordOutputs = parseBooleanEnv("OPENCODE_SENTRY_RECORD_OUTPUTS");
    if (recordOutputs !== undefined) {
        withEnv.recordOutputs = recordOutputs;
    }
    const includeSessionEvents = parseBooleanEnv("OPENCODE_SENTRY_INCLUDE_SESSION_EVENTS");
    if (includeSessionEvents !== undefined) {
        withEnv.includeSessionEvents = includeSessionEvents;
    }
    const includeMessageUsageSpans = parseBooleanEnv("OPENCODE_SENTRY_INCLUDE_MESSAGE_USAGE_SPANS");
    if (includeMessageUsageSpans !== undefined) {
        withEnv.includeMessageUsageSpans = includeMessageUsageSpans;
    }
    const maxAttributeLength = parseNumberEnv("OPENCODE_SENTRY_MAX_ATTRIBUTE_LENGTH");
    if (maxAttributeLength !== undefined) {
        withEnv.maxAttributeLength = maxAttributeLength;
    }
    const enableMetrics = parseBooleanEnv("OPENCODE_SENTRY_ENABLE_METRICS");
    if (enableMetrics !== undefined) {
        withEnv.enableMetrics = enableMetrics;
    }
    const tagsEnv = process.env.OPENCODE_SENTRY_TAGS;
    if (tagsEnv) {
        const envTags = {};
        for (const pair of tagsEnv.split(",")) {
            const colonIdx = pair.indexOf(":");
            if (colonIdx > 0) {
                const key = pair.slice(0, colonIdx).trim();
                const val = pair.slice(colonIdx + 1).trim();
                if (key.length > 0 && val.length > 0) {
                    envTags[key] = val;
                }
            }
        }
        withEnv.tags = {
            ...withEnv.tags,
            ...envTags,
        };
    }
    if (process.env.SENTRY_ENVIRONMENT) {
        withEnv.environment = process.env.SENTRY_ENVIRONMENT;
    }
    if (process.env.SENTRY_RELEASE) {
        withEnv.release = process.env.SENTRY_RELEASE;
    }
    const diagnostics = parseBooleanEnv("OPENCODE_SENTRY_DIAGNOSTICS");
    if (diagnostics !== undefined) {
        withEnv.diagnostics = diagnostics;
    }
    const flushTimeoutMs = parseNumberEnv("OPENCODE_SENTRY_FLUSH_TIMEOUT_MS");
    if (flushTimeoutMs !== undefined) {
        withEnv.flushTimeoutMs = flushTimeoutMs;
    }
    const debug = parseBooleanEnv("OPENCODE_SENTRY_DEBUG");
    if (debug !== undefined) {
        withEnv.debug = debug;
    }
    return withEnv;
}
export async function loadPluginConfig(input, logger) {
    const candidates = getCandidatePaths(input);
    let source = "environment";
    let raw = {};
    for (const candidate of candidates) {
        if (!(await fileExists(candidate))) {
            continue;
        }
        const content = await readFile(candidate, "utf-8");
        raw = parseConfigContent(content, candidate);
        source = candidate;
        break;
    }
    const options = input.options ?? {};
    if (Object.keys(options).length > 0) {
        raw = { ...raw, ...options };
        if (source === "environment") {
            source = "plugin options";
        }
    }
    raw = addEnvOverrides(raw);
    if (typeof raw.dsn !== "string" || raw.dsn.trim().length === 0) {
        logger.info("Sentry plugin config not found. Plugin will remain disabled.", {
            lookedIn: candidates,
            expectedFiles: CONFIG_FILE_NAMES,
        });
        return null;
    }
    const config = normalizeConfig(raw);
    return { source, config };
}
//# sourceMappingURL=config.js.map