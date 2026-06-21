#!/usr/bin/env python3
"""Glue each filter's "Examples" subsection onto its PARENT section.

Why: ffmpeg reference pages describe knobs but rarely answer a user goal; the
runnable recipes live in the per-filter "Examples" subsections, which our parser
split into separate units. Merging them back means retrieving e.g. `paletteuse`
also yields its "encode a GIF" command — and adds goal vocabulary ("gif",
"output.gif") to the parent chunk, which should help BOTH retrieval and
answerability. Produces a new corpus id (e.g. all-glued) for A/B comparison.

Usage: glue_examples.py <in_parsed.jsonl> <out_parsed.jsonl> <new_corpus_id>
"""
import json
import sys


def is_examples(u):
    t = u["title"].strip().lower()
    return t == "examples" or t.startswith("example")


def main():
    inp, outp, cid = sys.argv[1], sys.argv[2], sys.argv[3]
    units = [json.loads(l) for l in open(inp, encoding="utf-8")]

    # index parents by their path so an Examples unit can find its owner
    by_path = {u["path"]: u for u in units}
    merged, dropped = 0, 0
    out = []
    for u in units:
        if is_examples(u):
            parent_path = " > ".join(u["breadcrumb"][:-1])
            parent = by_path.get(parent_path)
            if parent is not None and parent is not u:
                parent["body"] = f"{parent['body']}\n\nExamples:\n{u['body']}"
                parent["n_chars"] = len(parent["body"])
                parent["n_words"] = len(parent["body"].split())
                merged += 1
                continue  # drop the standalone Examples unit (now in parent)
            dropped += 1  # orphan Examples: keep as-is
        u["corpus"] = cid
        out.append(u)

    with open(outp, "w", encoding="utf-8") as f:
        for u in out:
            f.write(json.dumps(u, ensure_ascii=False) + "\n")
    print(f"[{cid}] {len(units)} units -> {len(out)} (merged {merged} Examples "
          f"into parents, {dropped} orphans kept) -> {outp}")


if __name__ == "__main__":
    main()
