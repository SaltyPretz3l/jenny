import unittest
import uuid

from server.worker.protocol import ProtocolError, decode_envelope, encode_envelope, validate_request


def request(operation="status", **extra):
    value = {"schema_version": 1, "request_id": str(uuid.uuid4()), "operation": operation}
    value.update(extra)
    return value


class ProtocolTests(unittest.TestCase):
    def test_authenticated_round_trip_and_exact_envelope_keys(self):
        key = b"k" * 32
        value = request()
        frame = encode_envelope(value, key)
        self.assertEqual(decode_envelope(frame, key), value)
        self.assertEqual(set(__import__("json").loads(frame)), {"payload", "mac"})

    def test_tampering_and_unknown_request_keys_rejected(self):
        key = b"k" * 32
        frame = encode_envelope(request(), key)
        frame = frame.replace(b'"mac":"', b'"mac":"0', 1)
        with self.assertRaises(ProtocolError):
            decode_envelope(frame, key)
        with self.assertRaises(ProtocolError):
            validate_request({**request(), "extra": True})

    def test_submit_requires_bounded_relative_cwd_and_timeout(self):
        common = {
            "incarnation": str(uuid.uuid4()),
            "job_id": str(uuid.uuid4()),
            "command": "printf ok",
            "cwd": ".",
            "input_root": ".",
            "timeout_seconds": 1,
        }
        self.assertEqual(validate_request(request("submit", **common))["cwd"], ".")
        with self.assertRaises(ProtocolError):
            validate_request(request("submit", **{**common, "cwd": "../escape"}))
        with self.assertRaises(ProtocolError):
            validate_request(request("submit", **{**common, "timeout_seconds": 0.01}))

    def test_submit_requires_valid_input_root(self):
        common = dict(incarnation=str(uuid.uuid4()), job_id=str(uuid.uuid4()),
                      command="true", cwd=".", timeout_seconds=1)
        with self.assertRaisesRegex(ProtocolError, "request_keys_not_exact"):
            validate_request(request("submit", **common))
        for root in ("..", "a/../b", "/abs", "a\\b", "", "c:x", "a//b", "a/./b",
                     "x" * 1025, "/".join(["a"] * 33), "a\x00b"):
            with self.subTest(root=root), self.assertRaises(ProtocolError):
                validate_request(request("submit", **common, input_root=root))
        for root in (".", "projects/a"):
            self.assertEqual(validate_request(request("submit", **common, input_root=root))
                             ["input_root"], root)


if __name__ == "__main__":
    unittest.main()
