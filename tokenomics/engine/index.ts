/**
 * Shared optimisation engine. Platform-independent: reads only tokenomics/engine/evidence.ts types.
 *
 * Components today: work classifier (OPEX/CAPEX), optional LLM classifier, usage store,
 * cost calculation (pricing), context diet, budget; and for the value helpers: trace (what the
 * agent did), outcomes, ledger, forensics, loops, task contracts. Other engine components (model router,
 * output compressor, cache breakpoint optimiser, anomaly detector) belong here too.
 */
export * as budget from './budget.ts'
export * as classifier from './classifier.ts'
export * as contract from './contract.ts'
export * as currency from './currency.ts'
export * as diet from './diet.ts'
export * as forensics from './forensics.ts'
export * as ledger from './ledger.ts'
export * as loops from './loops.ts'
export * as outcomes from './outcomes.ts'
export * as pricing from './pricing.ts'
export * as session from './session.ts'
export * as store from './store.ts'
export * as trace from './trace.ts'
