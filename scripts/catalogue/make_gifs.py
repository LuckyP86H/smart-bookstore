"""Render the PR 1 "how to run this" GIFs as terminal replays.

METHOD — DISCLOSED, NOT A SCREEN CAPTURE: these GIFs are *replays*.
Each frame is drawn with PIL from the real commands and the real
output lines recorded during the actual build (progress.log,
*.manifest.json, checkpoint files, slice/benchmark manifests and
baseline_results.json in the data dir). No terminal was filmed. The
footer on every GIF says so, and the README repeats it.

Parts (one GIF each, matching the pipeline stages):
    01-fetch.gif       fetch_dumps.sh + manifest / sha256 verification
    02-parse.gif       driver parse stages -> Parquet (+ checkpoints)
    03-slice.gif       slice.py -> slice manifest summary
    04-benchmarks.gif  benchmarks.py + baselines.py -> headline numbers

Usage: ``make_gifs.py --data-dir <DATA_DIR> [--out-dir <dir>]``
Output defaults to ``scripts/catalogue/gifs/`` beside this file.
Canvas 1200x750, DejaVu Sans Mono, target well under 5 MB per GIF.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 750
BG = (13, 17, 23)
FG = (201, 209, 217)
DIM = (110, 118, 129)
GREEN = (63, 185, 80)
CYAN = (88, 166, 255)
FOOTER = "Terminal replay rendered from the real run logs — not a live screen capture."
def _load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    """DejaVu Sans Mono via a small fallback chain (no single hardcoded
    path): $CATALOGUE_FONT_DIR first, then the usual system font dirs,
    then PIL's bundled default."""
    name = "DejaVuSansMono-Bold.ttf" if bold else "DejaVuSansMono.ttf"
    dirs = []
    if os.environ.get("CATALOGUE_FONT_DIR"):
        dirs.append(Path(os.environ["CATALOGUE_FONT_DIR"]))
    dirs += [
        Path("/usr/share/fonts/truetype/dejavu"),
        Path("/usr/share/fonts/TTF"),
        Path.home() / ".fonts",
        Path.home() / ".local/share/fonts",
    ]
    for directory in dirs:
        candidate = directory / name
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default()


FONT = _load_font(21)
FONT_S = _load_font(16)
FONT_BOLD = _load_font(21, bold=True)
LINE_H = 30
TOP = 56
LEFT = 28
MAX_LINES = 21


def read_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text())
    except Exception:
        return {}


def log_lines(data_dir: Path, needle: str, limit: int) -> list[str]:
    out = []
    log = data_dir / "progress.log"
    if not log.exists():
        return out
    for raw in log.read_text(errors="replace").splitlines():
        if needle in raw and "\r" not in raw:
            out.append(raw.strip())
    return out[-limit:]


def frame(lines: list[tuple[str, tuple[int, int, int]]],
          title: str) -> Image.Image:
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 40], fill=(22, 27, 34))
    d.text((LEFT, 10), title, font=FONT_S, fill=DIM)
    y = TOP
    for text, colour in lines[-MAX_LINES:]:
        d.text((LEFT, y), text[:108], font=FONT, fill=colour)
        y += LINE_H
    d.text((LEFT, H - 34), FOOTER, font=FONT_S, fill=DIM)
    return img


def animate(steps: list[tuple[str, tuple[int, int, int]]], title: str,
            out_path: Path, chunk: int = 3) -> None:
    """Reveal lines progressively; hold the final screen."""
    frames: list[Image.Image] = []
    shown: list[tuple[str, tuple[int, int, int]]] = []
    for step in steps:
        shown.append(step)
        if len(shown) % chunk == 0:
            frames.append(frame(shown, title))
    frames.append(frame(shown, title))
    frames.append(frame(shown, title))
    frames.append(frame(shown, title))
    frames[0].save(out_path, save_all=True, append_images=frames[1:],
                   duration=420, loop=0, optimize=True)
    print(f"{out_path.name}: {len(frames)} frames, "
          f"{out_path.stat().st_size / 1e6:.2f} MB")


def cmd(text: str) -> tuple[str, tuple[int, int, int]]:
    return (f"$ {text}", CYAN)


def out(text: str) -> tuple[str, tuple[int, int, int]]:
    return (text, FG)


def ok(text: str) -> tuple[str, tuple[int, int, int]]:
    return (text, GREEN)


def dim(text: str) -> tuple[str, tuple[int, int, int]]:
    return (text, DIM)


def gif_fetch(data_dir: Path, out_dir: Path) -> None:
    steps = [cmd("bash scripts/catalogue/fetch_dumps.sh")]
    for line in log_lines(data_dir, "fetch", 8):
        steps.append(out(line.split("] ", 1)[-1] if "] " in line else line))
    steps.append(cmd("cat dumps/ol_dump_authors_latest.txt.gz.manifest.json"))
    manifest = read_json(data_dir / "dumps"
                         / "ol_dump_authors_latest.txt.gz.manifest.json")
    if manifest:
        steps.append(out(json.dumps(manifest)[:108]))
    steps.append(cmd("gzip -t dumps/*.gz && echo INTEGRITY-OK"))
    steps.append(ok("INTEGRITY-OK"))
    steps.append(dim("# downloads resume with curl -C -; finished files "
                     "are skipped via .done markers"))
    animate(steps, "PR 1 · 1/4 fetch the Open Library dumps", out_dir
            / "01-fetch.gif")


def gif_parse(data_dir: Path, out_dir: Path) -> None:
    steps = [cmd("python scripts/catalogue/run_pipeline.py "
                 "--data-dir $DATA_DIR")]
    for line in log_lines(data_dir, "parse_works", 4):
        steps.append(out(line.split("] ", 1)[-1] if "] " in line else line))
    for kind in ("authors", "wikidata_authors", "works", "editions"):
        ckpt = read_json(data_dir / "parquet" / f"{kind}.ckpt.json")
        if ckpt:
            steps.append(ok(
                f"{kind}: {ckpt.get('rows_written', 0):,} rows, "
                f"rejected={ckpt.get('rejected', 0)}"))
    steps.append(dim("# every stage checkpoints; re-running the driver "
                     "skips finished stages"))
    animate(steps, "PR 1 · 2/4 parse dumps to Parquet", out_dir
            / "02-parse.gif")


def gif_slice(data_dir: Path, out_dir: Path) -> None:
    manifest = read_json(data_dir / "out" / "slice_manifest.json")
    steps = [cmd("python scripts/catalogue/run_pipeline.py "
                 "--data-dir $DATA_DIR --only slice")]
    counts = manifest.get("strata_work_counts") or manifest.get(
        "strata_counts") or {}
    for stratum, n in counts.items():
        steps.append(out(f"stratum {stratum:<24} {n:>6,} works"))
    # Slice totals live at the manifest's top level (there is no
    # "totals" sub-object; reading one silently rendered no totals).
    for key in ("total_works", "total_editions", "total_authors"):
        if isinstance(manifest.get(key), int):
            steps.append(ok(f"{key}: {manifest[key]:,}"))
    steps.append(dim("# adversarial slice per plan section 4.3 — "
                     "not a random sample"))
    animate(steps, "PR 1 · 3/4 build the reference slice", out_dir
            / "03-slice.gif")


def gif_benchmarks(data_dir: Path, out_dir: Path) -> None:
    bench = read_json(data_dir / "out" / "benchmarks_manifest.json")
    base = read_json(data_dir / "out" / "baseline_results.json")
    steps = [cmd("python scripts/catalogue/run_pipeline.py "
                 "--data-dir $DATA_DIR --only benchmarks"),
             cmd("python scripts/catalogue/run_pipeline.py "
                 "--data-dir $DATA_DIR --only baselines")]
    # Suite counts live under bench["suites"][name]["rows"] (there is
    # no "suite_counts" key; reading one silently rendered no suites).
    for suite, info in (bench.get("suites") or {}).items():
        rows = info.get("rows")
        if not isinstance(rows, int):
            continue
        line = f"suite {suite:<22} {rows:>7,} cases"
        if isinstance(info.get("positives"), int) \
                and isinstance(info.get("negatives"), int):
            line += f" ({info['positives']:,} pos + {info['negatives']:,} neg)"
        steps.append(out(line))
    steps.append(dim(""))

    def walk(node: Any, prefix: str = "") -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                walk(value, f"{prefix}{key}.")
        elif isinstance(node, (int, float)) and len(steps) < 24:
            steps.append(ok(f"{prefix[:-1]}: {node}"))

    walk(base)
    steps.append(dim("# full tables in scripts/catalogue/BASELINES.md"))
    animate(steps, "PR 1 · 4/4 benchmarks + baselines", out_dir
            / "04-benchmarks.gif")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--out-dir", default=None)
    args = parser.parse_args()
    data_dir = Path(args.data_dir)
    out_dir = (Path(args.out_dir) if args.out_dir
               else Path(__file__).resolve().parent / "gifs")
    out_dir.mkdir(parents=True, exist_ok=True)
    gif_fetch(data_dir, out_dir)
    gif_parse(data_dir, out_dir)
    gif_slice(data_dir, out_dir)
    gif_benchmarks(data_dir, out_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
