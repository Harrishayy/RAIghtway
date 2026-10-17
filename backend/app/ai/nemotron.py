"""W&B Nemotron JSON calls and fail-safe work-order generation."""
import asyncio
from collections import Counter
import json
import logging

from openai import AsyncOpenAI
from pydantic import BaseModel, Field, ValidationError

from app import config
from app.models import IssueRecord, VideoRecord, WorkOrder
from app.ai.prompts import CREW_FOR, DEFAULT_MINUTES, URGENCY_FOR, WORK_ORDER_PROMPT, _extract_json
from app.ai.weave_setup import op

log = logging.getLogger(__name__)
LIGHTNING = "nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B"
ULTRA = "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B"
SUPER_VL = "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B"
WORK_ORDER_TIMEOUT_S = 20.0
_client: AsyncOpenAI | None = None


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        if not all((config.WANDB_API_KEY, config.WANDB_TEAM, config.WANDB_PROJECT)):
            raise RuntimeError("Nemotron requires WANDB_API_KEY, WANDB_TEAM and WANDB_PROJECT")
        _client = AsyncOpenAI(base_url="https://api.inference.wandb.ai/v1",
                              api_key=config.WANDB_API_KEY,
                              project=f"{config.WANDB_TEAM}/{config.WANDB_PROJECT}",
                              timeout=90.0, max_retries=0)
    return _client


async def chat_json(messages, schema: type[BaseModel], model: str = LIGHTNING,
                    timeout: float | None = None) -> BaseModel:
    """Validate JSON, retry once; timeout bounds both attempts together."""
    request_messages = [
        {"role": "system", "content": "Return JSON only, without reasoning or markdown. "
         "Match this JSON schema: " + json.dumps(schema.model_json_schema())},
        *messages,
    ]

    # Capture payloads in the closure: the traced arguments contain metadata only.
    @op
    async def nemotron_json(model: str, schema_name: str, message_count: int):
        for attempt in range(2):
            kwargs = {"model": model, "messages": request_messages,
                      "temperature": 0.2, "max_tokens": 4096}
            if timeout is not None:
                kwargs["timeout"] = timeout
            response = await _get_client().chat.completions.create(**kwargs)
            try:
                message = response.choices[0].message
                content = message.content
                if content is None or not content.strip():
                    content = getattr(message, "reasoning_content", None)
                parsed = _extract_json(content,
                                       array=bool(getattr(schema, "__pydantic_root_model__", False)))
                return schema.model_validate(parsed)
            except (ValueError, TypeError) as exc:
                if attempt:
                    raise
                if isinstance(exc, ValidationError):
                    error = json.dumps(exc.errors(include_input=False, include_url=False), default=str)
                else:
                    error = "The previous reply was not a valid JSON value matching the schema."
                request_messages.append({"role": "user", "content":
                    "Validation failed: " + error + ". Return corrected JSON only."})
        raise RuntimeError("Nemotron JSON validation failed")

    call = nemotron_json(model, schema.__name__, len(messages))
    if timeout is not None:
        return await asyncio.wait_for(call, timeout=timeout)
    return await call


class _OrderDraft(BaseModel):
    issue_id: str
    repair: str = Field(min_length=1)
    minutes: int = Field(ge=1)
    equipment: list[str]


class _OrdersReply(BaseModel):
    orders: list[_OrderDraft]
    explanation: str = Field(min_length=1)


def _compact(issue: IssueRecord) -> dict:
    return issue.model_dump(include={"id", "category", "severity", "description", "duplicate_of"})


def _template(issues: list[dict], all_issues: list[dict]) -> tuple[dict[str, WorkOrder], str]:
    orders = {issue["id"]: WorkOrder(
        repair=f"Inspect and repair the reported {issue['category'].replace('_', ' ')} issue.",
        crew=CREW_FOR[issue["category"]], minutes=DEFAULT_MINUTES[issue["category"]],
        equipment=["appropriate repair tools", "personal protective equipment", "safety cones"],
        urgency=URGENCY_FOR(issue["severity"])) for issue in issues}
    counts = Counter(issue["category"] for issue in all_issues)
    if counts:
        detail = ", ".join(f"{count} {category.replace('_', ' ')}" for category, count in sorted(counts.items()))
        explanation = f"This video contains {len(all_issues)} recorded maintenance findings: {detail}. "
    else:
        explanation = "No clearly visible maintenance issues were recorded in this video. "
    explanation += (f"Template work orders were prepared for {len(issues)} new canonical issues; "
                    "repair times and equipment need crew confirmation.")
    return orders, explanation


@op
async def _work_orders(video: dict, new_canonical: list[dict], all_issues: list[dict]):
    fallback, explanation = _template(new_canonical, all_issues)
    try:
        reply = await chat_json([
            {"role": "system", "content": WORK_ORDER_PROMPT},
            {"role": "user", "content": json.dumps({"video": video,
                "new_canonical": new_canonical, "all_issues": all_issues})},
        ], _OrdersReply, timeout=WORK_ORDER_TIMEOUT_S)
        drafts = {item.issue_id: item for item in reply.orders}
        orders = fallback.copy()
        templated = 0
        for issue in new_canonical:
            draft = drafts.get(issue["id"])
            if draft is None:
                templated += 1
                continue
            orders[issue["id"]] = WorkOrder(
                repair=draft.repair, minutes=draft.minutes, equipment=draft.equipment,
                crew=CREW_FOR[issue["category"]], urgency=URGENCY_FOR(issue["severity"]))
        log.info("Nemotron work orders: templated %d missing IDs", templated)
        return orders, reply.explanation
    except Exception as exc:
        log.warning("Nemotron work orders: template fallback (%s)", config.redact(exc))
        return fallback, explanation


async def work_orders_and_explanation(video: VideoRecord, new_canonical: list[IssueRecord],
                                      all_issues: list[IssueRecord]) -> tuple[dict[str, WorkOrder], str]:
    new = [_compact(issue) for issue in new_canonical if not issue.duplicate_of]
    issues = [_compact(issue) for issue in all_issues]
    compact_video = video.model_dump(include={"id", "filename", "duration_s"})
    try:
        return await _work_orders(compact_video, new, issues)
    except Exception as exc:
        log.warning("Nemotron work orders: template fallback (%s)", config.redact(exc))
        return _template(new, issues)
