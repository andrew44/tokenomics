"""Shared optimisation engine. Platform-independent: reads only tokenomics.engine.evidence types.

Components today: work classifier (OPEX/CAPEX), optional LLM classifier, usage store,
cost calculation (pricing), context diet, budget. Other engine components (model router,
output compressor, cache breakpoint optimiser, anomaly detector) belong here too.
"""
