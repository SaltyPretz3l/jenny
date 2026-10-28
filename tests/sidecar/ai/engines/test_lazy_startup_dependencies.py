"""httpx, filelock and asyncio stay off the sidecar startup graph without
changing which errors the lazy call sites catch."""

from __future__ import annotations

import subprocess
import sys
import textwrap

import filelock


def _run(code: str) -> str:
    completed = subprocess.run(
        [sys.executable, "-c", textwrap.dedent(code)],
        capture_output=True,
        text=True,
        check=True,
    )
    return completed.stdout.strip()


def test_filelock_timeout_is_still_caught_by_the_oserror_arms() -> None:
    # workspace_mutation_live_owner dropped the eager ``Timeout`` name from its
    # ``except (OSError, ValueError)`` arms; that is only equivalent while this holds.
    assert issubclass(filelock.Timeout, OSError)


def test_admitted_attempt_settles_cancelled_without_importing_asyncio_eagerly() -> None:
    out = _run(
        """
        import sys
        from sidecar.ai.engines.admitted import (
            InferenceAttemptContext, execute_admitted_provider_attempt,
        )
        assert "asyncio" not in sys.modules
        finished = []

        class Lease:
            def settle(self, outcome):
                finished.append((outcome.status, outcome.cleanup))

        def admission(_context):
            return Lease()

        context = InferenceAttemptContext(
            request_id="r", session_id="s", provider="p", model="m",
            request_source="chat", attempt=1, streaming=False,
        )

        def boom():
            raise RuntimeError("x")

        try:
            execute_admitted_provider_attempt(admission=admission, context=context, operation=boom)
        except RuntimeError:
            pass
        assert "asyncio" not in sys.modules
        import asyncio

        def cancel():
            raise asyncio.CancelledError()

        try:
            execute_admitted_provider_attempt(admission=admission, context=context, operation=cancel)
        except asyncio.CancelledError:
            pass
        print(finished)
        """
    )
    assert out == "[('failed', 'confirmed'), ('cancelled', 'uncertain')]"


def test_provider_http_imports_httpx_only_when_a_client_is_built() -> None:
    out = _run(
        """
        import sys
        from sidecar.ai.engines import chatgpt_subscription, provider_http
        assert "httpx" not in sys.modules
        service = provider_http.ProviderHttpService(
            provider="test", base_url="http://127.0.0.1:9", headers={},
        )
        print("httpx" in sys.modules, service.base_url)
        """
    )
    assert out == "True http://127.0.0.1:9"
