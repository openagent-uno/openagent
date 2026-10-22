"""Consume an explicit runtime final answer without parsing assistant prose."""

FINAL_UNAVAILABLE = (
    "The run completed, but this runtime did not identify a separate final answer. "
    "Please open its session to review the result."
)


def terminal_answer(payload, *, require_attested=True):
    answer = payload.get("final_answer")
    if answer is None:
        return {"text": FINAL_UNAVAILABLE} if require_attested else payload
    if not isinstance(answer, dict) or set(answer) - {"text", "parts", "attachments"}:
        raise ValueError("Invalid final answer metadata")
    if "text" in answer and not isinstance(answer["text"], str):
        raise ValueError("Invalid final answer text")
    for field in ("parts", "attachments"):
        if field in answer and not isinstance(answer[field], (tuple, list)):
            raise ValueError("Invalid final answer media")
    return answer
