"""Shared optimisation engine. Platform-independent: reads only tokenomics.engine.evidence types.

Components today: work classifier (OPEX/CAPEX), optional LLM classifier, usage store.
The other engine components (model router, context diet, output compressor, cache
breakpoint optimiser, anomaly detector, cost calculation, reporting) belong here too.
"""
