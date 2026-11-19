#!/usr/bin/env python3
"""critical-friend: analyse a Claude Code session's prompts and prompt-cache usage.

Usage:
  critical_friend.py                    # newest transcript for the current directory
  critical_friend.py --session <id>     # a specific session
  critical_friend.py --transcript <p>   # a specific .jsonl
  critical_friend.py --json             # machine-readable output
Stdlib only. Read-only: never modifies the transcript or the database.
"""
import argparse, json, os, re, sys
from collections import Counter
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
try:
    from tokenomics.engine.classifier import score as opex_capex_score  # the shared opex/capex scorer
except Exception:                      # skill installed without the package: skip the topic check
    opex_capex_score = None

CACHE_TTL_S = 300          # default 5-minute prompt-cache TTL
BIG_CTX = 100_000          # tokens: context size worth a /compact or /clear
REBUILD_MIN = 10_000       # cache_creation tokens below this are not "rebuilds"
CORRECTION_RE = re.compile(r"^\s*(no\b|nope|actually|wait\b|that'?s (not|wrong)|still\b|you (didn'?t|missed|forgot)|"
                           r"why did you|undo|revert|not what|try again|that didn'?t)", re.I)
NOT_PROMPT = ("<command-", "<system-reminder", "<local-command", "<user-prompt-submit-hook", "Caveat:")


def find_transcript(a):
    if a.transcript:
        return Path(a.transcript)
    base = Path.home() / ".claude" / "projects"
    if a.session:
        hits = list(base.glob(f"*/{a.session}.jsonl"))
        return hits[0] if hits else None
    munged = re.sub(r"[^A-Za-z0-9]", "-", os.getcwd())
    files = list((base / munged).glob("*.jsonl")) or list(base.glob("*/*.jsonl"))
    return max(files, key=lambda p: p.stat().st_mtime) if files else None


def ts(v):
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
    return ""


def size_of(content):
    if isinstance(content, str):
        return len(content)
    if isinstance(content, list):
        return sum(len(p.get("text", "")) if isinstance(p, dict) else len(str(p)) for p in content)
    return len(str(content))


def analyse(path):
    turns, prompts, tool_names, results, reads = {}, [], {}, [], Counter()
    for line in open(path, encoding="utf-8", errors="replace"):
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        kind, msg, t = ev.get("type"), ev.get("message") or {}, ts(ev.get("timestamp"))
        if kind == "assistant":
            u = msg.get("usage")
            if isinstance(u, dict):
                turns[msg.get("id") or ev.get("uuid") or len(turns)] = (t, u, msg.get("model"))
            for part in msg.get("content") or []:
                if isinstance(part, dict) and part.get("type") == "tool_use":
                    tool_names[part.get("id")] = part.get("name")
                    inp = part.get("input") or {}
                    if part.get("name") == "Read" and inp.get("file_path"):
                        reads[inp["file_path"]] += 1
        elif kind == "user" and not ev.get("isMeta"):
            content = msg.get("content")
            if isinstance(content, list):
                for part in content:
                    if isinstance(part, dict) and part.get("type") == "tool_result":
                        results.append((tool_names.get(part.get("tool_use_id"), "?"), size_of(part.get("content"))))
            txt = text_of(content).strip()
            if txt and not txt.startswith(NOT_PROMPT):
                prompts.append(txt)

    rows = []
    for t, u, model in turns.values():
        i, o = int(u.get("input_tokens") or 0), int(u.get("output_tokens") or 0)
        cc, cr = int(u.get("cache_creation_input_tokens") or 0), int(u.get("cache_read_input_tokens") or 0)
        rows.append({"t": t, "in": i, "out": o, "cc": cc, "cr": cr, "ctx": i + cc + cr, "model": model})
    rows.sort(key=lambda r: r["t"] or 0)

    tot = {k: sum(r[k] for r in rows) for k in ("in", "out", "cc", "cr")}
    denom = tot["in"] + tot["cc"] + tot["cr"]
    hit = tot["cr"] / denom if denom else None

    rebuilds, prev = [], None
    for r in rows:
        if prev and r["cc"] >= REBUILD_MIN and r["cc"] > 0.5 * r["ctx"]:
            gap = (r["t"] - prev["t"]) if r["t"] and prev["t"] else None
            if gap is not None and gap > CACHE_TTL_S:
                why = f"idle {int(gap // 60)} min (cache expired)"
            elif prev["model"] and r["model"] and prev["model"] != r["model"]:
                why = f"model switched {prev['model']} -> {r['model']}"
            else:
                why = "prefix changed (system/tool/CLAUDE.md/MCP change or earlier-context edit)"
            rebuilds.append({"tokens": r["cc"], "reason": why})
        prev = r

    words = lambda s: len(s.split())
    vague = [p[:60] for p in prompts if words(p) <= 4 and not re.search(r"[/\\.]\w|`", p)]
    corrections = [p[:60] for p in prompts if CORRECTION_RE.match(p)]
    long_ = [(len(p) // 4, p[:60]) for p in prompts if len(p) > 4000]
    dup = [p[:60] for p, n in Counter(re.sub(r"\s+", " ", p.lower()) for p in prompts).items() if n > 1]
    side = Counter()
    if opex_capex_score:
        for p in prompts:
            o, c = opex_capex_score(p)
            if o > c:
                side["opex"] += 1
            elif c > o:
                side["capex"] += 1
    big = sorted(results, key=lambda x: -x[1])[:5]
    flags = []
    if hit is not None and hit < 0.6 and len(rows) >= 5:
        flags.append("low_cache_hit_ratio")
    if rebuilds:
        flags.append("cache_rebuilds")
    if rows and max(r["ctx"] for r in rows) > BIG_CTX:
        flags.append("large_context")
    if prompts and len(vague) / len(prompts) >= 0.25:
        flags.append("vague_prompts")
    if prompts and len(corrections) / len(prompts) >= 0.2:
        flags.append("many_corrections")
    if long_:
        flags.append("large_pasted_prompts")
    if dup:
        flags.append("repeated_prompts")
    if side["opex"] >= 2 and side["capex"] >= 2:
        flags.append("mixed_topics_in_one_session")
    if any(n >= 3 for n in reads.values()):
        flags.append("repeated_file_reads")
    if big and big[0][1] > 40_000:
        flags.append("huge_tool_results")
    if len({r["model"] for r in rows if r["model"]}) > 1:
        flags.append("model_switched")
    return {
        "transcript": str(path), "turns": len(rows), "prompts": len(prompts),
        "tokens": {"input": tot["in"], "output": tot["out"], "cache_creation": tot["cc"], "cache_read": tot["cr"]},
        "cache_hit_ratio": None if hit is None else round(hit, 3),
        "peak_context_tokens": max((r["ctx"] for r in rows), default=0),
        "cache_rebuilds": rebuilds, "wasted_rebuild_tokens": sum(r["tokens"] for r in rebuilds),
        "prompt_stats": {
            "avg_words": round(sum(words(p) for p in prompts) / len(prompts), 1) if prompts else 0,
            "vague": vague[:5], "corrections": corrections[:5], "large_pastes_tokens": long_[:5],
            "repeated": dup[:5], "leaning": dict(side)},
        "repeated_reads": {k: v for k, v in reads.items() if v >= 3},
        "biggest_tool_results": [{"tool": n, "approx_tokens": c // 4} for n, c in big],
        "flags": flags,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--transcript"); ap.add_argument("--session"); ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    p = find_transcript(a)
    if not p or not p.is_file():
        print("No transcript found. Pass --transcript <file.jsonl> or --session <id>.", file=sys.stderr)
        sys.exit(1)
    r = analyse(p)
    if a.json:
        print(json.dumps(r, indent=2)); return
    t = r["tokens"]
    print(f"Transcript: {r['transcript']}\nTurns: {r['turns']}  Prompts: {r['prompts']}  Peak context: {r['peak_context_tokens']:,} tokens")
    print(f"Tokens  in={t['input']:,} out={t['output']:,} cache_write={t['cache_creation']:,} cache_read={t['cache_read']:,}")
    print(f"Cache hit ratio: {r['cache_hit_ratio']}")
    for b in r["cache_rebuilds"]:
        print(f"  rebuild {b['tokens']:,} tok: {b['reason']}")
    print("Prompt stats:", json.dumps(r["prompt_stats"]))
    print("Repeated reads:", r["repeated_reads"]); print("Biggest tool results:", r["biggest_tool_results"])
    print("FLAGS:", ", ".join(r["flags"]) or "none")


if __name__ == "__main__":
    main()
