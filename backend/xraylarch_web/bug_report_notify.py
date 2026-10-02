"""Best-effort Slack heads-up when a report is filed.

Off unless both ``XRAYLARCH_SLACK_BOT_TOKEN`` and
``XRAYLARCH_BUGREPORT_SLACK_CHANNEL`` are set in the backend environment. The
token needs ``chat:write``; the channel is an ID (``C…`` or ``D…``) the bot can
post to. The same Dr.XAS Slack app can be reused by setting its token here.

Every failure is logged and swallowed: Slack being down must never fail a
submission, and the report is on disk before this runs. Posting goes through
the standard library, so the release's pinned dependency set is unchanged.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from typing import Any

from fastapi import BackgroundTasks

logger = logging.getLogger(__name__)

SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage"
_TIMEOUT_SECONDS = 10
_DESCRIPTION_PREVIEW_CHARS = 300
_TYPE_EMOJI = {"bug": "🐞", "feature_request": "💡", "feedback": "💬"}
_TYPE_LABEL = {"bug": "bug", "feature_request": "feature request", "feedback": "feedback"}


def _token() -> str:
    return (os.environ.get("XRAYLARCH_SLACK_BOT_TOKEN") or "").strip()


def _channel() -> str:
    return (os.environ.get("XRAYLARCH_BUGREPORT_SLACK_CHANNEL") or "").strip()


def notify_enabled() -> bool:
    return bool(_token() and _channel())


def escape_mrkdwn(value: str) -> str:
    """Slack's three control characters; reporter text must not ping or link."""
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def build_message(report: dict[str, Any]) -> str:
    report_type = str(report.get("type") or "bug")
    emoji = _TYPE_EMOJI.get(report_type, "🐞")
    label = _TYPE_LABEL.get(report_type, report_type)
    user = escape_mrkdwn(str(report.get("user_email") or "").strip() or "anonymous")
    report_id = escape_mrkdwn(str(report.get("report_id") or "").strip())
    description = str(report.get("description") or "").strip()
    if len(description) > _DESCRIPTION_PREVIEW_CHARS:
        description = description[:_DESCRIPTION_PREVIEW_CHARS].rstrip() + "…"
    description = escape_mrkdwn(description)

    lines = [f"{emoji} *New {label}*  ·  XrayLarch Web  ·  from {user}"]
    if description:
        lines.append("\n".join(f"> {line}" for line in description.splitlines()))
    details = []
    state = report.get("project_state_summary")
    if isinstance(state, dict):
        name = state.get("project_name")
        count = state.get("group_count")
        if name:
            details.append(f"project {escape_mrkdwn(str(name))}")
        if isinstance(count, int):
            details.append(f"{count} group{'' if count == 1 else 's'}")
    if report.get("project_export_file"):
        details.append("project attached")
    screenshots = report.get("screenshot_files")
    if isinstance(screenshots, list) and screenshots:
        details.append(f"{len(screenshots)} screenshot{'' if len(screenshots) == 1 else 's'}")
    footer = f"`{report_id}`"
    if details:
        footer += "  ·  " + ", ".join(details)
    lines.append(footer)
    return "\n".join(lines)


def post_message(channel: str, token: str, text: str) -> bool:
    body = json.dumps({
        "channel": channel,
        "text": text,
        "unfurl_links": False,
        "unfurl_media": False,
    }).encode("utf-8")
    request = urllib.request.Request(
        SLACK_POST_MESSAGE_URL,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
        },
    )
    with urllib.request.urlopen(request, timeout=_TIMEOUT_SECONDS) as response:
        answer = json.loads(response.read().decode("utf-8") or "{}")
    if not answer.get("ok"):
        logger.warning("slack notify: Slack refused the post: %s", answer.get("error", "unknown"))
        return False
    return True


def notify_new_report(report: dict[str, Any]) -> bool:
    """Post the heads-up. Returns True only when Slack accepted it."""
    if not notify_enabled():
        return False
    try:
        return post_message(_channel(), _token(), build_message(report))
    except (urllib.error.URLError, OSError, ValueError):
        logger.exception("slack notify: failed to post report %s", report.get("report_id"))
        return False


def schedule_report_notification(background: BackgroundTasks, report: dict[str, Any]) -> bool:
    """Queue the post to run after the response is sent. False when disabled."""
    if not notify_enabled():
        return False
    background.add_task(notify_new_report, report)
    return True
