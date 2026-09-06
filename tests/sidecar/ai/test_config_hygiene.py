from sidecar.ai import config
from sidecar.ai.routing import generation_runtime


def test_config_facade_does_not_export_archived_cloud_fallback_engines() -> None:
    assert not hasattr(config, "ARCHIVED_CLOUD_FALLBACK_ENGINES")
    assert not hasattr(generation_runtime, "ARCHIVED_CLOUD_FALLBACK_ENGINES")
