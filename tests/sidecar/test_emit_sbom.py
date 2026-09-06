from __future__ import annotations

import importlib.util
import sys
import uuid
from pathlib import Path
from types import ModuleType


def _load_module() -> ModuleType:
    script = Path(__file__).resolve().parents[2] / "scripts" / "packaging" / "emit_sbom.py"
    name = "test_loader_emit_sbom_hygiene"
    spec = importlib.util.spec_from_file_location(name, script)
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load emit_sbom.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def test_independent_sboms_have_unique_rfc4122_serial_numbers(tmp_path: Path) -> None:
    module = _load_module()
    missing_lock = tmp_path / "missing-lock.txt"

    first = module.build_sbom(lock_path=missing_lock, package_version="1.0.0")
    second = module.build_sbom(lock_path=missing_lock, package_version="1.0.0")

    first_serial = str(first["serialNumber"])
    second_serial = str(second["serialNumber"])
    assert first_serial != second_serial
    assert first_serial.startswith("urn:uuid:")
    assert second_serial.startswith("urn:uuid:")
    assert uuid.UUID(first_serial.removeprefix("urn:uuid:")).version == 4
    assert uuid.UUID(second_serial.removeprefix("urn:uuid:")).version == 4
