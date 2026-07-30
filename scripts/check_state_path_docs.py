"""Check every documented `state/` path against what the filesystem actually holds.

WHY THIS EXISTS
---------------
On 2026-07-30 a wrong documented path took **five rounds** to fix, and in every round
both agents were correct about what they had measured. The count moved five times
because the pattern had **three degrees of freedom** and each round censused one:

    FORM      ${CTX_AGENT_NAME} / $CTX_AGENT_NAME / <agent> / {agent}   (a 4th form was
                                                                         found in round 4)
    TREE      templates/agent -> +agent-codex -> +analyst,orchestrator -> +community/, ...
    ARTIFACT  crons.json, cron-execution.log ... and .crons-migrated, which NOBODY
              censused because it was the FIXED part of everyone's regex

⇒ **A CENSUS ON ONE AXIS OF A MULTI-AXIS PATTERN IS STILL A WHITELIST ON THE REST — and
it feels like a census because one axis genuinely was one.**

The correction is not a better regex. It is a source of truth that is not a pattern:

⭐ **A PATTERN MAY FIND CANDIDATES. ONLY GROUND TRUTH MAY AUTHORISE A WRITE.**

So this script does not carry a list of filenames. It ASKS THE FILESYSTEM which artifacts
live under which state tree, then checks every documentation reference against that. A
seventh cron artifact appearing tomorrow is covered on the next run with no edit here.

⚠ THE NEAR-MISS THAT MOTIVATED THE GROUNDING. A pattern-based sweep labelled all 56
`${CTX_ROOT}/state/<agent>/.onboarded` references WRONG because its known-good test was
"contains .cortextOS/state/agents/". `.onboarded` legitimately lives in the OTHER tree.
Writing from that verdict would have broken onboarding for every agent while fixing a
marker file. **Over-reporting is the safe failure for FINDING and the dangerous one for
FIXING** — same instrument, opposite polarity depending on what you do next with it.

EXIT: 0 = every documented reference agrees with the filesystem
      1 = at least one disagrees
      2 = COULD NOT CHECK (a tree is missing, or nothing was enumerated)
The verdict is also printed as content, because an exit code does not survive a pipe.
"""
from __future__ import annotations

import argparse
import atexit
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

EXIT_OK, EXIT_MISMATCH, EXIT_CANNOT = 0, 1, 2
VERDICT_TOKEN = "VERDICT"
_NAME = {EXIT_OK: "OK", EXIT_MISMATCH: "MISMATCH", EXIT_CANNOT: "CANNOT_CHECK"}
_emitted = False


def verdict(code: int, message: str) -> int:
    global _emitted
    _emitted = True
    print(f"{VERDICT_TOKEN}={_NAME[code]} EXIT={code} — {message}")
    return code


def _atexit_guard() -> None:
    # Covers the CLASS "the process ended" rather than members of it: an uncaught
    # exception or a dependency's SystemExit never reaches a return statement.
    if not _emitted:
        print(f"{VERDICT_TOKEN}={_NAME[EXIT_CANNOT]} EXIT={EXIT_CANNOT} — the process ended "
              f"without reaching a verdict; NOTHING was checked")


atexit.register(_atexit_guard)


class _TokenParser(argparse.ArgumentParser):
    """argparse exits from inside parse_args, bypassing every return-based choke point."""

    def error(self, message):  # noqa: D102
        global _emitted
        _emitted = True
        self.print_usage(sys.stderr)
        print(f"{VERDICT_TOKEN}={_NAME[EXIT_CANNOT]} EXIT={EXIT_CANNOT} — bad invocation "
              f"({message}); nothing was checked")
        raise SystemExit(EXIT_CANNOT)


# Any documented reference of the shape <...>state<sep>[agents<sep>]<agent><sep><artifact>.
# The AGENT and ARTIFACT slots are deliberately open — they are the axes that were
# whitelisted for five rounds.
DOC_REF = re.compile(
    r"(?P<cortex>\.cortextOS[\\/])?state[\\/](?P<agents>agents[\\/])?"
    r"(?P<agent>[^\s`\"'\\/]+)[\\/](?P<artifact>[^\s`\"'()\[\],;:]+)")

DOC_SUFFIXES = {".md", ".codex-ready"}
SKIP_PARTS = ("/.git/", "/node_modules/", "/.tmp/", "/findings/")

# Paths whose job is to RECORD a past state. A memory note or a dated phase report that
# QUOTES the wrong path is evidence of the defect, not an instance of it — rewriting one
# is remediation destroying the evidence of incidence. Excluded by default, includable
# with --include-records so the exclusion is never invisible.
RECORD_PARTS = ("/memory/", "/docs/phase-reports/")
RECORD_NAMES = {"MEMORY.md"}


def enumerate_ground_truth(ctx_root: Path) -> tuple[dict[str, set[str]], str | None]:
    """artifact basename -> {'A','B'} telling which real tree(s) hold it.

    A = <root>/.cortextOS/state/agents/<agent>/   B = <root>/state/<agent>/
    """
    trees = {"A": ctx_root / ".cortextOS" / "state" / "agents", "B": ctx_root / "state"}
    missing = [k for k, p in trees.items() if not p.is_dir()]
    if missing:
        return {}, f"state tree(s) not found on disk: {', '.join(trees[k].as_posix() for k in missing)}"
    where: dict[str, set[str]] = defaultdict(set)
    for label, base in trees.items():
        for agent_dir in base.iterdir():
            if not agent_dir.is_dir():
                continue
            for f in agent_dir.iterdir():
                if f.is_file():
                    where[f.name].add(label)
    if not where:
        return {}, "enumerated ZERO artifacts across both trees — a broken walk, not an empty one"
    return dict(where), None


def main() -> int:
    ap = _TokenParser(description=__doc__,
                      formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ctx-root", default=os.environ.get("CTX_ROOT", ""),
                    help="cortextOS instance root (default: $CTX_ROOT)")
    ap.add_argument("--include-records", action="store_true",
                    help="also check memory notes and dated reports. They QUOTE the wrong path "
                         "as evidence, so they are expected to mismatch; rewriting one would be "
                         "remediation destroying the evidence of incidence.")
    ap.add_argument("--docs-root", default=str(Path(__file__).resolve().parents[1]),
                    help="tree of documentation to check (default: the repo containing this script)")
    a = ap.parse_args()

    if not a.ctx_root:
        return verdict(EXIT_CANNOT, "CTX_ROOT is unset and --ctx-root was not given; "
                                    "there is no ground truth to check against")
    ctx_root = Path(a.ctx_root.replace("\\", "/"))
    docs_root = Path(a.docs_root)
    if not docs_root.is_dir():
        return verdict(EXIT_CANNOT, f"docs root does not exist: {docs_root}")

    ground, err = enumerate_ground_truth(ctx_root)
    if err:
        return verdict(EXIT_CANNOT, err)

    a_only = sorted(k for k, v in ground.items() if v == {"A"})
    b_only = sorted(k for k, v in ground.items() if v == {"B"})
    both = sorted(k for k, v in ground.items() if v == {"A", "B"})
    print(f"ground truth from {ctx_root}")
    print(f"  tree A (.cortextOS/state/agents/): {len(a_only)} artifact name(s) exclusive to it")
    print(f"  tree B (state/):                   {len(b_only)} exclusive")
    print(f"  present in BOTH (unclassifiable):  {len(both)}{' -> ' + ', '.join(both[:6]) if both else ''}")

    mismatches: list[tuple[str, int, str, str]] = []
    records_skipped: list[str] = []
    unknown: dict[str, int] = defaultdict(int)
    scanned = 0
    for p in docs_root.rglob("*"):
        if not p.is_file() or p.suffix not in DOC_SUFFIXES:
            continue
        ap_ = p.as_posix()
        if any(s in ap_ for s in SKIP_PARTS):
            continue
        is_record = any(s in ap_ for s in RECORD_PARTS) or p.name in RECORD_NAMES
        if is_record and not a.include_records:
            records_skipped.append(p.relative_to(docs_root).as_posix())
            continue
        scanned += 1
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for i, line in enumerate(text.splitlines(), 1):
            for m in DOC_REF.finditer(line):
                art = m.group("artifact").rstrip(".,`)\"'")
                documented = "A" if (m.group("cortex") and m.group("agents")) else "B"
                trees_for = ground.get(art)
                if trees_for is None:
                    unknown[art] += 1          # not on disk: cannot adjudicate, never assume
                    continue
                if trees_for == {"A", "B"}:
                    continue                    # exists in both; either reference is defensible
                if documented not in trees_for:
                    real = "A" if "A" in trees_for else "B"
                    mismatches.append((p.relative_to(docs_root).as_posix(), i, art,
                                       f"documented in tree {documented}, exists only in tree {real}"))

    print(f"\nscanned {scanned} doc file(s) under {docs_root}")
    if records_skipped:
        # NAMED, not merely omitted. An exclusion nobody can see is indistinguishable from
        # a gap in coverage — which is the whole reason this sweep took five rounds.
        print(f"  ({len(records_skipped)} record file(s) skipped — they QUOTE the wrong path "
              f"as EVIDENCE; re-run with --include-records to see them)")
    if unknown:
        # A name the filesystem does not hold cannot be adjudicated either way. Printed,
        # never silently dropped: an artifact this script could not judge is exactly where
        # a sixth round would hide.
        print(f"⚠ {len(unknown)} referenced name(s) do NOT exist on disk, so no verdict is "
              f"possible for them (they are NOT counted as clean):")
        for k, n in sorted(unknown.items(), key=lambda kv: -kv[1])[:12]:
            print(f"    n={n:<3} {k}")

    if not mismatches:
        return verdict(EXIT_OK, f"every documented state/ reference to a known artifact agrees "
                                f"with the filesystem ({scanned} files scanned)")

    print(f"\n⛔ {len(mismatches)} reference(s) disagree with the filesystem:")
    for f, ln, art, why in mismatches:
        print(f"    {f}:{ln}  {art}  — {why}")
    return verdict(EXIT_MISMATCH, f"{len(mismatches)} documented reference(s) point at the "
                                  f"wrong state tree")


if __name__ == "__main__":
    sys.exit(main())
