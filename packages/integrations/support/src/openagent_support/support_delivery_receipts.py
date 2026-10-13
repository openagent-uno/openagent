"""Compact host-owned operational receipts."""
from __future__ import annotations
import re
import json
from typing import Any


def retain_event_output(text: str, limit: int = 4000, *, controller_ids: tuple[str, ...] = ("support-local-v1",)) -> str:
    """Retain a valid operational result instead of cutting JSON mid-receipt."""
    if len(text) <= limit:
        return text
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return text[:limit]
    if not isinstance(data, dict) or data.get('controller') not in controller_ids:
        return text[:limit]
    facts = data.get('facts') or {}
    kept = {k: data.get(k) for k in ('thread_id', 'controller', 'intent', 'decision', 'outcome', 'reply')}
    kept['facts'] = {k: facts[k] for k in (
        'reply_source', 'delivery_state', 'human_voice_model', 'human_voice_attempts',
        'human_voice_error', 'human_voice_rejections', 'human_handoff_confirmed',
        'delivery_handoff_confirmed', 'human_owner_required', 'human_owner_verified',
        'human_handoff_error', 'disposition_confirmed', 'language') if k in facts}
    kept['delivery'] = summarize(data.get('actions') or [])
    kept['detail_omitted'] = True
    result = json.dumps(kept, ensure_ascii=False, separators=(',', ':'))
    if len(result) > limit:
        # Unusually large text remains visibly partial, never malformed JSON.
        kept['reply'] = str(kept.get('reply') or '')[:max(0, len(str(kept.get('reply') or '')) - (len(result)-limit) - 80)]
        kept['reply_truncated'] = True
        result = json.dumps(kept, ensure_ascii=False, separators=(',', ':'))
    return result

# These are labels, never excerpts from the provider's message. Classification
# is a diagnostic hint; it does not authorize retries or change delivery state.
_HINTS = (
    ('newer_inbound', r'newer.*inbound|thread changed|re-read thread_brief'),
    ('already_answered', r'already answered|already replied|outbound.*newer'),
    ('idempotency', r'idempotenc|duplicate delivery'),
    ('validation_error', r'validation error|field required|unexpected keyword'),
    ('permission_denied', r'forbidden|unauthorized|permission denied'),
    ('rate_limit', r'rate.limit|too many requests|cooldown'),
    ('timeout', r'timeout|timed out'),
    ('tool_missing', r'tool not found|no tool named|not loaded'),
)


def summarize(actions: list[dict[str, Any]]) -> dict[str, Any]:
    attempts = [a for a in actions if a.get('kind') in ('customer_reply', 'customer_draft')]
    result: dict[str, Any] = {'state': delivery_state(actions), 'attempts': len(attempts)}
    if not attempts:
        return result
    last = attempts[-1]
    result['action_success'] = last.get('success') is True
    objects = receipt_objects(last.get('receipt'))
    for name in ('sent', 'blocked', 'uncertain', 'isError', 'ok', 'success'):
        values = [o[name] for o in objects if isinstance(o.get(name), bool)]
        if values:
            result[name] = values[-1]
    for obj in objects:
        category = obj.get('category')
        if isinstance(category, str) and re.fullmatch(r'[a-z_]{1,80}', category):
            result['category'] = category
        status = obj.get('status')
        if isinstance(status, int) and 400 <= status < 600:
            result['http_status'] = status
    if result['state'] not in ('sent', 'simulated', 'not_attempted'):
        # Inspect failure text in process, but never retain the text itself.
        texts = []
        for obj in objects:
            for key in ('error', 'reason', 'detail', 'text'):
                if isinstance(obj.get(key), str): texts.append(obj[key])
        receipt = last.get('receipt')
        if isinstance(receipt, str): texts.append(receipt)
        text = '\n'.join(texts)[:12000]
        result['error_hints'] = [name for name, pattern in _HINTS if re.search(pattern, text, re.I)]
        match = re.search(r'(?:HTTP(?:Exception|Error)?[ :]+|status(?: code)?[ :=]+)([45]\d\d)\b', text, re.I)
        if match: result['http_status'] = int(match[1])
        error_type = next((o['error_type'] for o in objects if o.get('error_type') in ('RuntimeError', 'TimeoutError', 'ValueError', 'ConnectionError', 'MCPResultEnvelopeLimitError')), None)
        if error_type: result['error_type'] = error_type
    return result


def receipt_objects(receipt: Any) -> list[dict[str, Any]]:
    # Traverse protocol envelopes only, never arbitrary business data. The
    # controller's JSON adapter may already have decoded a text block to a
    # dict; native MCP and JSON-string results must carry the same verdict.
    objects: list[dict[str, Any]] = []
    pending = [(receipt, 0)]
    while pending:
        value, depth = pending.pop()
        if depth > 8:
            continue
        if isinstance(value, str):
            try:
                pending.append((json.loads(value), depth + 1))
            except (ValueError, TypeError):
                pass
        elif isinstance(value, list):
            pending.extend((item, depth + 1) for item in value[:32])
        elif isinstance(value, dict):
            objects.append(value)
            for key in ("structuredContent", "structured_content", "content"):
                if key in value:
                    pending.append((value[key], depth + 1))
            if value.get("type") in (None, "text") and "text" in value:
                pending.append((value["text"], depth + 1))
    return objects


def delivery_state(actions: list[dict[str, Any]]) -> str:
    """A completed turn or an MCP success is not a delivered answer.

    Last attempt wins (blocked -> sent is a successful bounded repair).
    Error envelopes outrank optimistic inner content. Never label a simulated
    send as sent, even if its simulated payload says sent=true.
    """
    for action in reversed(actions):
        if action.get("kind") not in {"customer_reply", "customer_draft"}:
            continue
        if action.get("planned"):
            return "planned"
        objects = receipt_objects(action.get("receipt"))
        if any(x.get("uncertain") is True for x in objects):
            return "unknown"
        if any(x.get("blocked") is True for x in objects):
            return "blocked"
        if any(x.get("isError") or x.get("is_error") or x.get("ok") is False
               or x.get("success") is False for x in objects):
            return "failed"
        if any(x.get("simulated") or x.get("dryRun") for x in objects):
            return "simulated"
        if action.get("kind") == "customer_draft":
            return "draft" if action.get("success") else "failed"
        if any(x.get("sent") is False for x in objects):
            return "held"
        if any(x.get("sent") is True for x in objects) and action.get("success"):
            return "sent"
        return "unknown"
    return "not_attempted"
