#!/usr/bin/env python3
"""Render results/report.json (+ phase0_floor.json) into a mobile-first
self-contained results/report.html. No JS, no external assets — open on a phone.

Usage: python3 scripts/make_report.py
"""
import json
import os
import html

HERE = os.path.dirname(os.path.abspath(__file__))
BENCH = os.path.dirname(HERE)
R = os.path.join(BENCH, "results")
report = json.load(open(os.path.join(R, "report.json")))
floor = {}
fp = os.path.join(R, "phase0_floor.json")
if os.path.exists(fp):
    floor = json.load(open(fp))
meta = report["meta"]
cfgs = report["configs"]


def mb(b):
    return f"{b/1e6:.0f} MB" if b else "—"


def pct(x):
    return f"{round(x*100)}%"


def bar(p, lo=None, hi=None, color="#13a89e"):
    w = round(p * 100)
    ci = ""
    if lo is not None and hi is not None and (hi - lo) > 0.001:
        ci = (f'<span class="ci" style="left:{round(lo*100)}%;'
              f'right:{round((1-hi)*100)}%"></span>')
    return (f'<div class="barwrap"><div class="bar" style="width:{w}%;'
            f'background:{color}"></div>{ci}'
            f'<span class="barlbl">{pct(p)}</span></div>')


# ---- flatten model rows: (corpus,model,dtype,method) -> metrics + speed/size ----
def method_of(rowcfg):
    return rowcfg.split(" / ", 1)[1]


entries = []
bm25_by_corpus = {}
for key, c in cfgs.items():
    for row in c["rows"]:
        mth = method_of(row["config"])
        rec = {
            "corpus": c["corpus"], "model": c["model"], "dtype": c["dtype"],
            "method": mth, "r5": row["rt"], "r20": row["rg"], "nd": row["nd"],
            "cov": row["coverage"], "nChunks": row["nChunks"],
            "speed": c["speed"], "payload": c["payload"], "na": row.get("naNote", ""),
        }
        if mth.startswith("bm25"):
            bm25_by_corpus.setdefault(c["corpus"], rec)
        else:
            entries.append(rec)


def find(corpus, model, dtype, hybrid):
    suff = "+bm25" if hybrid else ""
    for e in entries:
        if e["corpus"] == corpus and e["model"] == model and e["dtype"] == dtype \
           and e["method"].startswith(f"{model}{suff}/"):
            return e
    return None


# ---------- HTML ----------
CSS = """
:root{--bg:#0f1720;--card:#162230;--ink:#e7eef5;--mut:#90a4b8;--line:#243444;
--teal:#13a89e;--amber:#e8a33d;--red:#e2566b;--grn:#4cc38a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
-webkit-text-size-adjust:100%}
.wrap{max-width:760px;margin:0 auto;padding:18px 14px 60px}
h1{font-size:24px;margin:.2em 0 .1em;letter-spacing:-.5px}
h2{font-size:19px;margin:1.6em 0 .5em;padding-top:.4em;border-top:1px solid var(--line)}
h3{font-size:15px;margin:1.2em 0 .4em;color:var(--mut);text-transform:uppercase;letter-spacing:.5px;font-weight:600}
p,li{color:var(--ink)} .mut{color:var(--mut)}
.sub{color:var(--mut);font-size:14px;margin-top:0}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin:12px 0}
.verdict{border-left:4px solid var(--teal)}
.kpi{font-size:30px;font-weight:700;color:var(--teal);letter-spacing:-1px}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:0 -16px;padding:0 16px}
table{border-collapse:collapse;width:100%;font-size:14px;min-width:520px}
th,td{padding:8px 9px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--mut);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.4px}
td.name{white-space:normal;font-weight:600}
tr.win td{background:rgba(19,168,158,.10)}
.barwrap{position:relative;height:20px;background:#0c121a;border-radius:5px;min-width:120px;width:140px}
.bar{position:absolute;left:0;top:0;bottom:0;border-radius:5px;opacity:.85}
.ci{position:absolute;top:4px;height:12px;border-left:2px solid #fff6;border-right:2px solid #fff6}
.barlbl{position:absolute;right:6px;top:0;line-height:20px;font-size:12px;font-weight:700}
.tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:20px;border:1px solid var(--line);color:var(--mut);margin-left:5px}
.pill{display:inline-block;font-size:12px;font-weight:700;padding:2px 8px;border-radius:6px}
.good{background:rgba(76,195,138,.16);color:var(--grn)}
.mid{background:rgba(232,163,61,.16);color:var(--amber)}
.bad{background:rgba(226,86,107,.16);color:var(--red)}
dl{margin:0} dt{font-weight:700;margin-top:10px;color:var(--ink)} dd{margin:2px 0 0;color:var(--mut);font-size:14px}
.face{font-size:13px;color:var(--teal)}
ul{padding-left:18px} li{margin:4px 0}
code{background:#0c121a;padding:1px 5px;border-radius:4px;font-size:13px}
.foot{color:var(--mut);font-size:12px;margin-top:30px;text-align:center}
"""


def grade(p):
    return "good" if p >= 0.66 else ("mid" if p >= 0.4 else "bad")


def speedcell(e):
    s, pl = e["speed"], e["payload"]
    q = s.get("qMsPerText")
    return f"{q:.1f} ms" if q is not None else "—", mb(pl.get("modelBytes"))


out = []
out.append(f"""<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Edge RAG Benchmark — ffmpeg-edge</title><style>{CSS}</style></head><body><div class=wrap>""")

out.append(f"""<h1>Edge&nbsp;RAG Retrieval Benchmark <span class=face>·BMO·</span></h1>
<p class=sub>In-browser ffmpeg command planner — which docs-retrieval config best feeds an LLM.
Updated {meta['updated'][:16].replace('T',' ')} · {meta['real']} real queries + {meta['noAns']} no-answer ·
bootstrap {meta['B']}× 95% CI.</p>""")

# ---- verdict ----
lead = find("all-glued", "bge-small", "fp32", True)
out.append('<div class="card verdict">')
out.append('<h3 style="margin-top:0">Verdict</h3>')
if lead:
    out.append(f'<div class=kpi>{pct(lead["r20"][0])} <span style="font-size:15px;color:var(--mut);font-weight:500">recall@20</span></div>')
out.append("""<p style="margin:.3em 0 0"><b>bge-small + BM25 (RRF)</b> on the
<b>Examples-glued</b> corpus. The biggest lever was <b>chunk content</b> (gluing each
ffmpeg filter's <i>Examples</i> into its page), not the embedding model. POTION (static)
is ~30–80× faster to encode but trails on recall; BM25 alone collapses on
re-worded queries.</p></div>""")

# ---- how to read ----
out.append("<h2>How to read this</h2><div class=card><dl>")
gloss = [
    ("Corpus", "<code>cli</code> = the ffmpeg CLI page (41 sections). <code>all</code> = the full manual (1590). <code>all-glued</code> = full manual with each filter's <i>Examples</i> merged into its page (1333) — the winning corpus."),
    ("Config", "model × precision × fusion, on a corpus. The unit we rank."),
    ("recall@k — the boss metric", f"A query <b>passes</b> at k if ≥1 of its hand-labeled target doc sections is in the top-k retrieved (any-of). recall@k = fraction passing. <b>k={meta['kT']}</b> = tight (small in-browser reader budget); <b>k={meta['kG']}</b> = generous (big external reader). Retrieval feeds an LLM, which tolerates extra/misordered context — it just needs the right doc <i>present</i>. No human reads a ranked list, so rank order matters little."),
    ("Coverage", "fraction of queries whose target even <i>exists</i> in that corpus — the ceiling recall can't beat. <code>cli</code> coverage is only 27%, which is why it can't work no matter the model."),
    ("RRF hybrid", "fuse the dense (embedding cosine) and BM25 (keyword) rankings by reciprocal rank. Scale-free and robust on a small eval set."),
    ("nDCG@5", "a rank-quality tiebreaker (rewards ranking the right doc higher). Not the optimization target."),
    ("95% CI", f"we resample the {meta['real']} queries {meta['B']}× to show uncertainty. With so few queries, treat differences inside overlapping CIs as ties."),
    ("Speed", "<b>query ms/text</b> = runtime cost per user query (what users feel). <b>manual ms/chunk</b> = build-time only (corpus is embedded once and shipped pre-computed). <b>load</b> = model init."),
    ("Size", "model download at the listed precision (int8 ≈ ¼ of fp32) + the vector index."),
]
for t, d in gloss:
    out.append(f"<dt>{t}</dt><dd>{d}</dd>")
out.append("</dl></div>")

# ---- main results table (all-glued) ----
out.append("<h2>Results — corpus <code>all-glued</code></h2>")
out.append('<p class=sub>Hybrid = model + BM25 (RRF). Bar = recall point estimate; faint marks = 95% CI.</p>')
out.append('<div class=scroll><table><thead><tr>'
           '<th>config</th><th>recall@5</th><th>recall@20</th><th>nDCG</th>'
           '<th>query</th><th>size</th></tr></thead><tbody>')

# order: bm25 floor, potion variants, bge variants
def add_row(name, e, color, win=False):
    if not e:
        return
    q, sz = speedcell(e)
    cls = " class=win" if win else ""
    out.append(f"<tr{cls}><td class=name>{name}</td>"
               f"<td>{bar(e['r5'][0], e['r5'][1], e['r5'][2], color)}</td>"
               f"<td>{bar(e['r20'][0], e['r20'][1], e['r20'][2], color)}</td>"
               f"<td>{e['nd']:.2f}</td><td>{q}</td><td>{sz}</td></tr>")

bm = bm25_by_corpus.get("all-glued")
if bm:
    out.append(f"<tr><td class=name>BM25 only <span class=tag>lexical floor</span></td>"
               f"<td>{bar(bm['r5'][0],bm['r5'][1],bm['r5'][2],'#7a8aa0')}</td>"
               f"<td>{bar(bm['r20'][0],bm['r20'][1],bm['r20'][2],'#7a8aa0')}</td>"
               f"<td>{bm['nd']:.2f}</td><td>~0 ms</td><td>built at runtime</td></tr>")
add_row("POTION static", find("all-glued","potion","q8",False), "#e8a33d")
add_row("POTION + BM25 <span class=tag>int8</span>", find("all-glued","potion","q8",True), "#e8a33d")
add_row("bge-small", find("all-glued","bge-small","fp32",False), "#13a89e")
add_row("bge-small + BM25 <span class=tag>fp32</span>", find("all-glued","bge-small","fp32",True), "#13a89e", win=True)
add_row("bge-small + BM25 <span class=tag>int8</span>", find("all-glued","bge-small","q8",True), "#13a89e")
q4e = find("all-glued","bge-small","q4",True)
if q4e:
    add_row("bge-small + BM25 <span class=tag>q4</span>", q4e, "#13a89e")
out.append("</tbody></table></div>")

# ---- corpus effect ----
a = find("all","bge-small","fp32",True)
g = find("all-glued","bge-small","fp32",True)
if a and g:
    out.append("<h2>The biggest lever: gluing Examples</h2><div class=card>")
    out.append("<p>Same model & method (bge-small + BM25, fp32). Merging each filter's "
               "<i>Examples</i> recipe into its chunk lifted recall more than any model swap.</p>")
    out.append('<div class=scroll><table><thead><tr><th>corpus</th><th>recall@5</th><th>recall@20</th></tr></thead><tbody>')
    out.append(f"<tr><td class=name>all <span class=tag>raw manual</span></td><td>{bar(a['r5'][0],color='#7a8aa0')}</td><td>{bar(a['r20'][0],color='#7a8aa0')}</td></tr>")
    out.append(f"<tr class=win><td class=name>all-glued <span class=tag>+Examples</span></td><td>{bar(g['r5'][0],color='#13a89e')}</td><td>{bar(g['r20'][0],color='#13a89e')}</td></tr>")
    out.append("</tbody></table></div></div>")

# ---- speed/size finalists ----
out.append("<h2>Quality × Speed × Size</h2>")
out.append('<p class=sub>The real trade-off. Query speed is the only runtime cost; manual-embed is build-time (shipped pre-computed).</p>')
out.append('<div class=scroll><table><thead><tr><th>model</th><th>recall@20</th><th>query ms</th><th>build ms/chunk</th><th>size (int8)</th></tr></thead><tbody>')
for nm, mdl, dt in [("bge-small (fp32)","bge-small","fp32"),("bge-small (int8)","bge-small","q8"),("POTION (int8)","potion","q8")]:
    e = find("all-glued", mdl, dt, True)
    if not e: continue
    s, pl = e["speed"], e["payload"]
    out.append(f"<tr><td class=name>{nm}</td><td><span class='pill {grade(e['r20'][0])}'>{pct(e['r20'][0])}</span></td>"
               f"<td>{s['qMsPerText']:.1f}</td><td>{(s.get('chunkMsPerText') or 0):.1f}</td><td>{mb(pl['modelBytes'])}</td></tr>")
out.append("</tbody></table></div>")

# ---- per-style + per-intent for leader ----
def agg_for(corpus, model, dtype, kind):
    c = cfgs.get(f"{corpus}__{model}__{dtype}")
    if not c: return None
    for a in c[kind]:
        if a["method"].startswith(f"{model}+bm25/"):
            return a
    return None

st = agg_for("all-glued","bge-small","fp32","styleAgg")
it = agg_for("all-glued","bge-small","fp32","intentAgg")
if st:
    out.append("<h2>Where it leaks — by phrasing style</h2>")
    out.append('<p class=sub>Leader config, recall@20. Users never type flags, so we vary wording style instead.</p><div class=card>')
    for s in meta["styles"]:
        v, n = st["perStyle"][s]
        out.append(f'<div style="margin:9px 0"><div style="display:flex;justify-content:space-between;font-size:14px"><span><b>{s}</b> <span class=mut>(n={n})</span></span></div>{bar(v,color="#13a89e" if v>=.6 else "#e8a33d" if v>=.4 else "#e2566b")}</div>')
    out.append("</div>")
if it:
    out.append("<h2>Where it leaks — by task</h2><div class=card>")
    items = sorted(it["perIntent"].items(), key=lambda kv: kv[1][0], reverse=True)
    for name, (v, n) in items:
        out.append(f'<div style="margin:9px 0"><div style="font-size:14px"><b>{name}</b> <span class=mut>(n={n})</span></div>{bar(v,color="#13a89e" if v>=.6 else "#e8a33d" if v>=.4 else "#e2566b")}</div>')
    out.append("</div>")

# ---- misses ----
lc = cfgs.get("all-glued__bge-small__fp32")
if lc and lc.get("misses"):
    out.append(f"<h2>Still missed ({len(lc['misses'])})</h2><div class=card><ul>")
    for m in lc["misses"]:
        q = m.split(': ', 1)[-1]
        tag = m.split('  ')[1].split(':')[0] if '  ' in m else ''
        out.append(f"<li><span class=mut>{html.escape(tag)}</span> — {html.escape(q)}</li>")
    out.append("</ul><p class=sub>Two clusters: <b>terse</b> 2-word queries (starve retrieval → needs query expansion) and a few re-worded edge cases.</p></div>")

out.append('<p class=foot>ffmpeg-edge · edge-rag-benchmark · generated by BMO 🤖</p>')
out.append("</div></body></html>")

dst = os.path.join(R, "report.html")
open(dst, "w").write("\n".join(out))
print(f"-> {dst}  ({os.path.getsize(dst)} bytes, {len(cfgs)} configs)")
