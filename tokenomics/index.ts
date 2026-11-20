/**
 * tokenomics: one shared AI cost optimisation engine, two native platform adapters.
 *
 * Layout (see docs/architecture.md):
 *   tokenomics/engine/     shared, platform-independent logic (classifier, LLM step, usage store)
 *   tokenomics/services/   the intelligence engine: Cost, Telemetry, Outcome, Policy and Insights engines
 *   tokenomics/platform/   the common platform interface and the capability registry
 *   tokenomics/adapters/   Claude Code and GitHub Copilot adapters (translation only, no business logic)
 *   tokenomics/config.ts   shared configuration
 *   tokenomics/util.ts     shared utilities
 *
 * TypeScript, run directly by Node.js 22.18+ (no build step). Node built-ins only.
 */
export const VERSION = '2.2.0'
