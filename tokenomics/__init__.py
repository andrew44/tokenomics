"""tokenomics: one shared AI cost optimisation engine, two native platform adapters.

Layout (see README "Architecture"):
  tokenomics/engine/     shared, platform-independent logic (classifier, LLM step, usage store)
  tokenomics/platform/   the common platform interface and the capability registry
  tokenomics/adapters/   Claude Code and GitHub Copilot adapters (translation only, no business logic)
  tokenomics/config.py   shared configuration
  tokenomics/util.py     shared utilities

Stdlib only, Python 3.8+.
"""
__version__ = "1.1.0"
