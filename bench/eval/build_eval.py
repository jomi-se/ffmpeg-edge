#!/usr/bin/env python3
"""Generate the retrieval eval set: queries.jsonl.

Design: labels (correct target anchors + coverage flag) live ONCE per *intent*
(so they're correct and not duplicated), and we hand-write many *phrasings* of
each intent across styles. Style IS the stratification bucket here, because the
target user knows nothing about ffmpeg flags — they never type `-crf`; they say
"make it smaller" well/verbose/terse/typo'd/with-wrong-words.

recall hit = at least one of `targets` retrieved within top-k (any-of).
`answerable_in_cli`: is a correct chunk present in the CLI-only corpus? cli has
the command *mechanics* (-ss/-t/-an/-vn/-frames:v) but NOT encoder/filter *names*
(libmp3lame/libx264/crop/palettegen) — so name-dependent intents are all-only.
`no_answer`: ffmpeg cannot do it (semantic understanding) — system should retrieve
nothing useful and the reader should abstain.

Usage: build_eval.py  -> writes ../eval/queries.jsonl
"""
import json
import os

EVAL_VERSION = "0.1.0"

# intent_id -> labels. targets are anchors in the `all` corpus (any-of for recall).
INTENTS = {
    "gif": dict(
        media="video", answerable_in_cli=False,
        targets=["palettegen-1", "paletteuse", "scale-1", "fps-1", "gif-2", "GIF"],
        gloss="video -> small GIF (palettegen/paletteuse + scale/fps)"),
    "mp3": dict(
        media="video|audio", answerable_in_cli=False,
        targets=["libmp3lame-1", "Options-17", "aac"],
        gloss="-> MP3 (needs the libmp3lame encoder name; cli has -vn/-b:a only)"),
    "crop_img": dict(
        media="image", answerable_in_cli=False,
        targets=["crop"],
        gloss="crop an image (crop video filter)"),
    "trim_audio": dict(
        media="audio", answerable_in_cli=True,
        targets=["Main-options", "Video-and-Audio-file-format-conversion"],
        gloss="extract a time section (-ss/-t) — pure mechanics, in cli"),
    "compress_video": dict(
        media="video", answerable_in_cli=False,
        targets=["libx264_002c-libx264rgb", "scale-1"],
        gloss="make a video much smaller (libx264 CRF / scale)"),
    "thumb_video": dict(
        media="video", answerable_in_cli=True,
        targets=["thumbnail", "fps-1", "Main-options", "Video-Options"],
        gloss="grab still frames (-ss/-frames in cli; thumbnail filter all-only)"),
    "mute_video": dict(
        media="video", answerable_in_cli=True,
        targets=["Audio-Options", "Main-options"],
        gloss="remove audio (-an) — mechanics, in cli"),
    "to_mp4": dict(
        media="video", answerable_in_cli=False,
        targets=["libx264_002c-libx264rgb", "aac", "MOV_002fMPEG_002d4_002fISOMBFF-muxers"],
        gloss="-> universal MP4 (h264+aac in the mov/mp4 muxer; was mislabeled to the demuxer)"),
    "speed_video": dict(
        media="video", answerable_in_cli=False,
        targets=["setpts_002c-asetpts", "atempo"],
        gloss="slow-mo / speed up (setpts / atempo)"),
    "thumb_image": dict(
        media="image", answerable_in_cli=False,
        targets=["scale-1", "image2_002c-image2pipe"],
        gloss="messy premise: a 'thumbnail' of one image == resize/convert"),
    "theme": dict(
        media="video", answerable_in_cli=False, no_answer=True, targets=[],
        gloss="NO ANSWER: semantic theme analysis is out of scope for ffmpeg"),
    "summarize": dict(
        media="video", answerable_in_cli=False, no_answer=True, targets=[],
        gloss="NO ANSWER: ffmpeg cannot summarize content"),
}

# (intent, style, text). styles: neutral(well-written) | verbose | terse | typo | wrong_terms
PHRASINGS = [
    ("gif", "neutral", "convert this video to a small gif"),
    ("gif", "verbose", "i'd like to turn this screen recording into a small gif i can share in chat without it being a huge file"),
    ("gif", "terse", "this video -> gif, small"),
    ("gif", "typo", "convert this vidoe to a samll gif"),
    ("gif", "wrong_terms", "make this clip into an animated picture, keep it low size"),

    ("mp3", "neutral", "convert this to a regular mp3"),
    ("mp3", "verbose", "i just want the audio from this video as an mp3 i can put on my phone"),
    ("mp3", "terse", "to mp3"),
    ("mp3", "typo", "convet this song to mp3 pls"),
    ("mp3", "wrong_terms", "rip the sound out of this and save it as a normal music file"),

    ("crop_img", "neutral", "crop this image to a square"),
    ("crop_img", "verbose", "can you cut this photo down so it's just the centered middle part, like a square crop"),
    ("crop_img", "typo", "crop this pictrue to a squere"),
    ("crop_img", "wrong_terms", "trim the edges off this picture"),

    ("trim_audio", "neutral", "extract the section from 0:30 to 1:00 from this audio file"),
    ("trim_audio", "terse", "cut 30s-1m of this audio"),
    ("trim_audio", "wrong_terms", "snip out the part of this sound clip between half a minute and one minute"),

    ("compress_video", "neutral", "compress this video to make it a lot smaller"),
    ("compress_video", "verbose", "this video file is way too big to email, can you shrink it a lot while keeping it watchable"),
    ("compress_video", "terse", "shrink this video"),
    ("compress_video", "typo", "comrpess this video so its much smaler"),
    ("compress_video", "wrong_terms", "how can i reduce the size of this video file"),

    ("thumb_video", "neutral", "extract thumbnails out of this video"),
    ("thumb_video", "verbose", "grab a few still images from throughout this video to use as preview thumbnails"),
    ("thumb_video", "terse", "thumbnails from this video"),
    ("thumb_video", "typo", "extrac thumbnial from this vid"),

    ("mute_video", "neutral", "remove the audio from this video"),
    ("mute_video", "terse", "mute this clip"),
    ("mute_video", "wrong_terms", "take the sound off this video"),

    ("to_mp4", "neutral", "convert this video to mp4 so it plays everywhere"),
    ("to_mp4", "verbose", "this video won't play on my phone, can you convert it into a standard mp4 that works on anything"),
    ("to_mp4", "typo", "convert to mp4 plz it wont paly"),

    ("speed_video", "neutral", "make this video play in slow motion"),
    ("speed_video", "terse", "2x speed this"),
    ("speed_video", "wrong_terms", "make this clip go in fast forward"),

    ("thumb_image", "neutral", "make a small thumbnail version of this photo"),
    ("thumb_image", "wrong_terms", "extract thumbnails out of this image"),

    ("theme", "neutral", "analyze this video to extract the theme"),
    ("theme", "verbose", "watch this video and tell me what the overall theme and mood is"),
    ("summarize", "neutral", "summarize what happens in this video"),
]


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    outp = os.path.join(here, "queries.jsonl")
    seen = {}
    rows = []
    for intent, style, text in PHRASINGS:
        meta = INTENTS[intent]
        n = seen.get((intent, style), 0) + 1
        seen[(intent, style)] = n
        rows.append({
            "id": f"{intent}-{style}-{n}",
            "intent": intent,
            "style": style,
            "media": meta["media"],
            "text": text,
            "targets": meta["targets"],
            "answerable_in_cli": meta["answerable_in_cli"],
            "no_answer": meta.get("no_answer", False),
            "gloss": meta["gloss"],
            "eval_version": EVAL_VERSION,
        })
    with open(outp, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    from collections import Counter
    by_style = Counter(r["style"] for r in rows)
    print(f"wrote {len(rows)} queries across {len(INTENTS)} intents -> {outp}")
    print(f"  by style: {dict(by_style)}")
    print(f"  no_answer: {sum(r['no_answer'] for r in rows)}")
    print(f"  answerable_in_cli: {sum(r['answerable_in_cli'] for r in rows)} "
          f"/ all-only: {sum(not r['answerable_in_cli'] and not r['no_answer'] for r in rows)}")


if __name__ == "__main__":
    main()
