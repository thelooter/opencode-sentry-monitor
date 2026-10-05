export interface PluginLogger {
    debug(message: string, extra?: Record<string, unknown>): void;
    info(message: string, extra?: Record<string, unknown>): void;
    warn(message: string, extra?: Record<string, unknown>): void;
    error(message: string, extra?: Record<string, unknown>): void;
}
export interface PluginConfig {
    dsn: string;
    tracesSampleRate?: number;
    environment?: string;
    release?: string;
    debug?: boolean;
    diagnostics?: boolean;
    flushTimeoutMs?: number;
    agentName?: string;
    projectName?: string;
    recordInputs?: boolean;
    recordOutputs?: boolean;
    maxAttributeLength?: number;
    includeMessageUsageSpans?: boolean;
    includeSessionEvents?: boolean;
    enableMetrics?: boolean;
    tags?: Record<string, string>;
}
export interface ResolvedPluginConfig {
    dsn: string;
    tracesSampleRate: number;
    environment?: string;
    release?: string;
    debug?: boolean;
    diagnostics: boolean;
    flushTimeoutMs: number;
    agentName?: string;
    projectName?: string;
    recordInputs: boolean;
    recordOutputs: boolean;
    maxAttributeLength: number;
    includeMessageUsageSpans: boolean;
    includeSessionEvents: boolean;
    enableMetrics: boolean;
    tags: Record<string, string>;
}
export interface ConfigInput {
    /** Directory OpenCode was opened in. */
    directory: string;
    /** Root of the project that directory belongs to, when it differs. */
    projectDirectory?: string;
    /** Options given for this plugin in the OpenCode `plugins` config. */
    options?: Readonly<Record<string, unknown>>;
}
export interface LoadedPluginConfig {
    source: string;
    config: ResolvedPluginConfig;
}
export declare function loadPluginConfig(input: ConfigInput, logger: PluginLogger): Promise<LoadedPluginConfig | null>;
//# sourceMappingURL=config.d.ts.map