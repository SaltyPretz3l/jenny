"""Child activity is bounded, UI-only, ordered and accounted independently."""
from types import SimpleNamespace

from sidecar.ai.routing import loop_events as events
from sidecar.ai.routing.subagent_live_activity import SubagentLiveActivity


def test_live_tools_redact_failures_and_never_forward_success_output():
    sent = []
    live = SubagentLiveActivity(sent.append)
    live(events.ToolExecutingEvent('a', 'read_file', {'path': 'private.txt'}))
    assert sent[-1]['steps'][0]['status'] == 'running'
    assert 'target' not in sent[-1]['steps'][0]
    live(events.ToolResultEvent('a', 'read_file', True, 'private successful contents', {'path': 'ok.txt'}))
    assert sent[-1]['steps'][0]['target'] == 'ok.txt'
    # Successful output rides only in the transcript (row 67), never in the steps.
    assert 'private successful contents' not in str([frame['steps'] for frame in sent])
    assert sent[-1]['transcript'][0]['output'] == 'private successful contents'
    live(events.ToolExecutingEvent('b', 'read_file', {'path': '../secrets.txt'}))
    live(events.ToolResultEvent('b', 'read_file', False, 'Denied ../secrets.txt', {'path': '../secrets.txt'}))
    assert 'secrets.txt' not in str(sent)
    assert sent[-1]['steps'][1]['ok'] is False


def test_text_throttle_reset_usage_and_terminal_fence():
    sent = []
    clock = [0.0]
    live = SubagentLiveActivity(sent.append, clock=lambda: clock[0])
    live(events.ThinkingEvent('reason', 'private reasoning', 'reasoning'))
    # Reasoning opens a live transcript thought; its text waits for the close.
    assert len(sent) == 1 and 'private reasoning' not in str(sent)
    live(events.TokenDeltaEvent('First', 1))
    live(events.TokenDeltaEvent(' part', 2))
    assert len(sent) == 1
    clock[0] = 0.25
    live(events.TokenDeltaEvent('.', 3))
    assert sent[-1]['text'] == 'First part.'
    assert sent[-1]['visible_output_tokens_estimate'] == 3
    live(events.GenerationUsageEvent(SimpleNamespace(input_tokens=10, output_tokens=4, total_tokens=14)))
    assert sent[-1]['usage']['total_tokens'] == 14
    assert sent[-1]['visible_output_tokens_estimate'] is None
    live(events.StreamResetEvent('tool_continuation'))
    live(events.TokenDeltaEvent('Bad retry', 4))
    live(events.GenerationUsageEvent(
        SimpleNamespace(input_tokens=10, output_tokens=4, total_tokens=14),
        output_reported=False,
    ))
    assert live.snapshot()['usage']['total_tokens'] == 14
    assert live.snapshot()['visible_output_tokens_estimate'] == 3
    live(events.StreamResetEvent('provider_retry'))
    assert live.snapshot()['text'] == 'First part.'
    final = live.finish()
    count = len(sent)
    live(events.TokenDeltaEvent('late', 5))
    assert len(sent) == count
    assert final['sequence'] == count


def test_bounds_and_broken_observer_do_not_break_child():
    def broken(_snapshot):
        raise OSError('disconnected')
    live = SubagentLiveActivity(broken)
    for index in range(45):
        live(events.ToolExecutingEvent(str(index), 'read_file', {'path': 'x'}))
    live(events.TokenDeltaEvent('x' * 5000, 1))
    result = live.finish()
    assert len(result['steps']) == 40
    assert result['step_count'] == 45
    assert result['step_count'] > len(result['steps'])
    assert len(result['text']) == 4000
    assert result['text_truncated'] is True
    assert all(step['status'] == 'interrupted' for step in result['steps'])


def test_retry_discards_truncation_and_missing_generation_marks_usage_partial():
    live = SubagentLiveActivity(lambda _snapshot: None)
    usage = SimpleNamespace(input_tokens=10, output_tokens=4, total_tokens=14)
    live(events.TokenDeltaEvent('x' * 5000, 1))
    live(events.StreamResetEvent('provider_retry'))
    live(events.TokenDeltaEvent('Valid retry', 2))
    assert live.snapshot()['text_truncated'] is False
    live(events.GenerationUsageEvent(usage))
    live(events.StreamResetEvent('tool_continuation'))
    live(events.TokenDeltaEvent('Unreported output', 3))
    live(events.GenerationUsageEvent(usage, output_reported=False))
    assert live.snapshot()['usage']['partial'] is True
    live(events.GenerationUsageEvent(usage))
    assert live.snapshot()['usage']['partial'] is True


def test_cancel_interrupts_inflight_tool_redacts_visible_text_and_drops_late_events():
    sent = []
    live = SubagentLiveActivity(sent.append)
    live(events.ToolExecutingEvent('read', 'read_file', {'path': 'README.md'}))
    live(events.TokenDeltaEvent('secret sk-' + 'A' * 48, 1))
    final = live.finish()
    assert final['steps'][0]['status'] == 'interrupted'
    assert 'sk-' not in final['text'] and '[REDACTED]' in final['text']
    count = len(sent)
    live(events.ToolResultEvent('read', 'read_file', True, 'late output', {}))
    live(events.TokenDeltaEvent('late text', 2))
    assert len(sent) == count
