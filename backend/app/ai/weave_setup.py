"""Optional tracing; unavailable telemetry must never stop the pipeline."""
import logging
import os

from app import config

log = logging.getLogger(__name__)
try:
    import weave
except Exception:
    weave = None


def _identity(fn=None, **kwargs):
    return fn if fn is not None else lambda wrapped: wrapped


op = weave.op if weave is not None else _identity
_initialised = False


def init() -> None:
    global _initialised
    if _initialised:
        return
    _initialised = True
    if weave is None or not all((config.WANDB_API_KEY, config.WANDB_TEAM, config.WANDB_PROJECT)):
        log.info("Weave disabled: optional package or W&B configuration missing")
        return
    try:
        os.environ.setdefault("WANDB_API_KEY", config.WANDB_API_KEY)
        # Our explicit ops record compact inputs; SDK autopatching would record media.
        project = f"{config.WANDB_TEAM}/{config.WANDB_PROJECT}"
        try:
            weave.init(project, settings={"implicitly_patch_integrations": False,
                                          "print_call_link": False})
        except TypeError:
            weave.init(project, autopatch_settings={"openai": {"enabled": False}})
    except Exception as exc:
        log.warning("Weave init unavailable (%s)", config.redact(exc))
