from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).resolve().parents[2]
MODEL_FILES = (
    "PP-OCRv6_det_small.onnx",
    "ch_ppocr_mobile_v2.0_cls_mobile.onnx",
    "PP-OCRv6_rec_small.onnx",
)


def _load_checker() -> ModuleType:
    script_path = ROOT / "scripts" / "checks" / "check_media_site.py"
    module_name = "test_check_media_site_script"
    spec = importlib.util.spec_from_file_location(module_name, script_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load script: {script_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _valid_site(tmp_path: Path) -> tuple[Path, Path]:
    destination = tmp_path / "site"
    lock = tmp_path / "requirements-media-site-lock.txt"
    lock.write_text("example==1.0\n", encoding="utf-8")
    for package in ("rapidocr", "onnxruntime", "cv2"):
        package_file = destination / package / "__init__.py"
        package_file.parent.mkdir(parents=True, exist_ok=True)
        package_file.write_text(f"# {package}\n", encoding="utf-8")
    for filename in MODEL_FILES:
        model = destination / "rapidocr" / "models" / filename
        model.parent.mkdir(parents=True, exist_ok=True)
        model.write_bytes(filename.encode("utf-8"))
    files = {
        path.relative_to(destination).as_posix(): _sha256(path)
        for path in sorted(destination.rglob("*"))
        if path.is_file()
    }
    (destination / "manifest.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "python_version": "3.11",
                "platform": "win_amd64",
                "lock": lock.name,
                "lock_sha256": _sha256(lock),
                "generated_at": "2026-01-01T00:00:00Z",
                "files": files,
            }
        ),
        encoding="utf-8",
    )
    return destination, lock


def _run(checker: ModuleType, destination: Path, lock: Path) -> int:
    return checker.main(
        [
            "--destination",
            str(destination),
            "--lock",
            str(lock),
            "--python-version",
            "3.11",
            "--platform",
            "win_amd64",
        ]
    )


def test_valid_media_site_passes(tmp_path: Path, capsys) -> None:
    checker = _load_checker()
    destination, lock = _valid_site(tmp_path)

    assert _run(checker, destination, lock) == 0
    assert capsys.readouterr().out.startswith("PASS: sidecar media site verified (")


def test_pymupdf_directory_fails_with_specific_reason(tmp_path: Path, capsys) -> None:
    checker = _load_checker()
    destination, lock = _valid_site(tmp_path)
    (destination / "pymupdf").mkdir()

    assert _run(checker, destination, lock) == 1
    output = capsys.readouterr().out
    assert "FAIL: - forbidden package directory present: pymupdf/" in output
    assert "PyMuPDF is an optional add-on and must not be bundled" in output


def test_fitz_directory_fails_with_specific_reason(tmp_path: Path, capsys) -> None:
    checker = _load_checker()
    destination, lock = _valid_site(tmp_path)
    (destination / "fitz").mkdir()

    assert _run(checker, destination, lock) == 1
    output = capsys.readouterr().out
    assert "FAIL: - forbidden package directory present: fitz/" in output
    assert "PyMuPDF is an optional add-on and must not be bundled" in output


def test_hash_mismatch_fails_with_specific_reason(tmp_path: Path, capsys) -> None:
    checker = _load_checker()
    destination, lock = _valid_site(tmp_path)
    (destination / "cv2" / "__init__.py").write_text("tampered\n", encoding="utf-8")

    assert _run(checker, destination, lock) == 1
    assert "FAIL: - checksum mismatch: cv2/__init__.py" in capsys.readouterr().out


def test_extra_file_fails_with_specific_reason(tmp_path: Path, capsys) -> None:
    checker = _load_checker()
    destination, lock = _valid_site(tmp_path)
    (destination / "extra.txt").write_text("extra\n", encoding="utf-8")

    assert _run(checker, destination, lock) == 1
    assert "FAIL: - unlisted file: extra.txt" in capsys.readouterr().out


def test_missing_model_file_fails_with_specific_reason(tmp_path: Path, capsys) -> None:
    checker = _load_checker()
    destination, lock = _valid_site(tmp_path)
    model_path = destination / "rapidocr" / "models" / MODEL_FILES[0]
    model_path.unlink()

    assert _run(checker, destination, lock) == 1
    output = capsys.readouterr().out
    assert f"FAIL: - required model file missing: rapidocr/models/{MODEL_FILES[0]}" in output


def test_wrong_python_version_fails_with_specific_reason(tmp_path: Path, capsys) -> None:
    checker = _load_checker()
    destination, lock = _valid_site(tmp_path)

    exit_code = checker.main(
        [
            "--destination",
            str(destination),
            "--lock",
            str(lock),
            "--python-version",
            "3.12",
            "--platform",
            "win_amd64",
        ]
    )

    assert exit_code == 1
    assert "FAIL: - python_version mismatch: expected 3.12, got 3.11" in capsys.readouterr().out


def test_stale_lock_hash_fails_with_specific_reason(tmp_path: Path, capsys) -> None:
    checker = _load_checker()
    destination, lock = _valid_site(tmp_path)
    lock.write_text("example==2.0\n", encoding="utf-8")

    assert _run(checker, destination, lock) == 1
    assert "FAIL: - lock checksum mismatch" in capsys.readouterr().out
