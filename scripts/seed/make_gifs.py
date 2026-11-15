#!/usr/bin/env python3
"""Render the seed-gate GIFs from the REAL gate run logs.

Same standard as PR 1 (scripts/catalogue/make_gifs.py): these are
terminal-style replays rendered from actual run output, and every frame
carries the disclosure footer — they are NOT live screen captures.

Usage:
    GATE_LOG_DIR=<dir with the seed run_gate.sh logs + npm-test.log> \
        python3 scripts/seed/make_gifs.py

Inputs (from GATE_LOG_DIR): 02-loader-run1.log, 03-loader-run2.log,
04-generator.log, 05-link-seed.log, 06-assertions.log,
07-spot-joins.log, 08-verify-workpage.log, gate.log, npm-test.log.
Output: scripts/seed/gifs/*.gif
"""

import os
import re
import sys

from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 750
HEADER_H = 46
FOOTER_H = 34
LINE_H = 27
FONT_SIZE = 16
MARGIN_X = 18
MAX_LINES = (H - HEADER_H - FOOTER_H - 16) // LINE_H
BG = (13, 17, 23)
FG = (201, 209, 217)
GREEN = (63, 185, 80)
RED = (248, 81, 73)
CYAN = (121, 192, 255)
DIM = (139, 148, 158)

LATIN_FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
CJK_FONT_PATH = "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc"
FOOTER = "Terminal replay rendered from the real run logs — not a live screen capture"

latin = ImageFont.truetype(LATIN_FONT_PATH, FONT_SIZE)
cjk = ImageFont.truetype(CJK_FONT_PATH, FONT_SIZE)
latin_b = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf", FONT_SIZE)

CJK_RE = re.compile(r"[⺀-鿿豈-﫿぀-ヿ가-힯]")


def is_cjk(ch: str) -> bool:
    return bool(CJK_RE.match(ch))


def draw_mixed(draw: ImageDraw.ImageDraw, x: int, y: int, text: str, color) -> None:
    """Draw one line, switching fonts per character run (Latin mono / CJK)."""
    run = ""
    run_is_cjk = None

    def flush(rx, rtext, rcjk):
        if not rtext:
            return rx
        f = cjk if rcjk else latin
        draw.text((rx, y), rtext, font=f, fill=color)
        return rx + draw.textlength(rtext, font=f)

    for ch in text:
        c = is_cjk(ch)
        if run_is_cjk is None or c == run_is_cjk:
            run += ch
            run_is_cjk = c
        else:
            x = flush(x, run, run_is_cjk)
            run = ch
            run_is_cjk = c
    flush(x, run, bool(run_is_cjk))


def line_color(text: str):
    if "PASS" in text:
        return GREEN
    if "ERROR" in text or "FAIL" in text:
        return RED
    if text.startswith("$"):
        return CYAN
    if text.startswith("===") or text.startswith("#"):
        return DIM
    return FG


def render(command: str, lines: list[str], out_path: str) -> None:
    lines = [ln.rstrip("\n") for ln in lines]
    # Truncate overlong lines so nothing spills off the frame.
    lines = [ln if len(ln) <= 92 else ln[:91] + "…" for ln in lines]
    frames: list[Image.Image] = []
    total_steps = max(1, (len(lines) + 1) // 2)
    for step in range(1, total_steps + 1):
        shown = lines[: step * 2]
        visible = shown[-MAX_LINES:]
        img = Image.new("RGB", (W, H), BG)
        d = ImageDraw.Draw(img)
        d.rectangle([0, 0, W, HEADER_H], fill=(22, 27, 34))
        draw_mixed(d, MARGIN_X, 13, command, CYAN)
        y = HEADER_H + 10
        for ln in visible:
            draw_mixed(d, MARGIN_X, y, ln, line_color(ln))
            y += LINE_H
        d.rectangle([0, H - FOOTER_H, W, H], fill=(22, 27, 34))
        draw_mixed(d, MARGIN_X, H - FOOTER_H + 8, FOOTER, DIM)
        frames.append(img)
    frames.append(frames[-1].copy())
    durations = [340] * len(frames)
    durations[-1] = 2000
    frames[0].save(
        out_path,
        save_all=True,
        append_images=frames[1:],
        duration=durations,
        loop=0,
        optimize=True,
    )
    print(f"wrote {out_path} ({os.path.getsize(out_path)} bytes, {len(frames)} frames)")


def read(log_dir: str, name: str) -> list[str]:
    with open(os.path.join(log_dir, name), encoding="utf-8") as fh:
        return fh.read().splitlines()


def pick(lines: list[str], pred, limit: int = 20) -> list[str]:
    return [ln for ln in lines if pred(ln)][:limit]


def main() -> int:
    log_dir = os.environ.get("GATE_LOG_DIR", "scripts/seed/gate-logs")
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gifs")
    os.makedirs(out_dir, exist_ok=True)

    run1 = read(log_dir, "02-loader-run1.log")
    run2 = read(log_dir, "03-loader-run2.log")
    generator = read(log_dir, "04-generator.log")
    link = read(log_dir, "05-link-seed.log")
    assertions = read(log_dir, "06-assertions.log")
    spot = read(log_dir, "07-spot-joins.log")
    workpage = read(log_dir, "08-verify-workpage.log")
    gate = read(log_dir, "gate.log")
    npm_test = read(log_dir, "npm-test.log")

    render(
        "$ python scripts/seed/load_slice.py   # run 1 + run 2",
        ["# the PR 1 slice -> PR 2 schema; counts must equal the manifest"]
        + run1
        + ["", "# run 2 against the same snapshot: insert-if-absent proof"]
        + pick(run2, lambda ln: "inserted=0" in ln or "RESULT" in ln),
        os.path.join(out_dir, "01-loader-counts.gif"),
    )

    render(
        "$ generate_synthetic.py && node link_seed.bundle.mjs",
        ["# 8 archetype listings on the real slice, linked by the shipped Path A"]
        + pick(generator, lambda ln: ln.startswith(("hub work", "donor work", "listing", "stores:", "RESULT")))
        + [""]
        + pick(link, lambda ln: ln.startswith("listing") or ln.startswith("link_seed")),
        os.path.join(out_dir, "02-seed-and-link.gif"),
    )

    render(
        "$ psql sb_p4_seed < assertions.sql   # + spot joins + GetWork RPC",
        pick(assertions, lambda ln: "PASS:" in ln)
        + [""]
        + pick(spot, lambda ln: ln.strip() != "" and "duckdb" not in ln)
        + [""]
        + pick(workpage, lambda ln: "PASS:" in ln or "RESULT" in ln)
        + pick(gate, lambda ln: "GATE SUMMARY" in ln or "RESULT: GATE" in ln),
        os.path.join(out_dir, "03-gate-verdicts.gif"),
    )

    render(
        "$ npm test   # vitest, worker + scripts",
        ["# P4 PR 3 suites: identity, agreement, Path A, GetWork, prefill, OL client"]
        + pick(
            npm_test,
            lambda ln: ("✓" in ln or "Test Files" in ln or "Tests " in ln),
        ),
        os.path.join(out_dir, "04-test-suite.gif"),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
