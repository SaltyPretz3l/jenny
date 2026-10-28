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
    # Successful output rides only in the transcript, never in the steps.
    assert 'raw successful output' not in str([f['child_activity']['steps'] for f in live])
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


def _reasoning(delta, kind='reasoning'):
    return events.ThinkingEvent('think-1', delta, kind)


def test_live_frames_carry_the_transcript_only_when_it_changed_and_finish_always_does():
    from sidecar.ai.routing.subagent_live_activity import SubagentLiveActivity

    sent = []
    clock = [0.0]
    live = SubagentLiveActivity(sent.append, clock=lambda: clock[0])
    live(events.TokenDeltaEvent('Checking the README.', 1))
    live(events.StreamResetEvent('tool_continuation'))
    live(events.ToolExecutingEvent('read', 'read_file', {'path': 'README.md'}))
    assert [entry['kind'] for entry in sent[-1]['transcript']] == ['text', 'tool']
    version = sent[-1]['transcript_version']
    live(events.IterationStartEvent(iteration=1, max_iterations=4))
    assert 'transcript' not in sent[-1] and 'transcript_version' not in sent[-1]

    # Opening a thought sends one frame; later deltas add none until it closes.
    frames = len(sent)
    live(_reasoning('I should '))
    assert len(sent) == frames + 1
    assert sent[-1]['transcript'][-1] == {'kind': 'thought', 'text': '', 'live': True}
    assert sent[-1]['transcript_version'] > version
    live(_reasoning('read it.'))
    live(_reasoning('status line', kind='status'))
    clock[0] = 1.0
    live(_reasoning(' Then answer.'))
    assert len(sent) == frames + 1

    live(events.ToolResultEvent('read', 'read_file', True, 'readme body', {'path': 'README.md'}, duration_ms=4.0))
    text, tool, thought = sent[-1]['transcript']
    assert text == {'kind': 'text', 'text': 'Checking the README.'}
    assert tool == {
        'kind': 'tool', 'call_id': 'read', 'tool': 'read_file', 'display': 'Read File',
        'status': 'completed', 'input': '{"path":"README.md"}', 'output': 'readme body', 'ms': 4,
    }
    assert thought == {'kind': 'thought', 'text': 'I should read it. Then answer.', 'ms': 1000}
    assert 'status line' not in str(sent)
    settled = sent[-1]['transcript']

    final = live.finish()
    # Nothing changed since the result frame, so the finish flush omits it,
    # but the returned terminal snapshot always carries it.
    assert 'transcript' not in sent[-1]
    assert final['transcript'] == settled
    assert final['transcript_version'] == sent[-2]['transcript_version']
    assert 'transcript_dropped' not in final
    # The delegate re-reads the settled snapshot; it still carries the transcript.
    assert live.snapshot()['transcript'] == final['transcript']


def test_delegate_report_carries_the_transcript_but_parent_output_does_not():
    frames = []
    config = parse_runtime_config({'engine_type': 'mock'})
    context = ChatRequestContext(request_id='parent', trace_id='trace', session_id='session', mode='assist', approvals_pre_granted=False)
    runtime = LoopRuntime(request_id='parent', session_id='session', request_context=context,
                          notification_writer=frames.append,
                          sub_agent_slot_allocator=SubAgentSlotAllocator(max_active_sub_agents=3, max_sub_agents_per_parent=3))

    def build_chat_decision(**kwargs):
        child = kwargs['runtime']
        child.emit(events.ThinkingEvent('t1', 'Plan the read.', 'reasoning'))
        child.emit(events.TokenDeltaEvent('Reading now.', 1))
        child.emit(events.StreamResetEvent('tool_continuation'))
        child.emit(events.ToolExecutingEvent('read', 'read_file', {'path': 'README.md'}))
        child.emit(events.ToolResultEvent('read', 'read_file', True, 'transcript-only body', {'path': 'README.md'}))
        child.emit(events.TokenDeltaEvent('Final response', 2))
        return ChatDecision(thinking_text=None, response_text='Final response', approval_request=None, tool_results=())

    router = SimpleNamespace(_config=config, build_chat_decision=build_chat_decision)
    result = execute_delegate_tool(router=router, arguments={'tasks': ['Inspect README']},
                                   runtime=runtime, outcome_type=ToolExecutionOutcome, call_id='call')
    report = result.metadata['subagent_batch_report']['tasks'][0]
    assert [entry['kind'] for entry in report['transcript']] == ['thought', 'text', 'tool']
    assert report['transcript'][2]['output'] == 'transcript-only body'
    assert 'Final response' not in json.dumps(report['transcript'])
    assert 'transcript_dropped' not in report
    terminal = [f['params'] for f in frames if f['params'].get('child_terminal')]
    assert terminal[-1]['child_activity']['transcript'] == report['transcript']
    compact = json.loads(result.output)
    assert 'transcript' not in compact and 'transcript' not in json.dumps(compact['results'])
    assert 'transcript-only body' not in result.output and 'Plan the read.' not in result.output


def test_delegate_report_counts_dropped_transcript_entries():
    frames = []
    config = parse_runtime_config({'engine_type': 'mock'})
    context = ChatRequestContext(request_id='parent', trace_id='trace', session_id='session', mode='assist', approvals_pre_granted=False)
    runtime = LoopRuntime(request_id='parent', session_id='session', request_context=context,
                          notification_writer=frames.append,
                          sub_agent_slot_allocator=SubAgentSlotAllocator(max_active_sub_agents=3, max_sub_agents_per_parent=3))

    def build_chat_decision(**kwargs):
        child = kwargs['runtime']
        for index in range(85):
            child.emit(events.ToolResultEvent(f'c{index}', 'read_file', True, 'x', {}))
        return ChatDecision(thinking_text=None, response_text='Done', approval_request=None, tool_results=())

    router = SimpleNamespace(_config=config, build_chat_decision=build_chat_decision)
    result = execute_delegate_tool(router=router, arguments={'tasks': ['Read a lot']},
                                   runtime=runtime, outcome_type=ToolExecutionOutcome, call_id='call')
    report = result.metadata['subagent_batch_report']['tasks'][0]
    assert len(report['transcript']) == 80
    assert report['transcript_dropped'] == 5
    assert 'transcript' not in result.output
