/** The status bar's numbers, as `statusbar.py --json` gives them (already formatted). */
export type Bar = {
  show: boolean
  model?: string
  pct?: number
  level?: 'green' | 'yellow' | 'red'
  gauge?: string
  tokens?: string
  cost?: string
  ttl?: number
  /** Epoch seconds when the prompt cache goes cold; null when nothing is cached yet. */
  cold_at?: number | null
  /** Egg-timer icons: full, half, empty. */
  icons?: string[]
}

declare module 'claude-code' {
  interface PluginState {
    tokenomics: { bar: Bar | null }
  }
}
