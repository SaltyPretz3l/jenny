"""Delegate entrypoint integration with a deterministic child producer.

This covers the transport contract, not real-provider qualification.
"""
import json
from types import SimpleNamespace

import pytest

from sidecar.ai.config import parse_runtime_config
from sidecar.ai.routing import loop_events as events
from sidecar.ai.routing.delegate import execute_delegate_tool
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.router import ChatDecision, ToolExecutionOutcome
from sidecar.ai.tools.models import GenerationUsage
from sidecar.runtime.chat_models import ChatRequestContext
from sidecar.runtime.subagent_slots import SubAgentSlotAllocator


@pytest.mark.parametrize('fail', [False, True])
@pytest.mark.parametrize('missing_usage', [False, True])
def test_delegate_streams_child_activity_and_keeps_parent_output_compact(fail, missing_usage):
    frames = []
    usage = GenerationUsage(input_tokens=100, output_tokens=10, total_tokens=110)
    config = parse_runtime_config({'engine_type': 'mock'})
    context = ChatRequestContext(request_id='parent', trace_id='trace', session_id='session', mode='assist', approvals_pre_granted=False)
    runtime = LoopRuntime(request_id='parent', session_id='session', request_context=context,
                          notification_writer=frames.append,
                          sub_agent_slot_allocator=SubAgentSlotAllocator(max_active_sub_agents=3, max_sub_agents_per_parent=3))

    def build_chat_decision(**kwargs):
        child = kwargs['runtime']
        assert child.streaming is True
        assert child.notification_writer is None
        assert kwargs['request_context'].read_only is True
        child.emit(events.ToolExecutingEvent('read', 'read_file', {'path': 'README.md'}))
        child.emit(events.ToolResultEvent('read', 'read_file', True, 'raw successful output', {'path': 'README.md'}))
        child.emit(events.TokenDeltaEvent('Intermediate visible response', 1))
        child.report_generation_usage(usage, usage)
        if missing_usage:
            child.emit(events.StreamResetEvent('tool_continuation'))
            child.emit(events.TokenDeltaEvent('Unreported next generation', 2))
            if not fail:
                child.report_generation_usage(usage, None)
        if fail:
            raise OSError('provider broke')
        return ChatDecision(thinking_text=None, response_text='Final response', approval_request=None,
                            tool_results=(), usage=usage)

    router = SimpleNamespace(_config=config, build_chat_decision=build_chat_decision)
    result = execute_delegate_tool(router=router, arguments={'tasks': ['Inspect README']},
                                   runtime=runtime, outcome_type=ToolExecutionOutcome, call_id='call')
    live = [f['params'] for f in frames if f['params'].get('child_activity')]
    assert live
    assert all(f['request_id'] == 'parent' and f['tool_call_id'] == 'call' for f in live)
    assert any(f['child_activity']['steps'][0]['status'] == 'running' for f in live)
    assert 'raw successful output' not in str(live)
    assert live[-1]['child_terminal'] is True
    report = result.metadata['subagent_batch_report']['tasks'][0]
    assert report['usage']['total_tokens'] == 110
    assert report['usage'].get('partial', False) is missing_usage
    assert result.metadata['subagent_batch_report']['usage'].get('partial', False) is missing_usage
    assert report['steps'][0]['tool'] == 'read_file'
    assert report['status'] == ('failed' if fail else 'completed')
    assert 'child_activity' not in report
    compact = json.loads(result.output)
    assert 'usage' not in result.output and 'Intermediate visible response' not in result.output
    assert compact['status'] == ('failed' if fail else 'completed')
    assert runtime.sub_agent_slot_allocator.snapshot()['active_sub_agents'] == 0


def test_interleaved_children_have_independent_activity_and_cancelled_steps_settle():
    import threading

    from sidecar.runtime.chat_models import TerminalChatStateError
    frames = []
    rendezvous = threading.Barrier(2)
    config = parse_runtime_config({'engine_type': 'chatgpt', 'model': 'gpt-6.1-sol'})
    context = ChatRequestContext(request_id='parent', trace_id='trace', session_id='session', mode='assist', approvals_pre_granted=False)
    runtime = LoopRuntime(request_id='parent', session_id='session', request_context=context,
        notification_writer=frames.append, sub_agent_slot_allocator=SubAgentSlotAllocator(max_active_sub_agents=3, max_sub_agents_per_parent=3))
    def decision(**kwargs):
        child = kwargs['runtime']
        child.emit(events.ToolExecutingEvent('read', 'read_file', {'path': 'README.md'}))
        child.emit(events.TokenDeltaEvent('redact sk-' + 'A' * 48, 1))
        rendezvous.wait(timeout=5)
        if kwargs['request_context'].agent_id.endswith(':1'):
            raise TerminalChatStateError(status='cancelled', message='fixture child cancel')
        child.emit(events.ToolResultEvent('read', 'read_file', True, 'safe output', {}))
        return ChatDecision(None, 'Done', None, ())
    result = execute_delegate_tool(router=SimpleNamespace(_config=config, build_chat_decision=decision),
        arguments={'tasks': ['Cancel me', 'Finish me']}, runtime=runtime, outcome_type=ToolExecutionOutcome, call_id='call')
    reports = result.metadata['subagent_batch_report']['tasks']
    assert [row['status'] for row in reports] == ['cancelled', 'completed']
    live = [frame['params'] for frame in frames if frame['params'].get('child_activity')]
    assert len({row['child_task_id'] for row in live}) == 2
    for task in {row['child_task_id'] for row in live}:
        child_frames = [row for row in live if row['child_task_id'] == task]
        # The terminal frame reuses the final cumulative snapshot sequence.
        sequences = [row['child_activity']['sequence'] for row in child_frames]
        assert sequences == sorted(sequences)
        nonterminal = [row['child_activity']['sequence'] for row in child_frames if not row.get('child_terminal')]
        assert len(nonterminal) == len(set(nonterminal))
        assert child_frames[-1]['child_terminal'] is True
    cancelled = next(row for row in live if row.get('child_terminal') and row['status'] == 'cancelled')
    assert cancelled['child_activity']['steps'][0]['status'] == 'interrupted'
    assert 'sk-' not in str(live)
    assert runtime.sub_agent_slot_allocator.snapshot()['active_sub_agents'] == 0
