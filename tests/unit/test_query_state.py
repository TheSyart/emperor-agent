from agent.query_state.models import QueryState, TransitionReason
from agent.query_state.transitions import empty_response_retry, length_recovery, max_turns_reached


def test_empty_response_retry_adds_nudge_until_limit() -> None:
    state = QueryState(history=[], turn_count=1, empty_retries=0)

    transition = empty_response_retry(state, max_empty_retries=2)

    assert transition is not None
    assert transition.reason == TransitionReason.EMPTY_RESPONSE_RETRY.value
    assert transition.next_state.empty_retries == 1
    assert transition.next_state.history[-1]["role"] == "user"


def test_empty_response_retry_returns_none_after_limit() -> None:
    state = QueryState(history=[], turn_count=1, empty_retries=2)

    transition = empty_response_retry(state, max_empty_retries=2)

    assert transition is None


def test_length_recovery_appends_assistant_and_continue_message() -> None:
    state = QueryState(history=[], turn_count=1, length_retries=0)

    transition = length_recovery(state, reply="abc", turn_id="turn_1", max_length_recoveries=3)

    assert transition is not None
    assert transition.reason == TransitionReason.LENGTH_RECOVERY.value
    assert transition.next_state.length_retries == 1
    assert transition.next_state.history[0] == {"role": "assistant", "content": "abc", "turn_id": "turn_1"}


def test_max_turns_reached_returns_final_message() -> None:
    state = QueryState(history=[], turn_count=12)

    transition = max_turns_reached(state, max_turns=12, turn_id="turn_1")

    assert transition is not None
    assert transition.reason == TransitionReason.MAX_TURNS_REACHED.value
    assert "达到 max_turns=12" in transition.final_reply
