#!/usr/bin/env python3
"""tokenomics / pennywise: a model router. "Penny wise, pound foolish": stop paying top-model
prices for trivial prompts, and stop sending hard ones to a model that will flounder.

Every prompt gets a complexity score from weighted signals (length, code, reasoning words,
technical terms, multi-step structure, simple-task phrases, scope) and lands in one of four tiers.
Each tier maps to a model, the way an auto-router (LiteLLM's complexity router and the like) does:

  SIMPLE    -> haiku     hello-world, rename, typo, commit message, convert JSON
  MEDIUM    -> sonnet    a routine feature or test, a short script
  COMPLEX   -> opus      refactors, debugging, multi-file or multi-step work
  REASONING -> opus      architecture, proofs, security, trade-offs, root causes

Two ways to route:

  Hook (default, nothing to set up). UserPromptSubmit in Claude Code. Hooks can't switch the
  session's model, so pennywise has the session hand the prompt to a subagent on the tier's model
  (the Agent tool's `model` parameter) and relay the answer. Routes down to save money, and up when
  a prompt is harder than the session's model.

  Proxy (a true per-request router). `pennywise.py serve` runs a local Anthropic-API proxy; point
  Claude Code at it with ANTHROPIC_BASE_URL=http://127.0.0.1:8787 and ANTHROPIC_MODEL=pennywise.
  Each new user turn is scored and the request's `model` is rewritten before it goes upstream.
  Routing is cache-aware: inside a tool loop the model never changes, and it only moves down to a
  cheaper model when the prompt cache is cold or the context is small (a switch means re-writing
  the context to the new model's cache). A failed request on a routed model is retried once on
  the fallback model.

Per-prompt overrides (both modes): start a prompt with
  keep-model:   stay on the session's model
  haiku: / sonnet: / opus: / fable:   force that model

Commands:
  pennywise.py                      hook (reads the hook JSON on stdin)
  pennywise.py explain "prompt"     show the score, the signals and the model it would pick
  pennywise.py serve [--port N]     run the routing proxy (foreground)
  pennywise.py env [--port N]       print the shell lines that point Claude Code at the proxy

Env:
  TOKENOMICS_PENNYWISE   route (default) | block (pause once, suggest /model) | warn | off
                         | proxy (the hook steps aside; the proxy does the routing)
  TOKENOMICS_PENNYWISE_UP        on (default) | off: also route prompts UP to a stronger model
  TOKENOMICS_ROUTER_TIERS        e.g. "SIMPLE=haiku,MEDIUM=sonnet,COMPLEX=opus,REASONING=fable"
  TOKENOMICS_ROUTER_PORT         proxy port (default 8787)
  TOKENOMICS_ROUTER_UPSTREAM     where the proxy forwards (default https://api.anthropic.com)
  TOKENOMICS_ROUTER_MODELS       request model names the proxy routes (default "pennywise,auto");
                                 "*" routes every main-model request
  TOKENOMICS_ROUTER_FALLBACK     model to retry on when a routed request fails (default: COMPLEX tier)
  TOKENOMICS_ROUTER_STICKY_TOKENS  below this context the proxy may move down while the cache is
                                 warm (default 20000)
  ~/.tokenomics/router.json      the same settings as a file: {"tiers": {...}, "thresholds": {...}}
  TOKENOMICS_DB                  SQLite path shared with spendlens (default ~/.tokenomics/spendlens.db)

Stdlib only. The hook always exits 0; a crash never blocks a prompt (errors go to <db>.err).
"""
import hashlib
import json
import os
import re
import sys
import threading
import time
import traceback
from pathlib import Path

DB_PATH = os.environ.get("TOKENOMICS_DB", str(Path.home() / ".tokenomics" / "spendlens.db"))
MODE = os.environ.get("TOKENOMICS_PENNYWISE", "route").strip().lower()
ROUTE_UP = os.environ.get("TOKENOMICS_PENNYWISE_UP", "on").strip().lower() != "off"
STATE_PATH = Path(DB_PATH).with_name("pennywise_state.json")
CONFIG_PATH = Path(os.environ.get("TOKENOMICS_HOME", str(Path.home() / ".tokenomics"))) / "router.json"
PRICES_PATH = Path(__file__).resolve().parent.parent / "data" / "model-prices.json"

FAMILY_TIER = {"haiku": 1, "sonnet": 2, "opus": 3, "fable": 4, "mythos": 4}
NAMES = {1: "Haiku", 2: "Sonnet", 3: "Opus", 4: "Fable"}
ALIASES = {1: "haiku", 2: "sonnet", 3: "opus", 4: "fable"}   # values the Agent tool's `model` takes
TIERS = ("SIMPLE", "MEDIUM", "COMPLEX", "REASONING")
DEFAULT_TIERS = {"SIMPLE": "haiku", "MEDIUM": "sonnet", "COMPLEX": "opus", "REASONING": "opus"}
# score >= threshold puts a prompt in that tier (scores run roughly -1 .. +2)
DEFAULT_THRESHOLDS = {"MEDIUM": 0.15, "COMPLEX": 0.5, "REASONING": 0.95}

BYPASS_RE = re.compile(r"^\s*keep-model:\s*", re.I)
# Follow-ups that lean on the conversation: a subagent (hook mode) couldn't see what they refer to.
FOLLOW_UP_RE = re.compile(r"^\s*(yes|yeah|yep|no|nope|ok(ay)?|sure|thanks|continue|go( ahead| on)?|do it|try again|"
                          r"same|again|that|this|it|now|also|and|but|then)\b|\b(above|previous|earlier|you just|"
                          r"last (one|step|answer)|that (one|file|error|change))\b", re.I)
TASK_SIGNALS = {"simple-task", "small-words", "technical", "complex-work", "reasoning", "multi-step", "code"}
FORCE_RE = re.compile(r"^\s*(haiku|sonnet|opus|fable):\s*", re.I)


def _rx(*ps):
    return [re.compile(p, re.I) for p in ps]


# (name, weight, patterns): each pattern that matches adds its weight once, capped per signal.
SIGNALS = [
    ("simple-task", -0.35, _rx(
        r"\bhello[ ,-]*world\b", r"\bfizz ?buzz\b", r"\bboilerplate\b|\bskeleton\b|\bstarter\b",
        r"\b(fix|correct) (a |the )?(typo|spelling|grammar)\b",
        r"\brename\b.{0,30}\b(variable|function|file|method|class)\b",
        r"\b(add|write|update) (a |some )?(comments?|docstrings?|jsdoc|readme)\b",
        r"\bcommit message\b", r"\bgitignore\b|\beditorconfig\b",
        r"\b(format|lint|prettify|indent|sort)\b.{0,30}\b(file|code|json|yaml|imports?)\b",
        r"\bconvert\b.{0,30}\b(json|yaml|csv|xml|toml)\b", r"\bregex\b.{0,30}\b(for|to match)\b",
        r"\b(what|which) (does|is)\b.{0,40}\b(this|command|flag|syntax|option)\b",
        r"\bsummari[sz]e\b|\btl;?dr\b", r"\blist (the |all )?(files|commands|branches)\b",
        r"\bgit (status|log|diff)\b", r"\bbump\b.{0,20}\bversion\b")),
    ("small-words", -0.2, _rx(r"\bone[- ]liner\b", r"\b(simple|basic|quick(ly)?|tiny|small|trivial)\b")),
    ("build-verb", 0.2, _rx(r"\b(create|write|add|make|build|generate|implement)\b")),
    ("technical", 0.15, _rx(
        r"\b(api|endpoint|schema|database|sql|migration|auth\w*|oauth|jwt|cache|queue|kafka|redis)\b",
        r"\b(kubernetes|k8s|terraform|docker|ci/cd|pipeline|webhook|grpc|graphql)\b",
        r"\b(async|thread\w*|mutex|lock|transaction|index(es|ing)?|memory|latency)\b",
        r"\b(test suite|integration tests?|e2e|benchmark)\b")),
    ("complex-work", 0.4, _rx(
        r"\brefactor\w*\b|\brewrite\b|\bmigrat\w+\b", r"\bdebug\w*\b|\bfix\b.{0,30}\b(bug|crash|leak|flaky)\b",
        r"\bperformance\b|\boptimi[sz]\w+|\bprofil(e|ing)\b",
        r"\bacross (the |all )?(repo|codebase|services?|files|modules)\b|\bmulti[- ]?(file|service|module)\b",
        r"\bfull(y)?\b.{0,20}\b(app|application|platform|system|feature)\b", r"\bend[- ]to[- ]end\b",
        r"\bplan\b.{0,20}\b(implementation|rollout|project|migration)\b")),
    ("reasoning", 0.55, _rx(
        r"\barchitect\w*|\bsystem design\b|\bdesign (doc|review)\b",
        r"\bsecurity\b|\bvulnerab\w+|\bthreat model\b|\bexploit\b",
        r"\brace condition\b|\bconcurren\w+|\bdeadlock\b|\bdistributed\b|\bconsisten(cy|t hashing)\b",
        r"\broot cause\b|\bwhy (is|does|did|would)\b.{0,60}\b(fail|crash|hang|leak|slow)\w*",
        r"\btrade-?offs?\b|\bcompare\b.{0,40}\b(approaches|options|designs)\b|\bpros and cons\b",
        r"\bprove\b|\bproof\b|\balgorithm\w*\b|\bcomplexity\b.{0,10}\b(time|space|big-?o)\b",
        r"\bstep[- ]by[- ]step\b|\bthink (it )?through\b|\breason about\b",
        r"\bresearch\b|\banalys[ei]s\b|\binvestigat\w+")),
    ("multi-step", 0.3, _rx(
        r"\b(first|1\.|step 1)\b[\s\S]{0,300}\b(then|next|2\.|step 2|after that|finally)\b",
        r"(^|\n)\s*([-*]|\d+[.)])\s+\S[\s\S]*\n\s*([-*]|\d+[.)])\s+\S[\s\S]*\n\s*([-*]|\d+[.)])\s+\S")),
]
SIGNAL_CAP = {"simple-task": -0.6, "small-words": -0.3, "build-verb": 0.2, "technical": 0.45,
              "complex-work": 0.8, "reasoning": 1.1, "multi-step": 0.3}


# ------------------------------------------------------------------ config ------------------

def load_config():
    cfg = {"tiers": dict(DEFAULT_TIERS), "thresholds": dict(DEFAULT_THRESHOLDS)}
    try:
        f = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        cfg["tiers"].update({k.upper(): v for k, v in (f.get("tiers") or {}).items() if k.upper() in TIERS})
        cfg["thresholds"].update({k.upper(): float(v) for k, v in (f.get("thresholds") or {}).items()})
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    for part in (os.environ.get("TOKENOMICS_ROUTER_TIERS") or "").split(","):
        k, _, v = part.partition("=")
        if k.strip().upper() in TIERS and v.strip():
            cfg["tiers"][k.strip().upper()] = v.strip()
    return cfg


def tier_of(model):
    """Model name or alias -> 1 (Haiku) .. 4 (Fable), or None for a model we don't know."""
    m = (model or "").lower()
    for name, t in FAMILY_TIER.items():
        if name in m:
            return t
    return None


_PRICES = None


def resolve_model(name):
    """'haiku' -> the newest listed Haiku model id from data/model-prices.json; full ids pass through."""
    global _PRICES
    if not name or name.lower() not in ALIASES.values():
        return name
    if _PRICES is None:
        try:
            _PRICES = json.loads(PRICES_PATH.read_text(encoding="utf-8")).get("models") or {}
        except (OSError, ValueError):
            _PRICES = {}

    def ver(item):
        try:
            return tuple(int(x) for x in str(item[1].get("version", "0")).split("."))
        except ValueError:
            return (0,)
    fam = [(k, v) for k, v in _PRICES.items() if v.get("family") == name.lower() and v.get("listed", True)]
    return max(fam, key=ver)[0] if fam else name


# ------------------------------------------------------------------ scoring ----------------

def score(prompt, context_tokens=0, cfg=None):
    """-> dict(tier, score, signals, model). Pure function of the prompt (and context size)."""
    cfg = cfg or load_config()
    words = len(prompt.split())
    total, hits = 0.0, []
    # length: very short prompts lean simple, long ones lean complex
    if words <= 12:
        total -= 0.1
        hits.append(("short", -0.1))
    elif words > 250:
        total += 0.45
        hits.append(("long", 0.45))
    elif words > 80:
        total += 0.25
        hits.append(("longish", 0.25))
    if "```" in prompt or re.search(r"(^|\n)( {4}|\t)\S.*\n( {4}|\t)\S", prompt):
        total += 0.3
        hits.append(("code", 0.3))
    for name, weight, pats in SIGNALS:
        n = sum(1 for p in pats if p.search(prompt))
        if n:
            w = weight * n
            cap = SIGNAL_CAP[name]
            w = max(w, cap) if cap < 0 else min(w, cap)
            total += w
            hits.append((name, round(w, 2)))
    if prompt.count("?") >= 3:
        total += 0.2
        hits.append(("many-questions", 0.2))
    th = cfg["thresholds"]
    tier = "SIMPLE"
    for t in ("MEDIUM", "COMPLEX", "REASONING"):
        if total >= th[t]:
            tier = t
    if context_tokens > 150_000 and tier == "SIMPLE":   # big contexts need more than the smallest model
        tier = "MEDIUM"
        hits.append(("big-context", 0))
    return {"tier": tier, "score": round(total, 2), "signals": hits, "model": cfg["tiers"][tier]}


def rate(prompt):
    """Back-compat shim: (tier 1-4, reason) for the model the prompt needs."""
    r = score(prompt)
    return tier_of(r["model"]), f"{r['tier'].lower()} prompt (score {r['score']})"


def forced(prompt):
    m = FORCE_RE.match(prompt)
    return m.group(1).lower() if m else None


# ------------------------------------------------------------------ logging -----------------

_db_lock = threading.Lock()


def log(sid, model, suggested, reason, action):
    try:
        import sqlite3
        with _db_lock:
            Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
            db = sqlite3.connect(DB_PATH, timeout=5)
            db.execute("""CREATE TABLE IF NOT EXISTS pennywise_events(
              id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, ts TEXT,
              model TEXT, suggested TEXT, reason TEXT, action TEXT)""")
            db.execute("INSERT INTO pennywise_events(session_id,ts,model,suggested,reason,action) "
                       "VALUES(?,?,?,?,?,?)",
                       (sid, time.strftime("%Y-%m-%dT%H:%M:%S%z"), model, suggested, reason, action))
            db.commit()
            db.close()
    except Exception:
        pass


def log_err(tag):
    try:
        with open(DB_PATH + ".err", "a") as f:
            f.write(time.strftime("%Y-%m-%dT%H:%M:%S%z") + " pennywise " + tag + "\n" + traceback.format_exc() + "\n")
    except Exception:
        pass


# ------------------------------------------------------------------ hook mode ---------------

def _last_model(path):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 400_000))
            lines = f.read().decode("utf-8", "replace").splitlines()
        for line in reversed(lines):
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            m = (ev.get("message") or {}).get("model")
            if ev.get("type") == "assistant" and m and not m.startswith("<") and not ev.get("isSidechain"):
                return m
    except Exception:
        pass
    return None


def current_model(d):
    m = d.get("model")
    if isinstance(m, dict):
        m = m.get("id") or m.get("display_name")
    if tier_of(m):
        return m
    if d.get("transcript_path"):
        m = _last_model(d["transcript_path"])
        if tier_of(m):
            return m
    if tier_of(os.environ.get("ANTHROPIC_MODEL")):
        return os.environ["ANTHROPIC_MODEL"]
    for p in (Path(d.get("cwd") or ".") / ".claude" / "settings.local.json",
              Path(d.get("cwd") or ".") / ".claude" / "settings.json",
              Path.home() / ".claude" / "settings.json"):
        try:
            m = json.loads(p.read_text()).get("model")
            if tier_of(m):
                return m
        except Exception:
            continue
    return None


def proxy_active():
    port = os.environ.get("TOKENOMICS_ROUTER_PORT", "8787")
    base = os.environ.get("ANTHROPIC_BASE_URL", "")
    return MODE == "proxy" or bool(re.match(rf"https?://(127\.0\.0\.1|localhost):{port}\b", base))


def route_instruction(tier, why, up):
    alias = ALIASES[tier]
    reason = ("it needs more than this session's model" if up else "a cheaper model can do it")
    return (f"[tokenomics pennywise model router] This prompt was scored {why}, so it is routed to "
            f"{NAMES[tier]} ({reason}). Do not do the task yourself. Make one call to the Agent tool "
            f"(the subagent tool) with model: \"{alias}\", passing the user's request word for word as its "
            f"prompt, plus only the facts from this conversation it needs (file paths, names, earlier "
            f"decisions), since the subagent cannot see this conversation. Then give the user its result "
            f"briefly, without redoing or re-checking its work. If you have no Agent tool, or the request "
            f"clearly depends on this conversation in a way you cannot hand over in a few lines, do it "
            f"yourself as usual.")


def route(sid, model, cur, tier, why):
    up = tier > cur
    log(sid, model, NAMES[tier], why, "routed-up" if up else "routed")
    verb = "up" if up else "down"
    return {
        "systemMessage": (f"pennywise: routing {verb} to {NAMES[tier]} ({why}) instead of {NAMES[cur]}. "
                          f"Start a prompt with 'keep-model:' to keep it on {NAMES[cur]}."),
        "hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
                               "additionalContext": route_instruction(tier, why, up)},
    }


def _state():
    try:
        return json.loads(STATE_PATH.read_text())
    except Exception:
        return {}


def handle(d):
    if MODE in ("off", "proxy") or proxy_active():
        return None
    prompt = (d.get("prompt") or d.get("userPrompt") or "").strip()
    if not prompt or prompt.startswith("/") or BYPASS_RE.match(prompt):
        return None
    model = current_model(d)
    cur = tier_of(model)
    if cur is None:
        return None
    sid = str(d.get("session_id") or d.get("sessionId") or "unknown")
    f = forced(prompt)
    if f:
        tier, why = FAMILY_TIER[f], f"forced with '{f}:'"
    else:
        r = score(prompt)
        tier, why = tier_of(r["model"]), f"{r['tier']}, score {r['score']}"
        # a subagent starts blank: only hand over prompts that stand on their own and clearly read as a task
        if FOLLOW_UP_RE.search(prompt) or not any(n in TASK_SIGNALS for n, _ in r["signals"]):
            return None
    if tier is None or tier == cur or (tier > cur and not ROUTE_UP and not f):
        return None
    if MODE not in ("block", "warn") or f or tier > cur:   # "route", forced, and upgrades always route
        return route(sid, model, cur, tier, why)

    digest = hashlib.sha1(prompt.encode()).hexdigest()
    state = _state()
    if state.get(sid) == digest:  # same prompt sent again = "I meant it"
        log(sid, model, NAMES[tier], why, "overridden")
        return None
    cheaper = NAMES[tier]
    msg = (f"pennywise: this prompt scored {why}, which {cheaper} can handle, but this session is on "
           f"{model} ({NAMES[cur]}), a pricier tier. Switch with /model {cheaper.lower()} and resend, "
           f"or send the same prompt again (or start it with 'keep-model:') to run it on {NAMES[cur]} anyway.")
    if MODE == "warn":
        log(sid, model, cheaper, why, "warned")
        return {"systemMessage": msg}
    state.pop(sid, None)
    state[sid] = digest
    try:
        STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        STATE_PATH.write_text(json.dumps(dict(list(state.items())[-200:])))
    except Exception:
        pass
    log(sid, model, cheaper, why, "blocked")
    return {"decision": "block", "reason": msg}


# ------------------------------------------------------------------ proxy mode --------------

def _text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
    return ""


def _clean(text):
    return " ".join(re.sub(r"<(system-reminder|command-[a-z-]+|local-command-[a-z-]+)>.*?</\1>", " ",
                           text, flags=re.S).split())


def conversation_key(body):
    """Stable id for a conversation: system prompt head + first user message."""
    sysp = body.get("system")
    sysp = sysp if isinstance(sysp, str) else _text(sysp)
    msgs = body.get("messages") or []
    first = _text(msgs[0].get("content")) if msgs and isinstance(msgs[0], dict) else ""
    return hashlib.sha1((sysp[:2000] + "\x00" + first[:2000]).encode("utf-8", "replace")).hexdigest()[:16]


def new_user_turn(body):
    """The last message is the user typing (not a tool result coming back mid-loop)."""
    msgs = body.get("messages") or []
    if not msgs or not isinstance(msgs[-1], dict) or msgs[-1].get("role") != "user":
        return None
    c = msgs[-1].get("content")
    if isinstance(c, list) and any(isinstance(p, dict) and p.get("type") == "tool_result" for p in c):
        return None
    t = _clean(_text(c))
    return t or None


def uses_1h_cache(body):
    return '"ttl": "1h"' in json.dumps(body)[:200_000] or '"ttl":"1h"' in json.dumps(body)[:200_000]


class Router:
    """Per-conversation, cache-aware routing decisions for the proxy."""

    def __init__(self, cfg=None):
        self.cfg = cfg or load_config()
        self.convs = {}     # key -> {"model", "ts", "ttl"}
        self.lock = threading.Lock()
        names = os.environ.get("TOKENOMICS_ROUTER_MODELS", "pennywise,auto")
        self.match = {x.strip().lower() for x in names.split(",") if x.strip()}
        self.sticky_tokens = int(os.environ.get("TOKENOMICS_ROUTER_STICKY_TOKENS") or 20000)
        self.fallback = resolve_model(os.environ.get("TOKENOMICS_ROUTER_FALLBACK") or self.cfg["tiers"]["COMPLEX"])

    def routes(self, model):
        m = (model or "").lower()
        if m in self.match:
            return True
        # "*" routes every request on a main model; Claude Code's small background calls stay put
        return "*" in self.match and tier_of(m) is not None and tier_of(m) > 1

    def decide(self, body, raw_len, now=None):
        """-> (model_to_use, reason) for a /v1/messages body whose model we route."""
        now = now or time.time()
        requested = body.get("model") or ""
        key = conversation_key(body)
        ctx = raw_len // 4
        ttl = 3600 if uses_1h_cache(body) else 300
        with self.lock:
            prev = self.convs.get(key)
            warm = bool(prev) and now - prev["ts"] < prev["ttl"]
            turn = new_user_turn(body)
            if prev and not turn:
                choice, reason = prev["model"], "same turn (tool loop)"
            else:
                text = turn or ""
                f = forced(text)
                if f:
                    choice, reason = resolve_model(f), f"forced {f}:"
                elif BYPASS_RE.match(text) and prev:
                    choice, reason = prev["model"], "keep-model:"
                else:
                    r = score(text, ctx, self.cfg)
                    choice, reason = resolve_model(r["model"]), f"{r['tier']} score {r['score']}"
                    if prev and warm and tier_of(choice) and tier_of(prev["model"]) \
                            and tier_of(choice) < tier_of(prev["model"]) and ctx >= self.sticky_tokens:
                        choice, reason = prev["model"], f"{reason}; kept {prev['model']} while its cache is warm"
                if choice.lower() in self.match or tier_of(choice) is None and not choice.startswith("claude"):
                    choice = self.fallback
            self.convs[key] = {"model": choice, "ts": now, "ttl": ttl}
            if len(self.convs) > 500:
                for k in sorted(self.convs, key=lambda k: self.convs[k]["ts"])[:100]:
                    self.convs.pop(k, None)
        return choice, reason, key, requested


HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers",
       "transfer-encoding", "upgrade", "host", "content-length", "accept-encoding"}


def serve(port, upstream=None, router=None, ready=None):
    import http.server
    import urllib.error
    import urllib.request

    upstream = (upstream or os.environ.get("TOKENOMICS_ROUTER_UPSTREAM") or "https://api.anthropic.com").rstrip("/")
    router = router or Router()

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"     # close-delimited bodies: streams pass straight through

        def log_message(self, *a):
            pass

        def _forward(self, method, body):
            headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
            headers["Accept-Encoding"] = "identity"
            req = urllib.request.Request(upstream + self.path, data=body, method=method, headers=headers)
            try:
                return urllib.request.urlopen(req, timeout=600)
            except urllib.error.HTTPError as e:
                return e

        def _relay(self, resp):
            self.send_response(resp.status if hasattr(resp, "status") else resp.code)
            for k, v in resp.headers.items():
                if k.lower() not in HOP:
                    self.send_header(k, v)
            self.send_header("Connection", "close")
            self.end_headers()
            while True:
                chunk = resp.read1(65536) if hasattr(resp, "read1") else resp.read(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()

        def _handle(self, method):
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else None
            routed = None
            path = self.path.split("?")[0]
            if raw and method == "POST" and path in ("/v1/messages", "/v1/messages/count_tokens"):
                try:
                    body = json.loads(raw)
                    if router.routes(body.get("model")):
                        if path.endswith("count_tokens"):
                            model, reason, key = router.fallback, "count_tokens", conversation_key(body)
                            requested = body.get("model")
                        else:
                            model, reason, key, requested = router.decide(body, len(raw))
                        body["model"] = model
                        raw = json.dumps(body).encode("utf-8")
                        routed = (requested, model, reason, key)
                except (ValueError, AttributeError):
                    pass
            try:
                resp = self._forward(method, raw)
                code = getattr(resp, "status", None) or getattr(resp, "code", 0)
                if routed and code in (400, 404, 429, 500, 502, 503, 529) and routed[1] != router.fallback \
                        and not path.endswith("count_tokens"):
                    body = json.loads(raw)
                    body["model"] = router.fallback
                    raw = json.dumps(body).encode("utf-8")
                    log(routed[3], routed[0], router.fallback, f"{routed[1]} failed ({code})", "proxy-fallback")
                    resp = self._forward(method, raw)
                elif routed and not path.endswith("count_tokens") and routed[2] != "same turn (tool loop)":
                    log(routed[3], routed[0], routed[1], routed[2], "proxy-routed")
                self._relay(resp)
            except Exception as e:
                log_err("proxy")
                try:
                    msg = json.dumps({"type": "error", "error": {"type": "api_error",
                                                                 "message": f"pennywise proxy: {e}"}}).encode()
                    self.send_response(502)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(msg)
                except Exception:
                    pass

        def do_POST(self):
            self._handle("POST")

        def do_GET(self):
            if self.path == "/pennywise/health":
                b = json.dumps({"ok": True, "upstream": upstream, "tiers": router.cfg["tiers"]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b)
                return
            self._handle("GET")

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    srv.daemon_threads = True
    if ready:
        ready(srv)
    return srv


# ------------------------------------------------------------------ CLI ---------------------

def explain(prompt):
    r = score(prompt)
    f = forced(prompt)
    lines = [f"tier:    {r['tier']}  (score {r['score']})",
             f"model:   {resolve_model(f or r['model'])}" + (f"  (forced with '{f}:')" if f else ""),
             "signals: " + (", ".join(f"{n} {w:+g}" for n, w in r["signals"]) or "none")]
    th = load_config()["thresholds"]
    lines.append("tiers:   " + "  ".join(f"{t}>={th[t]}" for t in ("MEDIUM", "COMPLEX", "REASONING")))
    return "\n".join(lines)


def _port(args):
    if "--port" in args:
        return int(args[args.index("--port") + 1])
    return int(os.environ.get("TOKENOMICS_ROUTER_PORT") or 8787)


def main():
    args = sys.argv[1:]
    cmd = args[0] if args else ""
    if cmd == "explain":
        text = " ".join(args[1:]) if len(args) > 1 else sys.stdin.read()
        print(explain(text))
        return
    if cmd == "env":
        p = _port(args)
        print(f"export ANTHROPIC_BASE_URL=http://127.0.0.1:{p}\nexport ANTHROPIC_MODEL=pennywise")
        return
    if cmd == "serve":
        p = _port(args)
        srv = serve(p)
        tiers = load_config()["tiers"]
        print(f"pennywise router on http://127.0.0.1:{p}  ->  "
              f"{os.environ.get('TOKENOMICS_ROUTER_UPSTREAM') or 'https://api.anthropic.com'}")
        print("tiers: " + ", ".join(f"{t}={resolve_model(tiers[t])}" for t in TIERS))
        print(f"use it:  ANTHROPIC_BASE_URL=http://127.0.0.1:{p} ANTHROPIC_MODEL=pennywise claude")
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            pass
        return
    try:                                          # hook mode
        raw = sys.stdin.read()
        out = handle(json.loads(raw) if raw.strip() else {})
        if out:
            print(json.dumps(out))
    except Exception:
        log_err("hook")
    sys.exit(0)


if __name__ == "__main__":
    main()
