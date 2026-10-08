"""The agent setup prompt is copied into the README; both must stay in step with the scripts."""
from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


def prompt_block(path):
    return re.search(r"```text\n(.*?)\n```", (ROOT / path).read_text(encoding="utf-8"), re.S).group(1)


class SetupPromptTests(unittest.TestCase):
    def test_readme_prompt_points_at_the_full_instructions(self):
        short = prompt_block("README.md")
        self.assertIn("https://github.com/capthvnsen/alans-way", short)
        self.assertIn("https://raw.githubusercontent.com/capthvnsen/alans-way/main/docs/setup-prompt.md", short)
        self.assertLess(len(short), 500)
        full = prompt_block("docs/setup-prompt.md")
        self.assertIn("connect-mac.sh", full)
        self.assertGreater(len(full), 2000)

    def test_no_doc_installs_a_standalone_workspace_skill(self):
        # Hermes resolves a bare skill name from the user skills directory first, so
        # a standalone workspace-operations copy shadows the plugin's skill and drifts.
        for path in [*ROOT.glob("*.md"), *(ROOT / "docs").rglob("*.md"), *(ROOT / "desktop" / "docs").rglob("*.md")]:
            text = " ".join(path.read_text(encoding="utf-8").split())
            with self.subTest(path=path.name):
                self.assertNotRegex(text, r"[Ii]nstall the repository's `workspace-operations` skill in the profile")

    def test_connect_mac_flags_in_the_prompt_exist(self):
        prompt = prompt_block("docs/setup-prompt.md")
        line = next(item for item in prompt.splitlines() if "connect-mac.sh" in item)
        script = (ROOT / "scripts" / "connect-mac.sh").read_text(encoding="utf-8")
        for flag in re.findall(r"--[a-z-]+", line.split("sh -s --", 1)[1]):
            self.assertIn(f"    {flag})", script, f"{flag} is not parsed by connect-mac.sh")

    def test_prompt_downloads_scripts_that_exist_here(self):
        prompt = prompt_block("docs/setup-prompt.md")
        for path in re.findall(r"raw\.githubusercontent\.com/capthvnsen/alans-way/main/(\S+)", prompt):
            self.assertTrue((ROOT / path).is_file(), path)

    def test_mac_scripts_parse(self):
        for name in ("connect-mac.sh", "install-mac.sh"):
            subprocess.run(["sh", "-n", str(ROOT / "scripts" / name)], check=True)


if __name__ == "__main__":
    unittest.main()
