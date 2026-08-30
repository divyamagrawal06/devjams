import importlib.util
from pathlib import Path
import unittest


SPEC = importlib.util.spec_from_file_location("world_sync_measure", Path(__file__).with_name("measure.py"))
assert SPEC and SPEC.loader
MEASURE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MEASURE)


class CandidateReadinessIdentityTests(unittest.TestCase):
    deployment_id = "dep_expected"
    artifact_digest = "sha256:" + ("a" * 64)

    def test_exact_candidate_and_artifact_are_required(self):
        self.assertIsNone(
            MEASURE.readiness_error(
                {
                    "status": "ready",
                    "deployment_id": self.deployment_id,
                    "artifact_digest": self.artifact_digest,
                },
                self.deployment_id,
                self.artifact_digest,
            )
        )

    def test_generic_and_wrong_candidate_responses_are_rejected(self):
        self.assertIn(
            "status",
            MEASURE.readiness_error({}, self.deployment_id, self.artifact_digest),
        )
        self.assertIn(
            "deployment identity",
            MEASURE.readiness_error(
                {
                    "status": "ready",
                    "deployment_id": "dep_unrelated",
                    "artifact_digest": self.artifact_digest,
                },
                self.deployment_id,
                self.artifact_digest,
            ),
        )
        self.assertIn(
            "artifact identity",
            MEASURE.readiness_error(
                {
                    "status": "ready",
                    "deployment_id": self.deployment_id,
                    "artifact_digest": "sha256:" + ("b" * 64),
                },
                self.deployment_id,
                self.artifact_digest,
            ),
        )

    def test_readiness_url_must_stay_on_cluster_dns(self):
        with self.assertRaisesRegex(RuntimeError, "internal cluster service"):
            MEASURE.wait_ready(
                "https://example.test/ready",
                0,
                self.deployment_id,
                self.artifact_digest,
            )


if __name__ == "__main__":
    unittest.main()
