"""Print a config/gguf-companions.json file object from the Hugging Face API.

Usage: python scripts/dev/refresh_gguf_companions.py <repo> <revision> <repoPath> [--save-as NAME]

Reads https://huggingface.co/api/models/<repo>/revision/<revision>?blobs=true,
finds the sibling whose rfilename equals <repoPath> and prints the JSON object
(repo, revision, repoPath, saveAs, bytes, sha256 from the LFS metadata). A
person reviews the output and pastes it into the catalog; this script never
writes a file. Exit status 2 means the arguments or the response failed the
same checks services/gguf-companion-catalog.js applies.
"""

import argparse
import json
import re
import sys
import urllib.error
import urllib.request

REPO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,95}/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$")
REVISION_RE = re.compile(r"^[0-9a-f]{40}$")
SEGMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SAVE_AS_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.gguf$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
TIMEOUT_SECONDS = 30
USER_AGENT = "jenny-catalog-refresh"


def fail(message):
    print(message, file=sys.stderr)
    sys.exit(2)


def check_repo_path(repo_path):
    segments = repo_path.split("/")
    if len(segments) not in (1, 2) or "\\" in repo_path:
        fail("repoPath must be one or two path segments")
    for segment in segments:
        if segment in ("", ".", "..") or not SEGMENT_RE.match(segment):
            fail("repoPath has an invalid segment: %r" % segment)
    if not segments[-1].endswith(".gguf"):
        fail("repoPath must end in .gguf")


def fetch_tree(repo, revision):
    url = "https://huggingface.co/api/models/%s/revision/%s?blobs=true" % (repo, revision)
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            fail("repository is gated or private (HTTP %d): this catalog holds no Hugging Face token" % error.code)
        if error.code == 404:
            fail("repository or revision not found (HTTP 404)")
        fail("Hugging Face API error (HTTP %d)" % error.code)
    except (urllib.error.URLError, TimeoutError, ValueError) as error:
        fail("could not read the Hugging Face API response: %s" % type(error).__name__)


def build_entry(repo, revision, repo_path, save_as):
    tree = fetch_tree(repo, revision)
    if not isinstance(tree, dict):
        fail("unexpected API response shape")
    if tree.get("gated") not in (None, False):
        fail("repository is gated: this catalog holds no Hugging Face token")
    if tree.get("sha") != revision:
        fail("the API returned a different revision than the one requested")
    sibling = next(
        (item for item in tree.get("siblings", []) if isinstance(item, dict) and item.get("rfilename") == repo_path),
        None,
    )
    if sibling is None:
        fail("no file named %s in %s at that revision" % (repo_path, repo))
    lfs = sibling.get("lfs")
    if not isinstance(lfs, dict) or not SHA256_RE.match(str(lfs.get("sha256", ""))):
        fail("the file has no LFS sha256 (not an LFS object)")
    size = lfs.get("size")
    if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
        fail("the file has no usable size")
    if sibling.get("size") not in (None, size):
        fail("the file size and its LFS size disagree")
    return {
        "repo": repo,
        "revision": revision,
        "repoPath": repo_path,
        "saveAs": save_as,
        "bytes": size,
        "sha256": lfs["sha256"],
    }


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("repo")
    parser.add_argument("revision")
    parser.add_argument("repo_path")
    parser.add_argument("--save-as", default=None)
    args = parser.parse_args(argv)

    if not REPO_RE.match(args.repo):
        fail("repo must look like <owner>/<name>")
    if not REVISION_RE.match(args.revision):
        fail("revision must be a 40-character lowercase commit sha")
    check_repo_path(args.repo_path)
    save_as = args.save_as if args.save_as is not None else args.repo_path.split("/")[-1]
    if not SAVE_AS_RE.match(save_as):
        fail("saveAs must be a plain .gguf file name")

    print(json.dumps(build_entry(args.repo, args.revision, args.repo_path, save_as), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
