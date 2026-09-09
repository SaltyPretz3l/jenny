"""Fail closed when the offline worker is started outside its Docker contract.

Docker owns namespaces and cgroups; the supervisor verifies the observable
boundary before admitting work. This is not a substitute for a trusted daemon.
"""

from __future__ import annotations

import os
import re
import socket
import stat
from pathlib import Path

MOUNT_MIN_FIELDS = 6
MOUNT_TAIL_FIELDS = 3
CPU_FIELDS = 2
MAX_PIDS = 128
SUPERVISOR_CAPS = 0xC0
JOB_UID = 10001
WORKSPACE_MODE = 0o700
# Exact Docker-managed targets, observed on the supported Engine/Desktop runtime.
# An unexpected nested bind must not inherit trust from /proc, /sys or /dev.
KERNEL_MOUNTS = {
    "/proc": ("proc", {"nosuid", "nodev", "noexec"}),
    "/sys": ("sysfs", {"ro", "nosuid", "nodev", "noexec"}),
    "/sys/fs/cgroup": ("cgroup2", {"ro", "nosuid", "nodev", "noexec"}),
    "/dev": ("tmpfs", {"nosuid"}),
    "/dev/pts": ("devpts", {"nosuid", "noexec"}),
    "/dev/mqueue": ("mqueue", {"nosuid", "nodev", "noexec"}),
    "/dev/shm": ("tmpfs", {"nosuid", "nodev", "noexec"}),
    **{f"/proc/{name}": ("proc", {"ro", "nosuid", "nodev", "noexec"})
       for name in ("bus", "fs", "irq", "sys", "sysrq-trigger")},
    **{target: ("tmpfs", {"ro"})
       for target in (
           "/proc/acpi", "/proc/scsi", "/sys/firmware", "/sys/devices/virtual/powercap"
       )},
    **{f"/proc/{name}": ("tmpfs", {"nosuid"})
       for name in ("interrupts", "kcore", "keys", "latency_stats", "timer_list")},
}


class SecurityError(RuntimeError):
    """A bounded startup reason; never include file content or command text."""


def _require(condition: bool, reason: str) -> None:
    if not condition:
        raise SecurityError(reason)


def _read(path: str, limit: int = 65536) -> str:
    with open(path, encoding="ascii") as source:
        value = source.read(limit + 1)
    _require(len(value) <= limit, "runtime_metadata_limit")
    return value


Mount = tuple[set[str], str, set[str], str, str]
KERNEL_ROOTS = {
    **{f"/proc/{name}": f"/{name}" for name in ("bus", "fs", "irq", "sys", "sysrq-trigger")},
    **{f"/proc/{name}": "/null"
       for name in ("interrupts", "kcore", "keys", "latency_stats", "timer_list")},
}
KERNEL_SOURCES = {"/sys/fs/cgroup": "cgroup", "/dev/shm": "shm"}


def parse_mounts(text: str) -> dict[str, Mount]:
    mounts = {}
    for line in text.splitlines():
        before, separator, after = line.partition(" - ")
        fields, tail = before.split(), after.split()
        _require(
            bool(separator) and len(fields) >= MOUNT_MIN_FIELDS and len(tail) >= MOUNT_TAIL_FIELDS,
            "mount_metadata_invalid",
        )
        # Required mount paths contain no escaped whitespace. Duplicate mounts
        # at those paths are rejected rather than relying on parser ordering.
        target = fields[4]
        _require(target not in mounts, "duplicate_mount")
        mounts[target] = (
            set(fields[5].split(",")), tail[0], set(tail[2].split(",")), fields[3], tail[1]
        )
    return mounts


def _size(value: str) -> int:
    match = re.fullmatch(r"([0-9]+)([kKmMgG]?)", value)
    _require(match is not None, "tmpfs_size_invalid")
    assert match is not None
    return int(match[1]) * {"": 1, "k": 1024, "m": 1024**2, "g": 1024**3}[match[2].lower()]


def validate_mounts(mounts: dict[str, Mount]) -> None:
    for target in ("/", "/inputs"):
        _require(target in mounts and "ro" in mounts[target][0], "readonly_mount_required")
    for target, byte_limit, inode_limit in (
        ("/workspace", 512 * 1024**2, 16384),
        ("/tmp", 64 * 1024**2, 4096),
    ):
        _require(target in mounts, "tmpfs_required")
        options, filesystem, super_options, _root, _source = mounts[target]
        _require(
            filesystem == "tmpfs" and {"rw", "nosuid", "nodev"} <= options,
            "tmpfs_restrictions_required",
        )
        values = dict(option.split("=", 1) for option in super_options if "=" in option)
        _require(0 < _size(values.get("size", "0")) <= byte_limit, "tmpfs_size_invalid")
        _require(
            values.get("nr_inodes", "").isdigit() and 0 < int(values["nr_inodes"]) <= inode_limit,
            "tmpfs_inode_limit_required",
        )
    _require(
        "/run/jenny-worker" in mounts and "rw" in mounts["/run/jenny-worker"][0],
        "control_mount_required",
    )
    for target in mounts:
        # Docker's own /proc, /sys, /dev and resolver mounts are expected.
        expected = target in {
            "/",
            "/inputs",
            "/workspace",
            "/tmp",
            "/run/jenny-worker",
            "/etc/hosts",
            "/etc/hostname",
            "/etc/resolv.conf",
        }
        kernel = KERNEL_MOUNTS.get(target)
        _require(expected or kernel is not None, "unexpected_mount")
        if kernel is not None:
            filesystem, required = kernel
            _require(
                mounts[target][1] == filesystem
                and required <= mounts[target][0]
                and mounts[target][3] == KERNEL_ROOTS.get(target, "/")
                and mounts[target][4] == KERNEL_SOURCES.get(target, filesystem),
                "kernel_mount_invalid",
            )


def validate_cgroups(read=_read) -> None:
    # Initial worker requires cgroup v2; never silently run with unbounded v1
    # or an inaccessible cgroup mount. Docker Desktop and current Engine use v2.
    base = "/sys/fs/cgroup/"
    memory = read(base + "memory.max").strip()
    pids = read(base + "pids.max").strip()
    swap = read(base + "memory.swap.max").strip()
    cpu = read(base + "cpu.max").split()
    _require(memory.isdigit() and 0 < int(memory) <= 2 * 1024**3, "memory_limit_required")
    _require(pids.isdigit() and 0 < int(pids) <= MAX_PIDS, "pid_limit_required")
    _require(swap == "0", "swap_disabled_required")
    _require(
        len(cpu) == CPU_FIELDS
        and all(value.isdigit() for value in cpu)
        and int(cpu[1]) > 0
        and 0 < int(cpu[0]) <= 2 * int(cpu[1]),
        "cpu_limit_required",
    )


def validate_runtime() -> None:
    _require(os.name == "posix" and os.getpid() == 1, "worker_pid_one_required")
    _require(
        os.getresuid() == (0, 0, 0) and os.getresgid() == (10003, 10003, 10003),
        "supervisor_identity_invalid",
    )
    fields = dict(
        line.split(":", 1) for line in _read("/proc/self/status").splitlines() if ":" in line
    )
    _require(fields.get("NoNewPrivs", "").strip() == "1", "no_new_privileges_required")
    _require(fields.get("Seccomp", "").strip() == "2", "seccomp_required")
    for name in ("CapEff", "CapPrm", "CapBnd"):
        _require(
            int(fields.get(name, "0"), 16) == SUPERVISOR_CAPS, "supervisor_capabilities_invalid"
        )
    for name in ("CapInh", "CapAmb"):
        _require(int(fields.get(name, "0"), 16) == 0, "supervisor_capabilities_invalid")
    _require({name for _, name in socket.if_nameindex()} == {"lo"}, "offline_network_required")
    validate_mounts(parse_mounts(_read("/proc/self/mountinfo", 256 * 1024)))
    validate_cgroups()
    for target in ("/workspace",):
        info = Path(target).lstat()
        _require(
            stat.S_ISDIR(info.st_mode)
            and info.st_uid == JOB_UID
            and info.st_gid == JOB_UID
            and stat.S_IMODE(info.st_mode) == WORKSPACE_MODE,
            "workspace_permissions_invalid",
        )

    # Host staging ownership differs on Docker Desktop; its mount is read-only.
    _require(stat.S_ISDIR(Path("/inputs").lstat().st_mode), "inputs_directory_required")
