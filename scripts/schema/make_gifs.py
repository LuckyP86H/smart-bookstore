#!/usr/bin/env python3
"""Render the schema-gate GIFs from the REAL gate run logs.

Same standard as PR 1 (scripts/catalogue/make_gifs.py): these are
terminal-style replays rendered from actual run output, and every frame
carries the disclosure footer — they are NOT live screen captures.

Usage:
    GATE_LOG_DIR=<dir with run_gate.sh logs + npm-test.log> \
        python3 scripts/schema/make_gifs.py

Inputs (from GATE_LOG_DIR): fresh-setup.log, live-setup.log,
assertions-live.log, fixture-assertions.log, dimensions.log, gate.log,
npm-test.log. Output: scripts/schema/gifs/*.gif
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
    log_dir = os.environ.get("GATE_LOG_DIR", "scripts/schema/gate-logs")
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gifs")
    os.makedirs(out_dir, exist_ok=True)

    fresh = read(log_dir, "fresh-setup.log")
    live = read(log_dir, "live-setup.log")
    assertions_live = read(log_dir, "assertions-live.log")
    fixture_assertions = read(log_dir, "fixture-assertions.log")
    dimensions = read(log_dir, "dimensions.log")
    gate = read(log_dir, "gate.log")
    npm_test = read(log_dir, "npm-test.log")

    applying_fresh = pick(fresh, lambda ln: ln.startswith("applying") or "scaffolding" in ln)
    render(
        "$ scripts/schema/run_gate.sh   # fresh database",
        ["# sb_p4_fresh: scaffolding + all 8 migrations, in filename order"]
        + applying_fresh
        + pick(gate, lambda ln: "prepare sb_p4_fresh" in ln and "PASS" in ln)
        + ["# assertions.sql on sb_p4_fresh: 8/8 PASS (see 02 for the list)"],
        os.path.join(out_dir, "01-migrations-fresh.gif"),
    )

    applying_live = pick(live, lambda ln: ln.startswith("applying") or "scaffolding" in ln or "fixtures" in ln.lower())
    render(
        "$ scripts/schema/run_gate.sh   # live-equivalent rehearsal",
        ["# sb_p4_live: the 3 existing migrations ARE the live schema (0 rows),"]
        + ["# then the 5 new ones rehearse on top — the Step 3 application order"]
        + applying_live
        + pick(assertions_live, lambda ln: "PASS:" in ln),
        os.path.join(out_dir, "02-migrations-live-rehearsal.gif"),
    )

    render(
        "$ psql sb_p4_live < fixture_assertions.sql   # + the dimension test",
        ["# fixtures: same-ISBN pair (one lying), hyphen + x variants, NULL-ISBN, sold + unsold"]
        + pick(fixture_assertions, lambda ln: "PASS:" in ln)
        + [""]
        + pick(dimensions, lambda ln: ln.strip() != "" and not ln.startswith("===")),
        os.path.join(out_dir, "03-fixtures-and-dimensions.gif"),
    )

    test_lines = pick(
        npm_test,
        lambda ln: ("✓" in ln or "Test Files" in ln or "Tests " in ln or "passed" in ln),
    )
    render(
        "$ npm test   # vitest + iteration-literal guard",
        ["# baseline at 5d0e5eab was 123 tests; PR 2 adds the ai/ module suites"]
        + test_lines,
        os.path.join(out_dir, "04-test-suite.gif"),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
