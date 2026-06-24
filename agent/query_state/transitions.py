from __future__ import annotations

from .models import QueryState, QueryTransition, TransitionReason


def empty_response_retry(state: QueryState, *, max_empty_retries: int) -> QueryTransition | None:
    if state.empty_retries >= max_empty_retries:
        return None
    history = [
        *state.history,
        {"role": "user", "content": "（上一轮无任何输出，请继续推进或给出最终答复）"},
    ]
    next_state = QueryState(
        history=history,
        turn_count=state.turn_count,
        transition=TransitionReason.EMPTY_RESPONSE_RETRY.value,
        empty_retries=state.empty_retries + 1,
        length_retries=state.length_retries,
    )
    return QueryTransition(
        reason=TransitionReason.EMPTY_RESPONSE_RETRY.value,
        next_state=next_state,
        emit=[{
            "event": "tool_error",
            "name": "_empty_response",
            "message": f"empty response, retry {next_state.empty_retries}/{max_empty_retries}",
        }],
    )


def length_recovery(
    state: QueryState,
    *,
    reply: str,
    turn_id: str | None,
    max_length_recoveries: int,
) -> QueryTransition | None:
    if state.length_retries >= max_length_recoveries:
        return None
    history = list(state.history)
    if reply:
        message = {"role": "assistant", "content": reply}
        if turn_id:
            message["turn_id"] = turn_id
        history.append(message)
    history.append({
        "role": "user",
        "content": "（上一轮被 max_tokens 截断，请从中断处续写，不要重复已输出内容）",
    })
    next_state = QueryState(
        history=history,
        turn_count=state.turn_count,
        transition=TransitionReason.LENGTH_RECOVERY.value,
        empty_retries=state.empty_retries,
        length_retries=state.length_retries + 1,
    )
    return QueryTransition(
        reason=TransitionReason.LENGTH_RECOVERY.value,
        next_state=next_state,
        emit=[{
            "event": "tool_error",
            "name": "_length_truncation",
            "message": f"truncated, continuing {next_state.length_retries}/{max_length_recoveries}",
        }],
    )


def max_turns_reached(state: QueryState, *, max_turns: int | None, turn_id: str | None) -> QueryTransition | None:
    if max_turns is None or state.turn_count < max_turns:
        return None
    reply = f"（达到 max_turns={max_turns} 上限，未办妥；history 中已有部分进展）"
    message = {"role": "assistant", "content": reply}
    if turn_id:
        message["turn_id"] = turn_id
    next_state = QueryState(
        history=[*state.history, message],
        turn_count=state.turn_count,
        transition=TransitionReason.MAX_TURNS_REACHED.value,
        empty_retries=state.empty_retries,
        length_retries=state.length_retries,
    )
    return QueryTransition(
        reason=TransitionReason.MAX_TURNS_REACHED.value,
        next_state=next_state,
        final_reply=reply,
    )
