"""Verify release artifacts and restrict GitHub writes to unpublished drafts."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path

REPOSITORY = "SaltyPretz3l/jenny"
TARGETS = {
    "windows": ("latest.yml", "Jenny-Setup-x64.exe",
                ("Jenny-Setup-x64.exe", "Jenny-Setup-x64.exe.blockmap")),
    "mac": ("latest-mac.yml", "Jenny-arm64.zip", ("Jenny-arm64.dmg", "Jenny-arm64.zip")),
    "linux": ("latest-linux.yml", "Jenny-x86_64.AppImage",
              ("Jenny-x86_64.AppImage", "Jenny-amd64.deb")),
}


def verify_tag(root: Path, tag: str) -> str:
    version = json.loads((root / "package.json").read_text(encoding="utf-8"))["version"]
    if not re.fullmatch(r"v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", tag):
        raise ValueError("Release tag must be a stable vMAJOR.MINOR.PATCH")
    if tag != f"v{version}":
        raise ValueError("Release tag does not match package.json")
    return version


def hashes(file: Path) -> tuple[int, str, str]:
    sha256, sha512 = hashlib.sha256(), hashlib.sha512()
    size = 0
    with file.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            size += len(chunk)
            sha256.update(chunk)
            sha512.update(chunk)
    return size, sha256.hexdigest(), base64.b64encode(sha512.digest()).decode("ascii")


def verify_assets(root: Path, tag: str, platform: str) -> list[Path]:
    import yaml  # noqa: PLC0415 - prepare runs before build dependencies are installed.

    version = verify_tag(root, tag)
    metadata_name, primary, packages = TARGETS[platform]
    dist = (root / "dist").resolve()
    files = [dist / name for name in (*packages, metadata_name)]
    digests = {}
    for file in files:
        if file.resolve().parent != dist or not file.is_file() or file.stat().st_size <= 0:
            raise ValueError(f"Missing or unsafe release artifact: {file.name}")
        digests[file.name] = hashes(file)
    metadata = yaml.safe_load((dist / metadata_name).read_text(encoding="utf-8"))
    if not isinstance(metadata, dict) or metadata.get("version") != version:
        raise ValueError("Updater metadata version does not match the tag")
    entries = metadata.get("files")
    if not isinstance(entries, list) or not entries or len(entries) > len(packages):
        raise ValueError("Updater metadata must reference release packages")
    seen = set()
    for entry in entries:
        name = entry.get("url") if isinstance(entry, dict) else None
        if name not in packages or name in seen:
            raise ValueError("Unexpected or duplicate metadata asset")
        seen.add(name)
        size, _, sha512 = digests[name]
        if entry.get("size") != size or entry.get("sha512") != sha512:
            raise ValueError(f"Updater size/SHA512 mismatch: {name}")
    if primary not in seen:
        raise ValueError("Updater metadata is missing its install target")
    if "path" in metadata:
        legacy = metadata["path"]
        if legacy not in seen or metadata.get("sha512") != digests[legacy][2]:
            raise ValueError("Legacy updater path/SHA512 mismatch")
    manifest = dist / f"SHA256SUMS-{platform}.txt"
    if manifest.is_symlink() or manifest.resolve().parent != dist:
        raise ValueError("Unsafe checksum manifest path")
    manifest.write_text("".join(f"{digests[file.name][1]}  {file.name}\n" for file in files),
                        encoding="utf-8", newline="\n")
    return [*files, manifest]


def gh(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["gh", *args], capture_output=True, text=True, check=False, timeout=300)


def require_draft(tag: str, run=gh) -> dict:
    result = run("release", "view", tag, "--repo", REPOSITORY,
                 "--json", "tagName,isDraft,isPrerelease")
    if result.returncode:
        raise RuntimeError("Cannot inspect release draft")
    release = json.loads(result.stdout)
    if release.get("tagName") != tag or release.get("isDraft") is not True:
        raise RuntimeError("Published releases cannot be modified; use a higher version")
    if release.get("isPrerelease") is not False:
        raise RuntimeError("Stable release must not be a prerelease")
    return release


def prepare(tag: str, run=gh) -> None:
    result = run("release", "view", tag, "--repo", REPOSITORY,
                 "--json", "tagName,isDraft,isPrerelease")
    if result.returncode:
        if result.stderr.strip().lower() != "release not found":
            raise RuntimeError("Cannot inspect release; refusing to create a draft")
        created = run("release", "create", tag, "--repo", REPOSITORY, "--draft",
                      "--verify-tag", "--title", tag, "--notes",
                      "Release candidate. Publish after all build and qualification gates finish.",
                      )
        if created.returncode:
            raise RuntimeError("Could not create release draft")
    require_draft(tag, run)


def upload(tag: str, files: list[Path], run=gh) -> None:
    for file in files:
        # A human must never publish while upload jobs are running. Recheck
        # before EVERY asset; a workflow rerun cannot modify a published tag.
        require_draft(tag, run)
        result = run("release", "upload", tag, str(file), "--repo", REPOSITORY, "--clobber")
        if result.returncode:
            raise RuntimeError(f"Draft upload failed: {file.name}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "verify", "upload"))
    parser.add_argument("--tag", required=True)
    parser.add_argument("--platform", choices=tuple(TARGETS))
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    verify_tag(root, args.tag)
    if args.action != "verify" and (os.environ.get("GITHUB_REPOSITORY") != REPOSITORY
                                   or os.environ.get("GITHUB_EVENT_NAME") != "push"
                                   or os.environ.get("GITHUB_REF") != f"refs/tags/{args.tag}"):
        raise ValueError("Publishing requires the matching public-repository tag push")
    if args.action == "prepare":
        prepare(args.tag)
    else:
        if not args.platform:
            parser.error("--platform is required for artifact operations")
        files = verify_assets(root, args.tag, args.platform)
        if args.action == "upload":
            upload(args.tag, files)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
