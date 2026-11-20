/**
 * Shared optimisation engine. Platform-independent: reads only tokenomics/engine/evidence.ts types.
 *
 * Components today: work classifier (OPEX/CAPEX), optional LLM classifier, usage store,
 * cost calculation (pricing), context diet, budget. Other engine components (model router,
 * output compressor, cache breakpoint optimiser, anomaly detector) belong here too.
 */
export * as budget from './budget.ts'
export * as classifier from './classifier.ts'
export * as currency from './currency.ts'
export * as diet from './diet.ts'
export * as pricing from './pricing.ts'
export * as session from './session.ts'
export * as store from './store.ts'
