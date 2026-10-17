"""Docker command authority is checked after consent and before producer start."""

from __future__ import annotations

import logging
from types import SimpleNamespace

import pytest

from sidecar.ai.routing.tool_dispatch import dispatch_tool_call
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.runtime.electron_tool_bridge import ElectronToolBridgeRequest, execute_electron_tool


def dispatch(*, approved=True, current=True, mode='checkpoint', events=None,
             server='electron_tool_bridge'):
    events = [] if events is None else events
    sent = []
    consent = False

    def write(message):
        sent.append(message)
        events.append(message['params']['runtime_resource_gate']['phase'])

    def reader(rpc_id, **_kwargs):
        def read(_timeout):
            nonlocal consent
            if len(sent) == 1:
                consent = approved
                events.append('approved' if approved else 'denied')
                result = ({'runtime_resource_ready': {
                    'schema_version': 1, 'operation_id': 'command_call',
                    'token': '11111111-1111-1111-1111-111111111111',
                }} if approved else {'success': False, 'output': 'Denied'})
            else:
                result = {'success': True, 'output': 'done'}
            return {'id': rpc_id, 'result': result}
        read.close = lambda: None
        return read

    def admit(**kwargs):
        events.append('admit')
        assert kwargs['tool_name'] == 'run_command'
        assert kwargs['arguments'] == {'command': 'echo exact', 'cwd': '.'}
        if not consent or not current:
            raise ToolExecutionFailure(code='CMP-TOOL-0039', message='policy rejected', retryable=False)
        return {'schema_version': 1}

    runtime = SimpleNamespace(
        request_context=SimpleNamespace(execution_context=object(), handoff_preparation=None),
        operation_admission=admit,
        continuation_checkpoint=(lambda: None) if mode == 'checkpoint' else None,
        electron_tool_writer=write, electron_tool_reader_factory=reader,
    )
    result = dispatch_tool_call(
        kernel=SimpleNamespace(_config=SimpleNamespace(host_mode='desktop')),
        call=SimpleNamespace(tool_id='run_command', call_id='command_call'),
        tool_arguments={'command': 'echo exact', 'cwd': '.'},
        descriptor=SimpleNamespace(server_name=server),
        request_id='request', session_id='session', runtime=runtime,
        timeout_seconds=10, cancel_handle=None, on_output_chunk=None,
        admission_arguments={'command': 'echo exact', 'cwd': '.'},
        builtin_server_name='jenny_builtin', electron_server_name='electron_tool_bridge',
        electron_request_type=ElectronToolBridgeRequest, electron_executor=execute_electron_tool,
        logger=logging.getLogger(__name__),
        on_dispatch_ready=(lambda: events.append('dispatch_ready')) if mode != 'legacy' else None,
    )
    return result, events


@pytest.mark.parametrize('mode', ['checkpoint', 'exact'])
def test_consent_precedes_current_authority_and_dispatch_ready_then_one_use_start(mode):
    result, events = dispatch(mode=mode)
    assert result.success
    assert events == ['prepare', 'approved', 'admit', 'dispatch_ready', 'start']


def test_denial_never_admits_or_starts_producer():
    result, events = dispatch(approved=False)
    assert not result.success
    assert events == ['prepare', 'denied']


def test_authority_revoked_after_consent_still_refuses_before_start():
    events = []
    with pytest.raises(ToolExecutionFailure, match='policy rejected'):
        dispatch(current=False, events=events)
    assert events == ['prepare', 'approved', 'admit']


def test_legacy_without_start_hook_retains_early_authority_check():
    events = []
    with pytest.raises(ToolExecutionFailure, match='policy rejected'):
        dispatch(mode='legacy', events=events)
    assert events == ['admit']


@pytest.mark.parametrize('server', ['jenny_builtin', 'external_mcp'])
def test_native_and_external_calls_retain_early_authority_check(server):
    events = []
    with pytest.raises(ToolExecutionFailure, match='policy rejected'):
        dispatch(server=server, events=events)
    assert events == ['admit']
