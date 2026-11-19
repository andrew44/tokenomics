#!/usr/bin/env python3
"""tokenomics / statusbar: a live status line for Claude Code and GitHub Copilot CLI.

Shows, on one line:
  * model
  * context gauge   (smooth green -> yellow at 75% -> red at 90%, with the percentage)
  * total tokens    (compact: 950, 12.3K, 8.5M)
  * session cost    (in GBP, USD or EUR, e.g. £1.37)
  * prompt-cache expiry countdown (MM:ss) with an egg-timer that empties as the cache goes cold

Both CLIs run this as a command, pipe a JSON payload on stdin and print whatever we write to
stdout. Stdlib only. Never raises: on any problem it prints a minimal line and exits 0.

Usage
  statusbar.py                      render once from the stdin JSON (what the CLIs do)
  statusbar.py --install [claude|copilot|both]   wire it into the CLI settings (backs them up)
  statusbar.py --uninstall [claude|copilot|both]
  statusbar.py --status             say where the status bar is installed
  statusbar.py --sync               SessionStart hook (plugin): refresh the installed copy after a
                                    plugin update; offer it once if no status line is set
                                    (TOKENOMICS_STATUSBAR=auto installs it, =off stays quiet)
  statusbar.py --watch [--path FILE]  live-refresh every second (for terminals/CLIs that only
                                    redraw on activity, so the timer keeps ticking)
  statusbar.py --demo               preview every state (use with --theme light|dark)
  statusbar.py --update-rate        fetch today's USD->GBP and USD->EUR rates and save them
  statusbar.py --set-currency GBP|USD|EUR   save the display currency
  Flags: --theme light|dark|system   --currency GBP|USD|EUR   --ascii   --no-color

Config: ~/.tokenomics/statusbar.json (or $TOKENOMICS_HOME/statusbar.json), all optional:
  {"theme": "system", "currency": "GBP", "usd_gbp": 0.76, "usd_eur": 0.86, "cache_ttl": null,
   "width": 12, "warn": 75, "crit": 90}
Env overrides: TOKENOMICS_THEME, TOKENOMICS_CURRENCY, TOKENOMICS_USD_GBP, TOKENOMICS_USD_EUR,
  TOKENOMICS_CACHE_TTL (seconds),
  TOKENOMICS_ASCII=1, TOKENOMICS_TIMER_ICONS="full,half,empty", NO_COLOR.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HOME = Path.home()
CFG_DIR = Path(os.environ.get("TOKENOMICS_HOME", str(HOME / ".tokenomics")))
CFG_FILE = CFG_DIR / "statusbar.json"
STATE_FILE = CFG_DIR / "statusbar-state.json"

DEFAULT_CFG = {"theme": "system", "cache_ttl": None,
               "width": 12, "warn": 75, "crit": 90}

# ---- currency: keep identical to tokenomics/engine/currency.py (tests/test_features.py checks) ---
# BEGIN CURRENCY
# Display currency: USD, EUR or GBP (default). Chosen by TOKENOMICS_CURRENCY, then "currency" in
# statusbar.json; "$", "€", "£", "usd", "euro", "pounds" ... are accepted too. Prices are in USD
# and converted at the rate in TOKENOMICS_USD_EUR / TOKENOMICS_USD_GBP, then "usd_eur" /
# "usd_gbp" in statusbar.json, then the defaults below (`statusbar.py --update-rate` saves
# today's rates).
CURRENCIES = {"USD": ("$", None, 1.0), "EUR": ("€", "usd_eur", 0.86), "GBP": ("£", "usd_gbp", 0.76)}
DEFAULT_CURRENCY = "GBP"
CURRENCY_ALIASES = {"$": "USD", "US$": "USD", "DOLLAR": "USD", "DOLLARS": "USD", "€": "EUR", "EURO": "EUR",
                    "EUROS": "EUR", "£": "GBP", "POUND": "GBP", "POUNDS": "GBP", "STERLING": "GBP"}


def currency_code(value):
    """'eur', '€', 'Euro' ... -> 'EUR'; None if not a supported currency."""
    v = str(value or "").strip().upper()
    v = CURRENCY_ALIASES.get(v, v)
    return v if v in CURRENCIES else None


def currency(cfg):
    """-> (code, symbol, units of that currency per US dollar)."""
    cfg = cfg or {}
    code = (currency_code(os.environ.get("TOKENOMICS_CURRENCY")) or currency_code(cfg.get("currency"))
            or DEFAULT_CURRENCY)
    symbol, key, rate = CURRENCIES[code]
    if key:
        for v in (os.environ.get("TOKENOMICS_" + key.upper()), cfg.get(key)):
            try:
                if v not in (None, "") and float(v) > 0:
                    rate = float(v)
                    break
            except (TypeError, ValueError):
                pass
    return code, symbol, rate


def format_money(amount, symbol, whole_above=None):
    """'£1,234.50'; with whole_above=100, amounts from 100 up drop the pence/cents."""
    amount = float(amount or 0)
    sign = "-" if amount < 0 else ""
    if whole_above is not None and abs(amount) >= whole_above:
        return f"{sign}{symbol}{abs(amount):,.0f}"
    return f"{sign}{symbol}{abs(amount):,.2f}"
# END CURRENCY

# Price tables (USD per million tokens). Only used when the CLI does not report a cost itself
# (Copilot, or older Claude Code). Marked with "~" on screen.
#  1. {"prices": {"opus": [5, 25], "sonnet": [3, 15]}} in statusbar.json wins (substring match);
#  2. then data/model-prices.json, per Claude model id, kept current by
#     .github/workflows/update-prices.yml from Claude's pricing page;
#  3. then this per-family fallback.
PRICES = {"opus": (5.0, 25.0), "sonnet": (3.0, 15.0), "haiku": (1.0, 5.0),
          "gpt": (2.5, 10.0), "gemini": (1.25, 10.0)}
DEFAULT_PRICE = (3.0, 15.0)
FAST_MULTIPLIER = 2.0             # usage.speed == "fast": fast mode bills 2x the standard rates
CACHE_WRITE_5M, CACHE_WRITE_1H, CACHE_READ = 1.25, 2.0, 0.1       # x input, when a model has no listed rate
# data/model-prices.json sits two levels up in the repo; `--install` copies it next to the installed script.
MODEL_PRICES_FILES = (Path(__file__).resolve().parent / "model-prices.json",
                      Path(__file__).resolve().parent.parent / "data" / "model-prices.json")
_CLAUDE_FAMILIES = "fable|mythos|opus|sonnet|haiku"
_FAMILY_FIRST = re.compile(rf"({_CLAUDE_FAMILIES})[\s_-]*(\d+)(?:[.-](\d)(?!\d))?")
_VERSION_FIRST = re.compile(rf"(\d+)[.-](\d)(?!\d)[\s_-]*({_CLAUDE_FAMILIES})")
_model_prices_cache = None

# ----------------------------------------------------------------------------- config ---


def load_cfg():
    cfg = dict(DEFAULT_CFG)
    try:
        cfg.update(json.loads(CFG_FILE.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        pass
    env = os.environ
    if env.get("TOKENOMICS_THEME"):
        cfg["theme"] = env["TOKENOMICS_THEME"].lower()
    for key, name, cast in (("cache_ttl", "TOKENOMICS_CACHE_TTL", int),):
        try:
            if env.get(name):
                cfg[key] = cast(env[name])
        except ValueError:
            pass
    return cfg


def load_state():
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_state(state):
    try:
        CFG_DIR.mkdir(parents=True, exist_ok=True)
        tmp = STATE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(state), encoding="utf-8")
        os.replace(tmp, STATE_FILE)
    except OSError:
        pass


# ----------------------------------------------------------------------------- themes ----


def system_theme(state):
    """Best-effort light/dark detection. Terminal hint first, then the OS. Cached for 60s."""
    cached = state.get("theme_cache") or {}
    if time.time() - cached.get("at", 0) < 60 and cached.get("value"):
        return cached["value"]
    value = None
    fgbg = os.environ.get("COLORFGBG", "")           # "15;0" = light fg on dark bg (xterm, rxvt, ...)
    if fgbg and fgbg.split(";")[-1].isdigit():
        value = "light" if int(fgbg.split(";")[-1]) in (7, 15) else "dark"
    if value is None:
        try:
            if sys.platform == "darwin":
                r = subprocess.run(["defaults", "read", "-g", "AppleInterfaceStyle"],
                                   capture_output=True, text=True, timeout=1)
                value = "dark" if "dark" in r.stdout.lower() else "light"
            elif sys.platform == "win32":
                import winreg
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                                    r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize") as k:
                    value = "light" if winreg.QueryValueEx(k, "AppsUseLightTheme")[0] else "dark"
            else:
                r = subprocess.run(["gsettings", "get", "org.gnome.desktop.interface", "color-scheme"],
                                   capture_output=True, text=True, timeout=1)
                if r.stdout.strip():
                    value = "dark" if "dark" in r.stdout.lower() else "light"
        except Exception:
            value = None
    value = value or "dark"
    state["theme_cache"] = {"at": time.time(), "value": value}
    return value


PALETTE = {
    "dark": {"text": (205, 214, 244), "dim": (127, 132, 156), "track": (69, 71, 90),
             "accent": (137, 180, 250), "sep": (88, 91, 112),
             "green": (46, 204, 113), "yellow": (249, 205, 52), "red": (240, 82, 82)},
    "light": {"text": (36, 41, 47), "dim": (101, 109, 118), "track": (208, 215, 222),
              "accent": (9, 105, 218), "sep": (175, 184, 193),
              "green": (26, 150, 70), "yellow": (190, 130, 0), "red": (207, 34, 46)},
}


class Style:
    def __init__(self, theme, color=True, ascii_only=False):
        self.p = PALETTE[theme]
        self.theme = theme
        self.color = color
        self.ascii = ascii_only
        ct = os.environ.get("COLORTERM", "").lower()
        self.truecolor = ct in ("truecolor", "24bit") or bool(os.environ.get("WT_SESSION"))

    def fg(self, rgb):
        if not self.color:
            return ""
        r, g, b = (int(round(v)) for v in rgb)
        if self.truecolor:
            return f"\x1b[38;2;{r};{g};{b}m"
        return f"\x1b[38;5;{rgb_to_256(r, g, b)}m"

    def paint(self, text, key_or_rgb, bold=False):
        rgb = self.p[key_or_rgb] if isinstance(key_or_rgb, str) else key_or_rgb
        if not self.color:
            return text
        b = "\x1b[1m" if bold else ""
        return f"{b}{self.fg(rgb)}{text}\x1b[0m"


def rgb_to_256(r, g, b):
    if r == g == b:
        if r < 8:
            return 16
        if r > 248:
            return 231
        return round((r - 8) / 247 * 24) + 232
    return 16 + 36 * round(r / 255 * 5) + 6 * round(g / 255 * 5) + round(b / 255 * 5)


def lerp(a, b, t):
    t = max(0.0, min(1.0, t))
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def level_color(style, pct, warn, crit):
    """Green (held to 50%) -> yellow at `warn` -> red at `crit`, blended smoothly in between."""
    g, y, r = style.p["green"], style.p["yellow"], style.p["red"]
    hold = min(50.0, warn - 1)
    if pct <= hold:
        return g
    if pct <= warn:
        return lerp(g, y, (pct - hold) / (warn - hold))
    if pct <= crit:
        return lerp(y, r, (pct - warn) / (crit - warn))
    return r


# ----------------------------------------------------------------------------- numbers ---


def human(n):
    n = float(n or 0)
    for unit, size in (("B", 1e9), ("M", 1e6), ("K", 1e3)):
        if n >= size:
            v = n / size
            s = f"{v:.1f}" if v < 100 else f"{v:.0f}"
            return (s[:-2] if s.endswith(".0") else s) + unit
    return str(int(n))


def money(amount, symbol="£"):
    return format_money(amount, symbol, whole_above=100)


def mmss(seconds):
    seconds = max(0, int(seconds))
    return f"{seconds // 60:02d}:{seconds % 60:02d}"


def load_model_prices():
    """{model_id: entry} from data/model-prices.json ({} if missing or unreadable)."""
    global _model_prices_cache
    if _model_prices_cache is None:
        _model_prices_cache = {}
        for path in MODEL_PRICES_FILES:
            try:
                _model_prices_cache = json.loads(path.read_text(encoding="utf-8")).get("models") or {}
                break
            except (OSError, ValueError, AttributeError):
                continue
    return _model_prices_cache


def claude_model_id(model):
    """Canonical id for a Claude model name or id, e.g. 'Opus 5.5' or 'claude-opus-5-5[1m]' ->
    'claude-opus-5-5'; 'claude-3-5-haiku-20241022' -> 'claude-3-5-haiku'. None if not Claude."""
    m = (model or "").lower()
    hit = _VERSION_FIRST.search(m)
    if hit:
        return f"claude-{hit.group(1)}-{hit.group(2)}-{hit.group(3)}"
    hit = _FAMILY_FIRST.search(m)
    if not hit:
        return None
    family, major, minor = hit.group(1), int(hit.group(2)), hit.group(3)
    ver = f"{major}-{minor}" if minor and minor != "0" else f"{major}"
    return f"claude-{ver}-{family}" if major < 4 else f"claude-{family}-{ver}"


def rates_for(model, cfg):
    """Per-million-token USD rates: input, output, cache_write_5m, cache_write_1h, cache_read
    (plus long_context when the model has a long-prompt tier)."""
    m = (model or "").lower()
    best = None
    for k, v in (cfg.get("prices") or {}).items():            # user overrides: most specific key wins
        try:
            key = re.sub(r"[\s._]+", "-", str(k).lower())
            if key and re.search(r"(?<![a-z0-9])" + re.escape(key) + r"(?![0-9])", re.sub(r"[\s._]+", "-", m)) \
                    and (best is None or len(key) > len(best[0])):
                best = (key, float(v[0]), float(v[1]), float(v[2]) if len(v) > 2 else None)
        except (TypeError, ValueError, IndexError):
            pass
    if best:
        _, pin, pout, pread = best
        return {"input": pin, "output": pout, "cache_write_5m": pin * CACHE_WRITE_5M,
                "cache_write_1h": pin * CACHE_WRITE_1H, "cache_read": pin * CACHE_READ if pread is None else pread}
    entry = load_model_prices().get(claude_model_id(m) or "")
    if entry:
        try:
            pin = float(entry["input"])
            rates = {"input": pin, "output": float(entry["output"]),
                     "cache_write_5m": float(entry.get("cache_write_5m", pin * 1.25)),
                     "cache_write_1h": float(entry.get("cache_write_1h", pin * 2.0)),
                     "cache_read": float(entry.get("cache_read", pin * 0.1))}
            if isinstance(entry.get("long_context"), dict):
                rates["long_context"] = entry["long_context"]
            return rates
        except (KeyError, TypeError, ValueError):
            pass
    pin, pout = DEFAULT_PRICE
    for key, val in PRICES.items():
        if key in m:
            pin, pout = val
            break
    return {"input": pin, "output": pout, "cache_write_5m": pin * 1.25,
            "cache_write_1h": pin * 2.0, "cache_read": pin * 0.1}


def price_for(model, cfg):
    """(input, output) USD per million tokens."""
    r = rates_for(model, cfg)
    return r["input"], r["output"]


def usage_cost_usd(u, model, cfg):
    """Cost of one usage dict (one request) in USD: the model's input, output, cache-write and
    cache-read rates, Haiku-style long-prompt tiers, and fast mode at 2x."""
    r = rates_for(model, cfg)
    cc = u.get("cache_creation") or {}
    w1h = int(cc.get("ephemeral_1h_input_tokens") or 0)
    w5m = int(cc.get("ephemeral_5m_input_tokens") or 0)
    if not (w1h or w5m):
        w5m = int(u.get("cache_creation_input_tokens") or 0)
    inp = int(u.get("input_tokens") or 0)
    read = int(u.get("cache_read_input_tokens") or 0)
    lc = r.get("long_context")
    if lc and inp + w5m + w1h + read > int(lc.get("threshold") or 0):
        r = {**r, **{k: float(v) for k, v in lc.items() if k != "threshold"}}
    usd = (inp * r["input"] + int(u.get("output_tokens") or 0) * r["output"]
           + w5m * r["cache_write_5m"] + w1h * r["cache_write_1h"] + read * r["cache_read"]) / 1e6
    return usd * FAST_MULTIPLIER if u.get("speed") == "fast" else usd


# ----------------------------------------------------------------------------- transcript


def parse_ts(s):
    if not s:
        return None
    try:
        if isinstance(s, (int, float)):
            return s / 1000 if s > 1e11 else float(s)
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")).astimezone(timezone.utc).timestamp()
    except ValueError:
        return None


def newest_jsonl(directory):
    best, best_m = None, 0
    try:
        for p in Path(directory).glob("*.jsonl"):
            m = p.stat().st_mtime
            if m > best_m:
                best, best_m = p, m
    except OSError:
        pass
    return best


def scan_transcript(path, state, cfg):
    """Incrementally read a Claude-style JSONL transcript. Returns a dict of running totals.

    Streamed assistant entries repeat the same message id, so the latest usage for an id replaces
    the earlier one (the repeats are consecutive, so remembering the last id is enough).
    """
    path = str(path)
    if not os.path.isfile(path):
        return None
    cache = state.setdefault("transcripts", {})
    st = cache.get(path)
    size = os.path.getsize(path)
    if not st or st.get("offset", 0) > size:
        st = {"offset": 0, "tok": {"input": 0, "output": 0, "cw": 0, "cr": 0}, "cost": 0.0,
              "last_id": None, "last_u": None, "last_cost": 0.0, "last_cache_ts": None,
              "ttl_1h": False, "ctx": 0, "model": None, "msgs": 0}
    if size > st["offset"]:
        with open(path, "rb") as f:
            f.seek(st["offset"])
            chunk = f.read()
        end = chunk.rfind(b"\n")
        if end >= 0:
            for raw in chunk[:end + 1].splitlines():
                if b'"usage"' not in raw:
                    continue
                try:
                    ev = json.loads(raw)
                except ValueError:
                    continue
                msg = ev.get("message") or {}
                u = msg.get("usage")
                if ev.get("type") != "assistant" or not isinstance(u, dict):
                    continue
                model = msg.get("model") or st["model"]
                if model and model != "<synthetic>":
                    st["model"] = model
                mid = msg.get("id") or ev.get("uuid")
                if mid is not None and mid == st["last_id"] and st["last_u"]:
                    p = st["last_u"]                      # replace the earlier streamed copy
                    st["tok"]["input"] -= int(p.get("input_tokens") or 0)
                    st["tok"]["output"] -= int(p.get("output_tokens") or 0)
                    st["tok"]["cw"] -= int(p.get("cache_creation_input_tokens") or 0)
                    st["tok"]["cr"] -= int(p.get("cache_read_input_tokens") or 0)
                    st["cost"] -= st["last_cost"]
                else:
                    st["msgs"] += 1
                c = usage_cost_usd(u, model, cfg)
                st["tok"]["input"] += int(u.get("input_tokens") or 0)
                st["tok"]["output"] += int(u.get("output_tokens") or 0)
                st["tok"]["cw"] += int(u.get("cache_creation_input_tokens") or 0)
                st["tok"]["cr"] += int(u.get("cache_read_input_tokens") or 0)
                st["cost"] += c
                st["last_id"], st["last_u"], st["last_cost"] = mid, u, c
                if not ev.get("isSidechain"):
                    st["ctx"] = (int(u.get("input_tokens") or 0)
                                 + int(u.get("cache_read_input_tokens") or 0)
                                 + int(u.get("cache_creation_input_tokens") or 0))
                if int(u.get("cache_read_input_tokens") or 0) + int(u.get("cache_creation_input_tokens") or 0):
                    ts = parse_ts(ev.get("timestamp"))
                    if ts:
                        st["last_cache_ts"] = ts
                        cc = u.get("cache_creation") or {}
                        if int(cc.get("ephemeral_1h_input_tokens") or 0):
                            st["ttl_1h"] = True
                        elif int(cc.get("ephemeral_5m_input_tokens") or 0):
                            st["ttl_1h"] = False
            st["offset"] += end + 1
    st["seen"] = time.time()
    cache[path] = st
    if len(cache) > 20:                                   # keep the state file small: drop least recently used
        for k in sorted(cache, key=lambda k: cache[k].get("seen", 0))[:len(cache) - 20]:
            cache.pop(k, None)
    return st


# ----------------------------------------------------------------------------- gather ----


def gather(payload, cfg, state):
    """Collapse whatever the CLI told us (plus the transcript) into the numbers we display."""
    cw = payload.get("context_window") or {}
    model = payload.get("model") or {}
    if isinstance(model, str):
        model = {"id": model}
    elif not isinstance(model, dict):
        model = {}
    model_id = model.get("id") or ""
    name = model.get("display_name") or model_id or ""
    tpath = payload.get("transcript_path")
    st = None
    events_file = None
    if tpath:
        p = Path(tpath)
        if p.is_dir():                                    # Copilot: a session-state directory
            events_file = newest_jsonl(p)
            if events_file:
                st = scan_transcript(events_file, state, cfg)
        elif p.is_file():
            events_file = p
            st = scan_transcript(p, state, cfg)
    has_tx = bool(st and st["msgs"])
    if not name and has_tx and st.get("model"):
        name = st["model"]

    # ---- total tokens (everything the session has processed, cache reads included)
    if has_tx:
        t = st["tok"]
        total = t["input"] + t["output"] + t["cw"] + t["cr"]
    else:
        total = cw.get("total_tokens")
        if total is None:
            total = sum(int(cw.get(k) or 0) for k in (
                "total_input_tokens", "total_output_tokens",
                "total_cache_read_tokens", "total_cache_write_tokens"))

    # ---- cost in USD -> display currency
    cost_usd = (payload.get("cost") or {}).get("total_cost_usd")
    estimated = False
    if cost_usd is None:
        estimated = True
        if has_tx:
            cost_usd = st["cost"]
        else:
            u = {"input_tokens": cw.get("total_input_tokens"), "output_tokens": cw.get("total_output_tokens"),
                 "cache_read_input_tokens": cw.get("total_cache_read_tokens"),
                 "cache_creation_input_tokens": cw.get("total_cache_write_tokens")}
            cost_usd = usage_cost_usd(u, model_id or name, cfg)
    code, symbol, rate = currency(cfg)
    cost = float(cost_usd or 0) * rate

    # ---- context percentage
    pct = cw.get("current_context_used_percentage")
    if pct is None:
        pct = cw.get("used_percentage")
    if pct is None:
        window = cw.get("displayed_context_limit") or cw.get("context_window_size")
        if not window:
            window = 1_000_000 if re.search(r"1m\b|\[1m\]", model_id.lower()) else 200_000
        used = cw.get("current_context_tokens")
        if used is None and has_tx:
            used = st["ctx"]
        if used is None:
            cu = cw.get("current_usage") or {}
            used = sum(int(cu.get(k) or 0) for k in
                       ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
        pct = (used or 0) / window * 100 if window else 0
    pct = max(0.0, min(100.0, float(pct)))

    # ---- cache expiry
    ttl = cfg.get("cache_ttl") or (3600 if has_tx and st["ttl_1h"] else 300)
    last = st["last_cache_ts"] if has_tx else None
    if last is None and events_file:                      # no usage records: use last write time
        try:
            last = events_file.stat().st_mtime
        except OSError:
            last = None
    remaining = None if last is None else max(0.0, ttl - (time.time() - last))
    return {"model": name, "total": total, "cost": cost, "symbol": symbol, "estimated": estimated,
            "pct": pct, "ttl": ttl, "remaining": remaining}


# ----------------------------------------------------------------------------- render ----

PARTIALS = " ▏▎▍▌▋▊▉"


def gauge(style, pct, width, warn, crit):
    if style.ascii:
        filled = int(round(pct / 100 * width))
        bar = "#" * filled + "-" * (width - filled)
        return style.paint(bar, level_color(style, pct, warn, crit))
    exact = pct / 100 * width
    full = int(exact)
    part = int(round((exact - full) * 8))
    if part == 8:
        full, part = full + 1, 0
    out = []
    for i in range(width):
        if i < full:
            out.append(style.paint("█", level_color(style, (i + 0.5) / width * 100, warn, crit)))
        elif i == full and part:
            out.append(style.paint(PARTIALS[part], level_color(style, (i + 0.5) / width * 100, warn, crit)))
        else:
            out.append(style.paint("▒", "track"))
    return "".join(out)


def timer_icons():
    custom = os.environ.get("TOKENOMICS_TIMER_ICONS")
    if custom and custom.count(",") == 2:
        return custom.split(",")
    return ["⧗", "⏳︎", "⧖"]          # full, half (sand flowing), empty


def render(info, style, cfg):
    warn, crit = cfg["warn"], cfg["crit"]
    sep = style.paint(" │ " if not style.ascii else " | ", "sep")
    parts = []

    brand = "◆" if not style.ascii else "*"
    label = f"{brand} {info['model']}".strip() if info["model"] else brand
    parts.append(style.paint(label, "accent", bold=True))

    pct = info["pct"]
    col = level_color(style, pct, warn, crit)
    flag = " ▲" if pct >= crit and not style.ascii else (" !" if pct >= crit else "")
    parts.append(style.paint("ctx ", "dim") + gauge(style, pct, int(cfg["width"]), warn, crit)
                 + " " + style.paint(f"{pct:.0f}%{flag}", col, bold=True))

    parts.append(style.paint("Σ " if not style.ascii else "tok ", "dim")
                 + style.paint(human(info["total"]), "text", bold=True))

    approx = "~" if info["estimated"] else ""
    parts.append(style.paint(approx + money(info["cost"], info.get("symbol", "£")), "text", bold=True))

    rem, ttl = info["remaining"], info["ttl"]
    full, half, empty = timer_icons()
    if style.ascii:
        full, half, empty = "[##]", "[# ]", "[  ]"
    if rem is None:
        parts.append(style.paint(f"{empty} --:--", "dim"))
    else:
        frac = rem / ttl if ttl else 0
        if rem <= 0:
            icon, ckey = empty, "red"
        elif frac > 0.75:
            icon, ckey = full, "green"
        elif frac > 0.25:
            icon, ckey = half, "yellow"
        else:
            icon, ckey = empty, "red"
        parts.append(style.paint(f"{icon} {mmss(rem)}", ckey, bold=True))
    return sep.join(parts)


# ----------------------------------------------------------------------------- commands --


def make_style(cfg, state, args):
    theme = cfg["theme"]
    for i, a in enumerate(args):
        if a == "--theme" and i + 1 < len(args):
            theme = args[i + 1].lower()
    if theme not in ("light", "dark"):
        theme = system_theme(state)
    color = "--no-color" not in args and not os.environ.get("NO_COLOR")
    ascii_only = "--ascii" in args or os.environ.get("TOKENOMICS_ASCII") == "1"
    return Style(theme, color, ascii_only)


def read_payload():
    if sys.stdin is None or sys.stdin.isatty():
        return {}
    try:
        raw = sys.stdin.read()
        return json.loads(raw) if raw.strip() else {}
    except (ValueError, OSError):
        return {}


def discover_session():
    """Newest Claude Code or Copilot transcript on this machine (for --watch)."""
    best, best_m = None, 0
    for root in (HOME / ".claude" / "projects", HOME / ".copilot" / "session-state"):
        if not root.is_dir():
            continue
        for p in root.glob("**/*.jsonl"):
            try:
                m = p.stat().st_mtime
            except OSError:
                continue
            if m > best_m:
                best, best_m = p, m
    return best


def demo(args):
    cfg = load_cfg()
    state = {}
    style = make_style(cfg, state, args)
    print(f"theme: {style.theme}\n")
    cases = [(8, 290, 12_300, 0.04), (52, 200, 480_000, 0.42), (76, 120, 2_100_000, 1.37),
             (84, 70, 5_400_000, 3.9), (92, 12, 8_500_000, 6.21), (97, 0, 12_800_000, 14.8)]
    _, symbol, rate = currency(cfg)
    for pct, rem, total, usd in cases:
        info = {"model": "Sonnet 5.5", "total": total, "cost": usd * rate, "symbol": symbol, "estimated": False,
                "pct": pct, "ttl": 300, "remaining": rem}
        print(render(info, style, cfg))
    print(render({"model": "gpt-5", "total": 0, "cost": 0, "symbol": symbol, "estimated": True, "pct": 0,
                  "ttl": 300, "remaining": None}, style, cfg))


def watch(args):
    path = None
    for i, a in enumerate(args):
        if a == "--path" and i + 1 < len(args):
            path = args[i + 1]
    cfg = load_cfg()
    try:
        while True:
            state = load_state()
            style = make_style(cfg, state, args)
            target = path or discover_session()
            payload = {"transcript_path": str(target)} if target else {}
            line = render(gather(payload, cfg, state), style, cfg)
            save_state(state)
            sys.stdout.write("\r\x1b[2K" + line)
            sys.stdout.flush()
            time.sleep(1)
    except KeyboardInterrupt:
        sys.stdout.write("\n")


def _save_cfg(**changes):
    cfg = {}
    try:
        cfg = json.loads(CFG_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    cfg.update(changes)
    CFG_DIR.mkdir(parents=True, exist_ok=True)
    CFG_FILE.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


def update_rate():
    import urllib.request
    url = "https://api.frankfurter.dev/v1/latest?base=USD&symbols=GBP,EUR"
    try:
        with urllib.request.urlopen(url, timeout=8) as r:
            rates = json.load(r)["rates"]
            usd_gbp, usd_eur = float(rates["GBP"]), float(rates["EUR"])
    except Exception as e:
        print(f"Could not fetch the rates ({e}). Set them by hand: TOKENOMICS_USD_GBP=0.76, "
              f'TOKENOMICS_USD_EUR=0.86, or "usd_gbp" / "usd_eur" in {CFG_FILE}')
        return 1
    _save_cfg(usd_gbp=usd_gbp, usd_eur=usd_eur)
    print(f"USD->GBP = {usd_gbp}, USD->EUR = {usd_eur} saved to {CFG_FILE}")
    return 0


def set_currency(value):
    code = currency_code(value)
    if not code:
        print(f"Unknown currency {value!r}: use one of {', '.join(CURRENCIES)}.")
        return 1
    _save_cfg(currency=code)
    print(f"Costs will now show in {code} ({CURRENCIES[code][0]}). Saved to {CFG_FILE}")
    return 0


def _flag(args, name):
    """Value after `name` in args, or None."""
    i = args.index(name) if name in args else -1
    return args[i + 1] if 0 <= i < len(args) - 1 else None


def _read_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except ValueError:
        raise SystemExit(f"{path} is not valid JSON; fix it first (nothing was changed).")


def _write_json(path, data):
    if path.exists():
        shutil.copy2(path, path.with_name(path.name + ".tokenomics.bak"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def _settings_path(target):
    if target == "claude":
        return Path(os.environ.get("CLAUDE_CONFIG_DIR", HOME / ".claude")) / "settings.json"
    if target == "copilot":
        return Path(os.environ.get("COPILOT_HOME", HOME / ".copilot")) / "settings.json"
    raise SystemExit("target must be claude, copilot or both")


def _installed_copy():
    return CFG_DIR / "statusbar.py"


def _copy_files():
    """Copy this script and the price list to a stable path that survives plugin updates."""
    CFG_DIR.mkdir(parents=True, exist_ok=True)
    dest = _installed_copy()
    src = Path(__file__).resolve()
    if src != dest.resolve():
        shutil.copy2(src, dest)
    for prices in MODEL_PRICES_FILES[1:]:                 # prices travel with it
        if prices.is_file():
            shutil.copy2(prices, CFG_DIR / "model-prices.json")
            break
    return dest


def _status_line(target):
    """The statusLine command in a CLI's settings, or None. Never raises."""
    try:
        line = json.loads(_settings_path(target).read_text(encoding="utf-8")).get("statusLine")
        return (line or {}).get("command") if isinstance(line, dict) else None
    except (OSError, ValueError, AttributeError):
        return None


def _is_ours(command):
    return bool(command) and "statusbar.py" in command and str(CFG_DIR) in command


def install(target, remove=False):
    targets = ("claude", "copilot") if target == "both" else (target,)
    for t in targets:
        _settings_path(t)                                 # validate before touching anything
    if not remove:
        dest = _copy_files()
    command = f'"{sys.executable}" "{_installed_copy()}"'
    for t in targets:
        path = _settings_path(t)
        data = _read_json(path)
        if t == "claude":
            if remove:
                data.pop("statusLine", None)
            else:
                data["statusLine"] = {"type": "command", "command": command, "padding": 0,
                                      "refreshInterval": 1}
        else:
            flags = data.setdefault("feature_flags", {}).setdefault("enabled", [])
            if remove:
                data.pop("statusLine", None)
            else:
                data["statusLine"] = {"type": "command", "command": command, "padding": 1}
                if "STATUS_LINE" not in flags:
                    flags.append("STATUS_LINE")
        _write_json(path, data)
        print(f"{'Removed from' if remove else 'Installed in'} {path} (backup: settings.json.tokenomics.bak)")
    if not remove:
        print(f"Restart the CLI to pick it up. Preview: python3 \"{dest}\" --demo --theme light")


def status():
    for t in ("claude", "copilot"):
        cmd = _status_line(t)
        where = _settings_path(t)
        if _is_ours(cmd):
            print(f"{t}: installed ({where})")
        elif cmd:
            print(f"{t}: another status line is set in {where}: {cmd}")
        else:
            print(f"{t}: not installed")
    return 0


HINT_FILE = CFG_DIR / "statusbar-offered"


def _same(a, b):
    try:
        return a.read_bytes() == b.read_bytes()
    except OSError:
        return False


def _out_of_date():
    """True when the installed copy or its price list differs from the one beside this script."""
    if not _same(_installed_copy(), Path(__file__).resolve()):
        return True
    prices = next((p for p in MODEL_PRICES_FILES[1:] if p.is_file()), None)
    return bool(prices) and not _same(CFG_DIR / "model-prices.json", prices)


def sync():
    """SessionStart hook. Quiet and fast; never fails the session.

    * Installed already: refresh ~/.tokenomics/statusbar.py and the price list from the plugin, so
      the bar updates whenever the plugin does.
    * No status line at all: with TOKENOMICS_STATUSBAR=auto, install it; otherwise say once how to.
    * Someone else's status line: leave it alone.
    """
    try:
        if not sys.stdin.isatty():
            sys.stdin.read()                              # the hook payload; not needed
    except (OSError, ValueError):
        pass
    try:
        mode = os.environ.get("TOKENOMICS_STATUSBAR", "").strip().lower()
        cmd = _status_line("claude")
        if _is_ours(cmd) or _is_ours(_status_line("copilot")):
            if _out_of_date():
                _copy_files()
            return 0
        if cmd or mode == "off":
            return 0
        if mode == "auto":
            import contextlib
            import io
            with contextlib.redirect_stdout(io.StringIO()):
                install("claude")
            msg = "tokenomics: status bar installed. Restart Claude Code to see it."
        else:
            if HINT_FILE.exists():
                return 0
            CFG_DIR.mkdir(parents=True, exist_ok=True)
            HINT_FILE.write_text(datetime.now(timezone.utc).isoformat(), encoding="utf-8")
            msg = ("tokenomics: want the live cost and cache status bar? Run /tokenomics:statusbar "
                   "(or set TOKENOMICS_STATUSBAR=auto). This tip shows once.")
        sys.stdout.write(json.dumps({"systemMessage": msg}))
    except Exception:
        pass
    return 0


def main():
    args = sys.argv[1:]
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
    if "--install" in args or "--uninstall" in args:
        flag = "--install" if "--install" in args else "--uninstall"
        i = args.index(flag)
        target = args[i + 1] if i + 1 < len(args) and not args[i + 1].startswith("-") else "claude"
        install(target, remove=(flag == "--uninstall"))
        return
    if "--sync" in args:
        sys.exit(sync())
    if "--status" in args:
        sys.exit(status())
    if "--update-rate" in args:
        sys.exit(update_rate())
    if "--set-currency" in args:
        sys.exit(set_currency(_flag(args, "--set-currency")))
    if currency_code(_flag(args, "--currency")):          # this run only; beats env and config
        os.environ["TOKENOMICS_CURRENCY"] = currency_code(_flag(args, "--currency"))
    if "--demo" in args:
        return demo(args)
    if "--watch" in args:
        return watch(args)
    try:
        cfg = load_cfg()
        state = load_state()
        style = make_style(cfg, state, args)
        line = render(gather(read_payload(), cfg, state), style, cfg)
        save_state(state)
        sys.stdout.write(line)
    except Exception:
        sys.stdout.write("tokenomics")
    sys.exit(0)


if __name__ == "__main__":
    main()
