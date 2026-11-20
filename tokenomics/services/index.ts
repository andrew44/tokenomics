/**
 * The tokenomics intelligence engine: five shared services every helper is built on.
 *
 *   Observe     TelemetryEngine   lifecycle events from every platform, in one shared format
 *   Understand  InsightsEngine    waste, loops, dead work, scope creep, spending patterns
 *               CostEngine        prices, providers, workload costs, projections
 *   Optimise    PolicyEngine      budgets, thresholds and enforcement, per platform
 *   Prove       OutcomeEngine     task success and quality from observable signals
 *
 * Adapters (tokenomics/adapters) only translate a platform's lifecycle into TelemetryEngine's events;
 * no helper has a Claude version and a Copilot version. The older engine modules (tokenomics/engine)
 * are the building blocks these services are made of.
 */
export * as CostEngine from './cost.ts'
export * as InsightsEngine from './insights.ts'
export * as OutcomeEngine from './outcome.ts'
export * as PolicyEngine from './policy.ts'
export * as TelemetryEngine from './telemetry.ts'
export * as ValuePipeline from './value.ts'
