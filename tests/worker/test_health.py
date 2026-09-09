import unittest
import uuid

from server.worker.health import _valid_status


class HealthTests(unittest.TestCase):
    def test_ready_status_requires_null_job(self):
        request_id = str(uuid.uuid4())
        value = {
            "schema_version": 1,
            "request_id": request_id,
            "ok": True,
            "incarnation": str(uuid.uuid4()),
            "phase": "ready",
            "job_id": None,
            "previous_result": None,
        }
        self.assertTrue(_valid_status(value, request_id))
        value["job_id"] = str(uuid.uuid4())
        self.assertFalse(_valid_status(value, request_id))


if __name__ == "__main__":
    unittest.main()
