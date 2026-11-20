"""The tests workflow's path filter and required-check gate."""
import importlib.util
from pathlib import Path
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


changes, gate = load("ci_changes"), load("ci_gate")
JOBS = ("desktop", "desktop-electron", "desktop-windows", "package-and-test")


def needs(changed="true", **results):
    base = {"changes": {"result": "success", "outputs": {"desktop": changed}}}
    base.update({job: {"result": results.get(job.replace("-", "_"), "success")} for job in JOBS})
    return base


class ChangesTests(unittest.TestCase):
    def test_only_ios_paths_skip_the_desktop_family(self):
        self.assertFalse(changes.desktop_affected(["ios/AlanWorkspace/Gateway/State.swift\n", "ios/project.yml\n"]))

    def test_anything_else_or_nothing_runs_everything(self):
        for paths in ([], ["\n"], ["desktop/src/main.cjs"], ["docs/setup-prompt.md"], ["README.md"],
                      ["ios/a.swift", "scripts/check_publication.py"], ["iosx/a"], [".github/workflows/tests.yml"]):
            self.assertTrue(changes.desktop_affected(paths), paths)


class GateTests(unittest.TestCase):
    def test_all_success_passes(self):
        self.assertEqual(gate.problems(needs()), [])

    def test_failed_or_cancelled_job_fails(self):
        for result in ("failure", "cancelled"):
            self.assertEqual(gate.problems(needs(desktop_electron=result)), [f"desktop-electron: {result}"])

    def test_skip_is_allowed_only_when_changes_says_so(self):
        skipped = dict(desktop="skipped", desktop_electron="skipped", desktop_windows="skipped")
        self.assertEqual(gate.problems(needs("false", **skipped)), [])
        self.assertEqual(len(gate.problems(needs("true", **skipped))), 3)

    def test_skip_does_not_excuse_a_failure_elsewhere_or_the_python_job(self):
        self.assertEqual(gate.problems(needs("false", desktop="skipped", package_and_test="failure")),
                         ["package-and-test: failure"])
        self.assertEqual(gate.problems(needs("false", package_and_test="skipped")), ["package-and-test: skipped"])

    def test_a_failed_changes_job_never_lets_skips_through(self):
        broken = needs("false", desktop="skipped")
        broken["changes"]["result"] = "failure"
        self.assertEqual(gate.problems(broken), ["changes: failure", "desktop: skipped"])


if __name__ == "__main__":
    unittest.main()
