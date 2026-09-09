import unittest

from server.worker.security import SecurityError, parse_mounts, validate_cgroups, validate_mounts


class SecurityTests(unittest.TestCase):
    def test_missing_or_unbounded_cgroup_controls_fail_closed(self):
        values = {
            "memory.max": "2147483648",
            "pids.max": "128",
            "cpu.max": "200000 100000",
            "memory.swap.max": "0",
        }

        def read(path):
            return values[path.rsplit("/", 1)[1]]

        validate_cgroups(read)
        for key, invalid in (
            ("memory.max", "max"),
            ("pids.max", "129"),
            ("cpu.max", "300000 100000"),
            ("memory.swap.max", "1"),
        ):
            original = values[key]
            values[key] = invalid
            with self.assertRaises(SecurityError):
                validate_cgroups(read)
            values[key] = original

    def test_mount_contract_rejects_writable_inputs_extra_mounts_and_unbounded_tmpfs(self):
        mounts = {
            "/": ({"ro"}, "overlay", set()),
            "/inputs": ({"ro"}, "ext4", set()),
            "/run/jenny-worker": ({"rw"}, "ext4", set()),
            "/workspace": ({"rw", "nosuid", "nodev"}, "tmpfs", {"size=524288k", "nr_inodes=16384"}),
            "/tmp": ({"rw", "nosuid", "nodev"}, "tmpfs", {"size=65536k", "nr_inodes=4096"}),
        }
        mounts = {key: (*value, "/", "fixture") for key, value in mounts.items()}
        validate_mounts(mounts)
        for replacement in (
            {"/inputs": ({"rw"}, "ext4", set())},
            {"/secret": ({"ro"}, "ext4", set())},
            {"/dev/host": ({"ro"}, "ext4", set())},
            {"/proc/host": ({"ro"}, "tmpfs", set())},
            {"/sys/fs/cgroup": ({"rw"}, "cgroup2", set())},
            {"/proc/keys": ({"rw", "nosuid"}, "ext4", set())},
            {"/workspace": ({"rw", "nosuid", "nodev"}, "tmpfs", {"size=524288k"})},
        ):
            with self.assertRaises(SecurityError):
                validate_mounts({**mounts, **{key: (*value, "/", "fixture") for key, value in replacement.items()}})

        # Host IPC and same-filesystem bind mounts do not inherit the private
        # Docker shm mount's source/root identity merely by matching tmpfs.
        private = "702 697 0:130 / /dev/shm rw,nosuid,nodev,noexec - tmpfs shm rw,size=65536k"
        validate_mounts({**mounts, **parse_mounts(private)})
        for drift in (private.replace("tmpfs shm", "tmpfs tmpfs"), private.replace("0:130 / ", "0:130 /secret ")):
            with self.assertRaises(SecurityError):
                validate_mounts({**mounts, **parse_mounts(drift)})
