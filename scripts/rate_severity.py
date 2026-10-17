"""Re-grade the severity of stored issues from their keyframes (app/ai/rating.py), or check the rater.

Each finding's keyframe (state/frames/{id}.jpg) goes to Cosmos3-Reason with its box drawn on and a close-up;
Nemotron Super-VL answers when Cosmos can't. The answer is a 1-5 grade, a one-sentence reason and a verdict
("rejected" = not a real defect). Ratings are appended to state/ratings.jsonl as they arrive (so a stopped run
resumes) and inserted into the VastDB `ratings` table at the end. Issue rows are never rewritten: the API
applies the newest rating per issue when it loads, and keeps the find pass's grade as find_severity.

This script only reads snapshot.json, so the API can keep running. Afterwards restart it to load the ratings
(`pnpm backend:restart` from the repo root), then regenerate the report (POST /api/report).

    .venv/bin/python ../scripts/rate_severity.py --eval ../scripts/severity_labels.json    # accuracy, no writes
    .venv/bin/python ../scripts/rate_severity.py --dry-run --limit 10                    # print, no writes
    .venv/bin/python ../scripts/rate_severity.py                                         # every unrated issue
    .venv/bin/python ../scripts/rate_severity.py --force --category signage              # re-grade some again
    .venv/bin/python ../scripts/rate_severity.py --revert                                # undo: find grades back
"""
import argparse
import asyncio
from collections import Counter
import json
import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app import config, store  # noqa: E402
from app.ai import rating  # noqa: E402
from app.models import IssueRecord  # noqa: E402

log = logging.getLogger("rate_severity")
CONCURRENCY = 3                   # the GPU pool is shared by the team; cosmos.rate takes gpu.slot() itself


def load_issues() -> list[IssueRecord]:
    """Issues from the snapshot (read-only) with the latest ratings already applied."""
    snapshot = json.loads((Path(config.STATE_DIR) / "snapshot.json").read_text())
    issues = [IssueRecord.model_validate(i) for i in snapshot.get("issues", [])]
    latest = store._latest_ratings(store._read_rating_log())
    for issue in issues:
        if issue.id in latest:
            store.apply_rating_row(issue, latest[issue.id])
    return issues


def _insert_vastdb(rows: list[dict]) -> None:
    if not rows:
        return
    try:
        from app.vast import db
        db.ensure_tables()
        db.insert_ratings(rows)
        log.info("VastDB ratings: inserted %d rows", len(rows))
    except Exception as exc:
        log.warning("VastDB ratings insert failed (%s); state/ratings.jsonl still has them", config.redact(exc))


async def run_eval(issues: dict[str, IssueRecord], labels_path: Path, concurrency: int) -> None:
    labels = {k: v for k, v in json.loads(labels_path.read_text()).items() if not k.startswith("_")}
    picked = [issues[id] for id in labels if id in issues]
    missing = [id for id in labels if id not in issues]
    if missing:
        log.warning("%d labelled ids not in the snapshot: %s", len(missing), ", ".join(missing[:5]))
    started = time.monotonic()
    ratings = await rating.rate_issues(picked, concurrency=concurrency)
    verdict_ok, sev_err, sev_n, models = 0, 0, 0, Counter()
    find_err = 0
    for issue in picked:
        truth, r = labels[issue.id], ratings.get(issue.id)
        real = bool(truth.get("real"))
        if r is None:
            print(f"{issue.id} {issue.category:9} no answer")
            continue
        models[r.model] += 1
        ok = (r.verdict == "confirmed") == real
        verdict_ok += ok
        if real and truth.get("severity") and r.verdict == "confirmed":
            sev_err += abs(r.severity - truth["severity"])
            find_err += abs(issue.severity - truth["severity"])
            sev_n += 1
        print(f"{issue.id} {issue.category:9} truth={'S' + str(truth.get('severity')) if real else 'FP':4} "
              f"find=S{issue.severity} rated=S{r.severity} {r.verdict:9} {'ok ' if ok else 'BAD'} {r.model}: {r.reason}")
    n = sum(models.values())
    print(f"\nverdict accuracy {verdict_ok}/{n}; severity mean abs error {sev_err / max(1, sev_n):.2f} "
          f"(find pass {find_err / max(1, sev_n):.2f}) over {sev_n} real issues; models {dict(models)}; "
          f"{time.monotonic() - started:.0f}s")


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--eval", type=Path, help="labels JSON {id: {real, severity}}: report accuracy, write nothing")
    parser.add_argument("--dry-run", action="store_true", help="print ratings, write nothing")
    parser.add_argument("--force", action="store_true", help="re-grade issues that already have a rating")
    parser.add_argument("--revert", action="store_true", help="clear ratings: severity goes back to the find pass")
    parser.add_argument("--category", help="only this category")
    parser.add_argument("--ids", nargs="+", help="only these issue ids")
    parser.add_argument("--limit", type=int, help="at most N issues")
    parser.add_argument("--concurrency", type=int, default=CONCURRENCY)
    parser.add_argument("--batch", type=int, default=24, help="issues per saved batch")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    for noisy in ("httpx", "weave", "urllib3", "botocore", "vastdb", "openai"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    try:
        from app.ai import weave_setup
        weave_setup.init()
    except Exception as exc:
        log.warning("Weave off (%s)", config.redact(exc))

    issues = load_issues()
    by_id = {i.id: i for i in issues}
    if args.eval:
        await run_eval(by_id, args.eval, args.concurrency)
        return

    todo = [i for i in issues if (not args.category or i.category == args.category)
            and (not args.ids or i.id in args.ids)]
    if args.revert:
        rows = [rating.cleared_row(i) for i in todo if i.severity_model]
        log.info("Reverting %d ratings", len(rows))
        if not args.dry_run:
            store.append_rating_log(rows)
            _insert_vastdb(rows)
        return
    if not args.force:
        todo = [i for i in todo if not i.severity_model]
    todo = todo[:args.limit] if args.limit else todo
    log.info("Rating %d of %d issues (concurrency %d)%s", len(todo), len(issues), args.concurrency,
             " [dry run]" if args.dry_run else "")

    all_rows, models, started = [], Counter(), time.monotonic()
    for start in range(0, len(todo), args.batch):
        batch = todo[start:start + args.batch]
        ratings = await rating.rate_issues(batch, concurrency=args.concurrency)
        rows = [rating.row(i, ratings[i.id]) for i in batch if i.id in ratings]
        for row in rows:
            models[row["model"]] += 1
            if args.dry_run:
                issue = by_id[row["issue_id"]]
                print(f"{issue.id} {issue.category:9} S{issue.severity}->S{row['severity']} {row['verdict']:9} "
                      f"{row['model']}: {row['reason']}")
        if not args.dry_run:
            store.append_rating_log(rows)
        all_rows += rows
        log.info("%d/%d done, %d rated, %s, %.0fs", start + len(batch), len(todo), len(all_rows),
                 dict(models), time.monotonic() - started)
    if not args.dry_run:
        _insert_vastdb(all_rows)

    before = Counter(by_id[r["issue_id"]].severity for r in all_rows)
    after = Counter(r["severity"] for r in all_rows if r["verdict"] == "confirmed")
    log.info("Rated %d/%d (%s); rejected %d; unanswered %d", len(all_rows), len(todo), dict(models),
             sum(r["verdict"] == "rejected" for r in all_rows), len(todo) - len(all_rows))
    log.info("Severity before %s; after (confirmed only) %s", dict(sorted(before.items())), dict(sorted(after.items())))
    if not args.dry_run and all_rows:
        log.info("Now restart the API to load them (pnpm backend:restart), then POST /api/report")


if __name__ == "__main__":
    asyncio.run(main())
