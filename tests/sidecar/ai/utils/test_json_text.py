from sidecar.ai.utils.json_text import strip_fenced_json


def test_strip_fenced_json_removes_markdown_fence() -> None:
    payload = "```json\n{\"ok\": true}\n```"

    assert strip_fenced_json(payload) == "{\"ok\": true}"


def test_strip_fenced_json_trims_unfenced_payload() -> None:
    assert strip_fenced_json("  {\"ok\": true}  ") == "{\"ok\": true}"
