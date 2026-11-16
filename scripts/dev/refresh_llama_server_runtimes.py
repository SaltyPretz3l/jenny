#!/usr/bin/env python
"""Refresh config/llama-server-runtimes.json from one llama.cpp release.

Row 142 S3. A dev tool: a person runs it, reads the diff and commits the result.

    .venv\\Scripts\\python.exe scripts/dev/refresh_llama_server_runtimes.py \\
        --release b12098 --scan-dir G:\\llmmodels\\runtimes\\llama-b12098-cuda13.4

It asks the public GitHub API for the release's assets (name, size, sha256
digest), keeps the Windows x64 CUDA 13.4 pair and the CPU zip, and derives the
architecture list from an extracted copy of that release. The list is the
architecture names that llama-arch.cpp (the release's own source, the table
llama-server reads architectures from) declares, kept only when the extracted
llama.dll also carries the name as a NUL-delimited string, which is the check
Jenny's chooser makes at run time. The raw DLL string pool alone holds noise
(error text, tensor names), so the source table is the filter.

It refuses to write when an asset has no sha256 digest. Standard library only.
"""

import argparse
import json
import re
import sys
import textwrap
import urllib.request
from datetime import date
from pathlib import Path

REPO = "ggml-org/llama.cpp"
API = "https://api.github.com/repos/" + REPO + "/releases/tags/{release}"
RAW = "https://raw.githubusercontent.com/" + REPO + "/{release}/src/llama-arch.cpp"
USER_AGENT = "jenny-runtime-catalog-refresh"
RELEASE = re.compile(r"^b\d{3,9}$")
ARCHITECTURE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,39}$")
SHA256 = re.compile(r"^sha256:([0-9a-f]{64})$")
ARCH_ENTRY = re.compile(r'\{\s*LLM_ARCH_[A-Z0-9_]+\s*,\s*"([^"]+)"\s*\}')

VARIANTS = {
    "win-x64-cuda-13.4": {
        "platform": "win32",
        "arch": "x64",
        "gpu": "nvidia",
        "assets": ["llama-{release}-bin-win-cuda-13.4-x64.zip", "cudart-llama-bin-win-cuda-13.4-x64.zip"],
    },
    "win-x64-cpu": {
        "platform": "win32",
        "arch": "x64",
        "gpu": "none",
        "assets": ["llama-{release}-bin-win-cpu-x64.zip"],
    },
}


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def build_variants(release, assets):
    by_name = {asset.get("name"): asset for asset in assets}
    variants = {}
    for variant_id, spec in VARIANTS.items():
        entries = []
        for template in spec["assets"]:
            name = template.format(release=release)
            asset = by_name.get(name)
            if not asset:
                raise SystemExit("release has no asset named " + name)
            match = SHA256.match(str(asset.get("digest") or ""))
            if not match:
                raise SystemExit("asset has no sha256 digest: " + name)
            size = asset.get("size")
            if not isinstance(size, int) or size <= 0:
                raise SystemExit("asset has no size: " + name)
            entries.append({"name": name, "size": size, "sha256": match.group(1)})
        variants[variant_id] = {
            "platform": spec["platform"],
            "arch": spec["arch"],
            "gpu": spec["gpu"],
            "assets": entries,
        }
    return variants


def scan_architectures(release, scan_dir):
    library = Path(scan_dir) / "llama.dll"
    if not library.is_file():
        raise SystemExit("no llama.dll in " + str(scan_dir))
    blob = library.read_bytes()
    declared = set(ARCH_ENTRY.findall(fetch(RAW.format(release=release)).decode("utf-8")))
    if len(declared) < 50:
        raise SystemExit("llama-arch.cpp yielded too few architectures; the source format changed")
    found = sorted(
        name for name in declared
        if ARCHITECTURE.match(name) and (b"\0" + name.encode("latin-1") + b"\0") in blob
    )
    if len(found) < 50:
        raise SystemExit("the library carries too few declared architectures; wrong scan dir?")
    return found


def render(catalog):
    """JSON with the long architecture list wrapped, so the file stays short and diffs stay readable."""
    names = catalog["architectures"]
    text = json.dumps({**catalog, "architectures": ["@@"]}, indent=2)
    wrapped = textwrap.fill(", ".join(json.dumps(name) for name in names), width=110, break_long_words=False, break_on_hyphens=False)
    block = "\n".join("    " + line for line in wrapped.splitlines())
    marker = '"architectures": [\n    "@@"\n  ]'
    if text.count(marker) != 1:
        raise SystemExit("could not place the architecture list")
    return text.replace(marker, '"architectures": [\n' + block + "\n  ]") + "\n"


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--release", required=True)
    parser.add_argument("--scan-dir", required=True, help="an extracted copy of that release (holds llama.dll)")
    parser.add_argument("--out", default="config/llama-server-runtimes.json")
    args = parser.parse_args(argv)
    if not RELEASE.match(args.release):
        raise SystemExit("release must look like b12098")
    release_json = json.loads(fetch(API.format(release=args.release)))
    if release_json.get("tag_name") != args.release:
        raise SystemExit("the API answered for a different release")
    catalog = {
        "schema_version": 1,
        "_comment": (
            "Newer llama.cpp build Jenny can download when no trusted build reads a model. "
            "Refreshed by scripts/dev/refresh_llama_server_runtimes.py and reviewed by a person."
        ),
        "release": args.release,
        "build": int(args.release[1:]),
        "checkedOn": date.today().isoformat(),
        "architectures": scan_architectures(args.release, args.scan_dir),
        "variants": build_variants(args.release, release_json.get("assets") or []),
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(render(catalog))
    print("wrote", out, "with", len(catalog["architectures"]), "architectures")
    for variant_id, variant in catalog["variants"].items():
        for asset in variant["assets"]:
            print(variant_id, asset["name"], asset["size"], asset["sha256"])


if __name__ == "__main__":
    main(sys.argv[1:])
