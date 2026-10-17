"""Weave Evaluations for the two model steps the pipeline leans on. Results land in the W&B project.

    orders  Nemotron work orders on canonical issues from state/snapshot.json. Scores: the reply covers
            the issue, minutes are plausible for the category, equipment is listed. No labels needed.
    find    Cosmos3-Reason find on hand-labelled segments. Scores: category precision and recall, and
            whether a clean clip stayed clean. Labels are JSONL, one segment per line:
              {"segment": "/abs/path/clip.mp4", "expected": ["pavement"]}     ([] = no defect)

Run on the VM from backend/ (needs WANDB_* for both, the GPU endpoints for find):

    .venv/bin/python ../scripts/weave_eval.py orders --limit 20
    .venv/bin/python ../scripts/weave_eval.py find --labels ../data/eval/find_labels.jsonl

Reads only; never writes the store or VastDB. Calls are few and two at a time: the GPUs are shared.
"""
import argparse
import asyncio
import json
import logging
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))
os.environ.setdefault("WEAVE_PARALLELISM", "2")

from app import config  # noqa: E402
from app.ai import cosmos, nemotron, weave_setup  # noqa: E402
from app.ai.prompts import DEFAULT_MINUTES, WORK_ORDER_PROMPT  # noqa: E402

log = logging.getLogger("weave_eval")


def _weave():
    weave_setup.init()
    import weave
    return weave


# ---- orders ----

def order_rows(limit: int) -> list[dict]:
    snapshot = json.loads((Path(config.STATE_DIR) / "snapshot.json").read_text())
    issues = [i for i in snapshot.get("issues", []) if not i.get("duplicate_of")]
    issues.sort(key=lambda i: (i["category"], -i["severity"], i["id"]))
    per_category: dict[str, list[dict]] = {}
    for i in issues:
        per_category.setdefault(i["category"], []).append(i)
    # Round-robin over categories so a small limit still covers all of them.
    rows, k = [], 0
    while len(rows) < limit and any(k < len(v) for v in per_category.values()):
        rows += [{"issue": {f: v[k][f] for f in ("id", "category", "severity", "description")}}
                 for v in per_category.values() if k < len(v)]
        k += 1
    return rows[:limit]


async def draft_order(issue: dict) -> dict:
    reply = await nemotron.chat_json([
        {"role": "system", "content": WORK_ORDER_PROMPT},
        {"role": "user", "content": json.dumps({"video": {"id": "eval"}, "new_canonical": [issue],
                                                "all_issues": [issue]})},
    ], nemotron._OrdersReply, timeout=nemotron.WORK_ORDER_TIMEOUT_S)
    order = next((o for o in reply.orders if o.issue_id == issue["id"]), None)
    return {"covered": order is not None, "minutes": order.minutes if order else None,
            "equipment": order.equipment if order else [], "repair": order.repair if order else None}


def score_order(issue: dict, output: dict) -> dict:
    base = DEFAULT_MINUTES[issue["category"]]
    minutes = output.get("minutes")
    return {"covered": bool(output.get("covered")),
            "minutes_plausible": minutes is not None and base / 4 <= minutes <= base * 4,
            "equipment_listed": bool(output.get("equipment"))}


# ---- find ----

def find_rows(path: Path) -> list[dict]:
    rows = []
    for line in path.read_text().splitlines():
        if line.strip():
            row = json.loads(line)
            rows.append({"segment": row["segment"], "expected": sorted(set(row.get("expected") or []))})
    return rows


async def find(segment: str) -> dict:
    result = await cosmos.find_issues(segment)
    return {"categories": sorted({d.category for d in result.issues}), "scene": result.scene}


def score_find(expected: list[str], output: dict) -> dict:
    got, want = set(output.get("categories") or []), set(expected)
    hit = len(got & want)
    scores = {"precision": hit / len(got) if got else float(not want),
              "recall": hit / len(want) if want else 1.0}
    if not want:                     # only clean clips score this, so the summary is a true rate
        scores["clean_kept_clean"] = not got
    return scores


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="which", required=True)
    o = sub.add_parser("orders")
    o.add_argument("--limit", type=int, default=20)
    f = sub.add_parser("find")
    f.add_argument("--labels", required=True)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    if not all((config.WANDB_API_KEY, config.WANDB_TEAM, config.WANDB_PROJECT)):
        print("WANDB_API_KEY, WANDB_TEAM and WANDB_PROJECT must be set")
        return 2
    weave = _weave()
    if args.which == "orders":
        rows = order_rows(args.limit)
        model, scorers, name = draft_order, [score_order], "work-orders"
    else:
        rows = find_rows(Path(args.labels))
        model, scorers, name = find, [score_find], "cosmos-find"
    if not rows:
        print("No rows to evaluate")
        return 1
    evaluation = weave.Evaluation(name=name, dataset=rows, scorers=[weave.op(s) for s in scorers])
    summary = await evaluation.evaluate(weave.op(model))
    print(json.dumps(summary, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
