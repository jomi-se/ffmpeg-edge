#!/usr/bin/env python3
"""Turn parsed section units into chunks under a chosen profile.

Profiles (paired with model tiers per PLAN.md):
  macro  - one chunk per section unit (split only if very long). For
           long-context / transformer encoders.
  micro  - 1-2 sentence chunks within each section. For static (POTION) encoders.

Every chunk's embedded text is PREFIXED with its heading breadcrumb
(`Chapter > Section > ...`) — cheap, large recall win, applied consistently.

Output JSONL chunk record:
  {id, corpus, profile, anchor, path, breadcrumb, n_words,
   unit_index, sub_index, text}      # text = breadcrumb + "\n\n" + body slice

stdlib only. Usage:
  chunk_docs.py <parsed.jsonl> <out.jsonl> <profile: macro|micro> [--max-words N]
"""
import json
import re
import sys

CHUNKER_VERSION = "0.1.0"
MACRO_MAX_WORDS = 320   # split macro chunks longer than this on sentence bounds
MICRO_SENT_GROUP = 2    # sentences per micro chunk

# Sentence boundary: ., !, ? then whitespace then an uppercase/quote/digit.
# Keep it simple — good enough to bucket text for an embedding benchmark.
SENT_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"'`(\-])")


def sentences(body):
    parts = []
    for line in body.split("\n"):
        line = line.strip()
        if not line:
            continue
        parts.extend(s.strip() for s in SENT_SPLIT.split(line) if s.strip())
    return parts


def group(seq, n):
    for i in range(0, len(seq), n):
        yield " ".join(seq[i:i + n])


def chunk_macro(body, max_words):
    if len(body.split()) <= max_words:
        return [body]
    # Too long: pack sentences greedily up to max_words.
    out, cur, cur_w = [], [], 0
    for s in sentences(body):
        w = len(s.split())
        if cur and cur_w + w > max_words:
            out.append(" ".join(cur))
            cur, cur_w = [], 0
        cur.append(s)
        cur_w += w
    if cur:
        out.append(" ".join(cur))
    return out or [body]


def chunk_micro(body):
    return list(group(sentences(body), MICRO_SENT_GROUP)) or [body]


def main():
    args = sys.argv[1:]
    if len(args) < 3:
        print(__doc__)
        sys.exit(2)
    inp, outp, profile = args[0], args[1], args[2]
    max_words = MACRO_MAX_WORDS
    if "--max-words" in args:
        max_words = int(args[args.index("--max-words") + 1])
    if profile not in ("macro", "micro"):
        print("profile must be macro or micro")
        sys.exit(2)

    units = [json.loads(l) for l in open(inp, encoding="utf-8")]
    chunks = []
    for ui, u in enumerate(units):
        body = u["body"]
        slices = chunk_macro(body, max_words) if profile == "macro" else chunk_micro(body)
        for si, sl in enumerate(slices):
            text = f"{u['path']}\n\n{sl}"
            chunks.append({
                "id": f"{u['corpus']}:{profile}:{u['anchor']}:{si}",
                "corpus": u["corpus"],
                "profile": profile,
                "anchor": u["anchor"],
                "path": u["path"],
                "breadcrumb": u["breadcrumb"],
                "unit_index": ui,
                "sub_index": si,
                "n_words": len(sl.split()),
                "text": text,
            })

    with open(outp, "w", encoding="utf-8") as f:
        for c in chunks:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")

    ws = sorted(c["n_words"] for c in chunks)
    corpus = units[0]["corpus"] if units else "?"
    print(f"[{corpus}/{profile}] {len(units)} units -> {len(chunks)} chunks")
    print(f"  words/chunk: min={ws[0]} median={ws[len(ws)//2]} max={ws[-1]} "
          f"total={sum(ws):,}")
    print(f"  chunker_version={CHUNKER_VERSION}  -> {outp}")


if __name__ == "__main__":
    main()
