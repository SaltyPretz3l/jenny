from __future__ import annotations

import base64
from pathlib import Path

import pytest

from sidecar.runtime.vision_attachments import normalize_vision_attachments

_PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


@pytest.mark.parametrize(
    ("asset_key", "mime_key", "display_key", "source_key"),
    [
        ("asset_path", "mime_type", "display_name", "source_kind"),
        ("assetPath", "mimeType", "displayName", "sourceKind"),
    ],
)
def test_normalize_vision_attachments_accepts_both_wire_spellings_and_emits_snake_case(
    tmp_path: Path,
    asset_key: str,
    mime_key: str,
    display_key: str,
    source_key: str,
) -> None:
    image_root = tmp_path / "images"
    image_root.mkdir(parents=True)
    image_path = image_root / "one.png"
    image_path.write_bytes(_PNG_BYTES)
    attachment = {
        "id": "image-1",
        "kind": "image",
        asset_key: str(image_path),
        mime_key: "image/png",
        display_key: "One",
        source_key: "file",
    }

    [normalized] = normalize_vision_attachments([attachment], managed_root=image_root)

    assert normalized["asset_path"] == str(image_path.resolve())
    assert normalized["mime_type"] == "image/png"
    assert normalized["display_name"] == "One"
    assert normalized["source_kind"] == "file"
    assert normalized["size_bytes"] == len(_PNG_BYTES)
    assert not {
        "assetPath",
        "mimeType",
        "displayName",
        "sourceKind",
        "sizeBytes",
    } & normalized.keys()
