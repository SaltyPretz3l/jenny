from __future__ import annotations

import pytest

from sidecar.ai.tools.builtins import filesystem_content
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.runtime.media_site import PDF_ADDON_ENV

NOT_INSTALLED_MESSAGE = (
    "PDF reading needs the optional PDF reading add-on, which is not installed. "
    "Tell the user they can install it in Settings › Tools › PDF reading add-on. "
    "Do not retry this PDF until they say it is installed."
)
LOAD_FAILED_MESSAGE = (
    "The PDF reading add-on is installed but could not be loaded. "
    "Tell the user to remove it and install it again in Settings › Tools › "
    "PDF reading add-on. Do not retry this PDF until they say it is reinstalled."
)


@pytest.mark.parametrize(
    ("configured_dir", "expected_message"),
    [
        (None, NOT_INSTALLED_MESSAGE),
        ("", NOT_INSTALLED_MESSAGE),
        # Main configured the add-on but activation rejected it (bad manifest,
        # Python too old) or the import failed: remove and reinstall.
        ("C:/pdf-addon", LOAD_FAILED_MESSAGE),
    ],
)
def test_load_pymupdf_names_pdf_addon_and_install_state(
    monkeypatch: pytest.MonkeyPatch,
    configured_dir: str | None,
    expected_message: str,
) -> None:
    def _missing_module(name: str):
        assert name == "fitz"
        raise ImportError("fitz unavailable")

    monkeypatch.setattr(filesystem_content.importlib, "import_module", _missing_module)
    if configured_dir is None:
        monkeypatch.delenv(PDF_ADDON_ENV, raising=False)
    else:
        monkeypatch.setenv(PDF_ADDON_ENV, configured_dir)

    with pytest.raises(ToolExecutionFailure) as raised:
        filesystem_content._load_pymupdf()

    assert raised.value.code == "CMP-TOOL-0047"
    assert raised.value.message == expected_message
    assert raised.value.retryable is False


def test_read_file_pdf_diagnostics_are_isolated_before_catalog_import():
    import json
    import subprocess
    import sys
    from pathlib import Path

    fixture = Path(__file__).resolve().parents[4] / "fixtures/documents/malformed.pdf"
    script = (
        "import json,sys; from pathlib import Path; "
        "from sidecar.ai.tools.builtins.filesystem import read_file_tool,configure_filesystem_tools; "
        "from sidecar.ai.tools.workspace import WorkspaceGuard; "
        "assert 'sidecar.ai.semantic.extract' not in sys.modules; "
        "configure_filesystem_tools({'tools_image_read_enabled':True}); "
        f"p=Path({str(fixture)!r}); "
        "r=read_file_tool({'path':p.name,'pages':'1'},WorkspaceGuard(str(p.parent))); "
        "sys.stdout.write(json.dumps({'output':json.loads(r.output)}))"
    )
    result = subprocess.run([sys.executable, "-c", script], capture_output=True,
                            text=True, encoding="utf-8", timeout=30, check=True)
    payload = json.loads(result.stdout)
    assert payload["output"]["selected_pages"] == [1]
    assert "MuPDF" in result.stderr
