#!/usr/bin/env python3
"""Parse ffmpeg texinfo HTML into section-anchored units.

Each unit = one heading (chapter/section/subsection/...) plus the body text
directly under it (up to the next heading of any level), with the full heading
breadcrumb. Chunking strategies (micro/macro) run on top of these units later;
keeping parse separate from chunk keeps the pipeline reversible.

Output: JSONL, one unit per line:
  {anchor, level, title, breadcrumb:[...], path, body, n_chars, n_words}

stdlib only (no bs4). Usage:
  parse_docs.py <input.html> <output.jsonl> <corpus_id>
"""
import json
import re
import sys
from html.parser import HTMLParser

HEADING_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6"}
HEADING_LEVEL = {f"h{i}": i for i in range(1, 7)}
SKIP_CONTENT = {"script", "style"}
# texinfo prefixes the title with a section number like "3.1 " — strip it.
NUM_PREFIX = re.compile(r"^\s*[\d.]+\s+")


class DocParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.units = []
        self.last_id = None          # most recent id="..." (texinfo anchor span)
        self.in_heading = None       # current heading tag, e.g. "h3"
        self.heading_class = None
        self.heading_text = []
        self.heading_anchor = None
        self.skip_depth = 0          # inside script/style
        self.pre_depth = 0           # preserve whitespace inside <pre>
        # The unit currently accumulating body text.
        self.cur = None
        # Stack of (level, title) for breadcrumbs.
        self.stack = []

    def handle_starttag(self, tag, attrs):
        d = dict(attrs)
        if "id" in d:
            self.last_id = d["id"]
        if tag in SKIP_CONTENT:
            self.skip_depth += 1
            return
        if tag == "pre":
            self.pre_depth += 1
        if tag in HEADING_TAGS:
            self.in_heading = tag
            self.heading_class = d.get("class", "")
            self.heading_text = []
            # Anchor: id on the heading itself, else the span just before it.
            self.heading_anchor = d.get("id") or self.last_id

    def handle_endtag(self, tag):
        if tag in SKIP_CONTENT and self.skip_depth:
            self.skip_depth -= 1
            return
        if tag == "pre" and self.pre_depth:
            self.pre_depth -= 1
        if tag in HEADING_TAGS and self.in_heading == tag:
            title = NUM_PREFIX.sub("", "".join(self.heading_text)).strip()
            cls = self.heading_class or ""
            self.in_heading = None
            # Skip the table-of-contents heading entirely.
            if "contents-heading" in cls or title.lower() == "table of contents":
                self.cur = None
                return
            level = HEADING_LEVEL[tag]
            # Pop the breadcrumb stack to this level, then push.
            while self.stack and self.stack[-1][0] >= level:
                self.stack.pop()
            self.stack.append((level, title))
            breadcrumb = [t for (_, t) in self.stack]
            self.cur = {
                "anchor": self.heading_anchor,
                "level": level,
                "title": title,
                "breadcrumb": breadcrumb,
                "path": " > ".join(breadcrumb),
                "_body": [],
            }
            self.units.append(self.cur)
            self.last_id = None

    def handle_data(self, data):
        if self.skip_depth:
            return
        if self.in_heading:
            self.heading_text.append(data)
            return
        if self.cur is not None:
            self.cur["_body"].append(data if self.pre_depth else data)


def normalize(text):
    # Collapse runs of whitespace but keep single newlines from <pre> blocks.
    text = text.replace("\r", "")
    # collapse 3+ newlines to 2, spaces/tabs to single space per line
    lines = [re.sub(r"[ \t]+", " ", ln).rstrip() for ln in text.split("\n")]
    out = "\n".join(lines)
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out.strip()


def main():
    if len(sys.argv) != 4:
        print(__doc__)
        sys.exit(2)
    inp, outp, corpus_id = sys.argv[1], sys.argv[2], sys.argv[3]
    html = open(inp, encoding="utf-8").read()
    p = DocParser()
    p.feed(html)

    kept, dropped_empty = [], 0
    for u in p.units:
        body = normalize("".join(u.pop("_body")))
        if len(body) < 20:  # pure container heading, no real content
            dropped_empty += 1
            continue
        u["corpus"] = corpus_id
        u["body"] = body
        u["n_chars"] = len(body)
        u["n_words"] = len(body.split())
        kept.append(u)

    with open(outp, "w", encoding="utf-8") as f:
        for u in kept:
            f.write(json.dumps(u, ensure_ascii=False) + "\n")

    levels = {}
    for u in kept:
        levels[u["level"]] = levels.get(u["level"], 0) + 1
    total_words = sum(u["n_words"] for u in kept)
    print(f"[{corpus_id}] {inp}")
    print(f"  units kept: {len(kept)}  (dropped empty: {dropped_empty})")
    print(f"  by level:   {dict(sorted(levels.items()))}")
    print(f"  total words: {total_words:,}  (~{total_words*4//3:,} tokens est.)")
    print(f"  median unit words: {sorted(u['n_words'] for u in kept)[len(kept)//2]}")
    print(f"  -> {outp}")


if __name__ == "__main__":
    main()
