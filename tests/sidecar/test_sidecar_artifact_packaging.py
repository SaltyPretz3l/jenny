from scripts.packaging import build_sidecar_artifact


def test_sidecar_excludes_media_site_runtime_packages() -> None:
    excluded = set(build_sidecar_artifact.PYINSTALLER_EXCLUDED_MODULES)

    assert {"cv2", "numpy", "PIL", "rapidocr"} <= excluded
    assert build_sidecar_artifact._pyinstaller_runtime_import_args() == [  # noqa: SLF001
        "--hidden-import",
        "http.cookies",
    ]
