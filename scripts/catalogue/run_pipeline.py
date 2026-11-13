"""Stage driver for the smart-bookstore P4 catalogue pipeline.

Runs the pipeline stages in order, skipping any stage that already has a
done marker. All bulk data lives OUTSIDE the repo under ``--data-dir``
(DATA_DIR); this script lives in the repo at ``scripts/catalogue/``.

Stages implemented here (PR 1):
    fetch           bash scripts/catalogue/fetch_dumps.sh (downloads the
                    OL authors/wikidata/works/editions dumps, resumable)
    parse_authors   parse_dump.py --kind authors
    parse_wikidata  parse_wikidata.py
    parse_works     parse_dump.py --kind works
    parse_editions  parse_dump.py --kind editions
    isbn_map        build_isbn_map.py

Later stages (appended at PR 1 integration):
    slice           slice.py
    benchmarks      benchmarks.py
    baselines       baselines.py (also renders BASELINES.md)

Stage bookkeeping:
    A stage is complete when ``<data-dir>/stages/<stage>.done`` exists.
    The marker file itself contains JSON:
    ``{"stage": ..., "finished_at": <UTC ISO ts>, "counts": {...}}``
    where ``counts`` is whatever the stage can report cheaply (checkpoint
    counters for parse stages, stats-file contents for isbn_map, dump
    sizes for fetch). Completed stages are skipped with a printed note.

Subprocesses (the parse/isbn scripts) run under ``--venv-python``, which
defaults to ``<data-dir>/venv/bin/python`` (the venv carrying duckdb +
pyarrow). The fetch stage runs under bash and receives ``DATA_DIR`` in
its environment, matching fetch_dumps.sh's own convention.

Usage:
    run_pipeline.py --data-dir $DATA_DIR
    run_pipeline.py --data-dir $DATA_DIR --only parse_works
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

SCRIPTS_DIR = Path(__file__).resolve().parent

# Stage order is significant: fetch -> parses -> isbn_map.
STAGES: list[str] = [
    "fetch",
    "parse_authors",
    "parse_wikidata",
    "parse_works",
    "parse_editions",
    "isbn_map",
    "slice",
    "benchmarks",
    "baselines",
]

DUMP_NAMES = ("authors", "wikidata", "works", "editions")


class Context:
    """Resolved paths shared by every stage runner."""

    def __init__(self, data_dir: Path, venv_python: Path) -> None:
        self.data_dir = data_dir
        self.venv_python = venv_python
        self.dumps_dir = data_dir / "dumps"
        self.parquet_dir = data_dir / "parquet"
        self.out_dir = data_dir / "out"
        self.stages_dir = data_dir / "stages"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _run(cmd: list[str], env: dict[str, str] | None = None) -> None:
    print("+ " + " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True, env=env)


def _read_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


# ---------------------------------------------------------------------------
# Stage runners: each returns a counts dict for the .done marker.
# ---------------------------------------------------------------------------

def stage_fetch(ctx: Context) -> dict[str, Any]:
    env = dict(os.environ)
    env["DATA_DIR"] = str(ctx.data_dir)
    _run(["bash", str(SCRIPTS_DIR / "fetch_dumps.sh")], env=env)
    counts: dict[str, Any] = {}
    for name in DUMP_NAMES:
        manifest = _read_json(
            ctx.dumps_dir / f"ol_dump_{name}_latest.txt.gz.manifest.json")
        if manifest:
            counts[name] = {"bytes": manifest.get("bytes")}
    counts["dumps_done"] = len(counts)
    return counts


def _parse_counts(ctx: Context, stem: str) -> dict[str, Any]:
    ckpt = _read_json(ctx.parquet_dir / f"{stem}.ckpt.json")
    return {key: ckpt[key] for key in
            ("lines_done", "rows_written", "rejected", "skipped")
            if key in ckpt}


def _make_parse_runner(kind: str) -> Callable[[Context], dict[str, Any]]:
    def runner(ctx: Context) -> dict[str, Any]:
        _run([
            str(ctx.venv_python),
            str(SCRIPTS_DIR / "parse_dump.py"),
            "--kind", kind,
            "--input", str(ctx.dumps_dir / f"ol_dump_{kind}_latest.txt.gz"),
            "--output", str(ctx.parquet_dir / f"{kind}.parquet"),
            "--data-dir", str(ctx.data_dir),
        ])
        return _parse_counts(ctx, kind)

    return runner


def stage_parse_wikidata(ctx: Context) -> dict[str, Any]:
    _run([
        str(ctx.venv_python),
        str(SCRIPTS_DIR / "parse_wikidata.py"),
        "--input", str(ctx.dumps_dir / "ol_dump_wikidata_latest.txt.gz"),
        "--output", str(ctx.parquet_dir / "wikidata_authors.parquet"),
        "--data-dir", str(ctx.data_dir),
    ])
    return _parse_counts(ctx, "wikidata_authors")


def stage_isbn_map(ctx: Context) -> dict[str, Any]:
    _run([
        str(ctx.venv_python),
        str(SCRIPTS_DIR / "build_isbn_map.py"),
        "--data-dir", str(ctx.data_dir),
    ])
    return _read_json(ctx.out_dir / "isbn_map_stats.json")


def _make_script_runner(script: str, manifest: str
                        ) -> Callable[[Context], dict[str, Any]]:
    def runner(ctx: Context) -> dict[str, Any]:
        _run([
            str(ctx.venv_python),
            str(SCRIPTS_DIR / script),
            "--data-dir", str(ctx.data_dir),
        ])
        return _read_json(ctx.out_dir / manifest)

    return runner


STAGE_RUNNERS: dict[str, Callable[[Context], dict[str, Any]]] = {
    "fetch": stage_fetch,
    "parse_authors": _make_parse_runner("authors"),
    "parse_wikidata": stage_parse_wikidata,
    "parse_works": _make_parse_runner("works"),
    "parse_editions": _make_parse_runner("editions"),
    "isbn_map": stage_isbn_map,
    "slice": _make_script_runner("slice.py", "slice_manifest.json"),
    "benchmarks": _make_script_runner("benchmarks.py",
                                      "benchmarks_manifest.json"),
    "baselines": _make_script_runner("baselines.py",
                                     "baseline_results.json"),
}


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------

def run_stage(ctx: Context, stage: str) -> bool:
    """Run one stage unless its .done marker exists. True if it ran."""
    marker = ctx.stages_dir / f"{stage}.done"
    if marker.exists():
        print(f"skip {stage} (done marker present: {marker})")
        return False
    runner = STAGE_RUNNERS.get(stage)
    if runner is None:
        raise RuntimeError(
            f"stage {stage!r} is listed in STAGES but has no runner yet")
    print(f"run {stage} ...", flush=True)
    counts = runner(ctx)
    ctx.stages_dir.mkdir(parents=True, exist_ok=True)
    marker.write_text(json.dumps({
        "stage": stage,
        "finished_at": utc_now_iso(),
        "counts": counts,
    }, indent=2) + "\n", encoding="utf-8")
    print(f"done {stage}: counts={counts}")
    return True


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data-dir", required=True,
                        help="DATA_DIR holding dumps/, parquet/, out/, "
                             "stages/, progress.log")
    parser.add_argument("--only", default=None, choices=STAGES,
                        help="run only this stage (still skipped if its "
                             ".done marker exists)")
    parser.add_argument("--venv-python", default=None,
                        help="python for subprocess stages "
                             "(default: <data-dir>/venv/bin/python)")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    data_dir = Path(args.data_dir)
    venv_python = (Path(args.venv_python) if args.venv_python
                   else data_dir / "venv" / "bin" / "python")
    ctx = Context(data_dir, venv_python)
    ctx.stages_dir.mkdir(parents=True, exist_ok=True)

    stages = [args.only] if args.only else STAGES
    try:
        for stage in stages:
            run_stage(ctx, stage)
    except subprocess.CalledProcessError as exc:
        print(f"stage failed: command exited {exc.returncode}: "
              f"{exc.cmd}", file=sys.stderr)
        return exc.returncode or 1
    print("pipeline complete")
    return 0


if __name__ == "__main__":
    sys.exit(main())
