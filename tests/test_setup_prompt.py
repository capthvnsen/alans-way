"""Agent prompts bootstrap Hermes' plugin and delegate setup to its installed skill."""
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

    def test_prompts_delegate_to_the_installed_setup_skill(self):
        for path in ("docs/setup-prompt.md", "docs/update-for-agents.md"):
            prompt = prompt_block(path)
            with self.subTest(path=path):
                self.assertIn("installed workspace-setup skill", prompt)
                self.assertIn("--repo-ref", prompt)
                self.assertIn("--desktop-ref", prompt)
                self.assertIn("--skip-plugin", prompt)
                self.assertNotRegex(prompt, r"git[^\n]*(?:clone|pull)")
                self.assertNotRegex(prompt, r"(?m)^\s*[^\n]*setup\.sh --")
                self.assertNotIn("~/.ssh/authorized_keys", prompt)

    def test_setup_loads_the_registered_plugin_skill_before_proceeding(self):
        source = (ROOT / "docs/setup-prompt.md").read_text(encoding="utf-8")
        prompts = re.findall(r"```text\n(.*?)\n```", source, re.S)
        self.assertEqual(len(prompts), 2, "full instructions and clipboard handoff")
        for index, block in enumerate(prompts):
            prompt = " ".join(block.split())
            for instruction in (
                'skill_view(name="alans-way:workspace-setup")',
                'alans-way/skills/workspace-setup/SKILL.md',
                'Follow it verbatim',
                'Never create or write your own setup skill',
                'Do not fetch other setup guides',
            ):
                with self.subTest(block=index, instruction=instruction):
                    self.assertIn(instruction, prompt)
            self.assertLess(prompt.index('plugins install alans-way'), prompt.index('skill_view('))

    def test_prompts_keep_the_human_handoffs_and_connection_checks(self):
        for doc in ("docs/setup-prompt.md", "docs/update-for-agents.md"):
            prompt = " ".join(prompt_block(doc).split())
            for checkpoint in ("QR", "Tailscale", "Remote Login", "Accessibility",
                               "Screen Recording", "Test agent path", "Example Domain"):
                with self.subTest(doc=doc, checkpoint=checkpoint):
                    self.assertIn(checkpoint, prompt)

    def test_setup_respects_the_gateway_lifecycle_boundary(self):
        source = (ROOT / "docs/setup-prompt.md").read_text(encoding="utf-8")
        for index, block in enumerate(re.findall(r"```text\n(.*?)\n```", source, re.S)):
            prompt = " ".join(block.split())
            with self.subTest(block=index):
                self.assertNotIn("running setup from inside this gateway is supported", prompt)
                self.assertIn("Never bypass the lifecycle guard", prompt)
                self.assertIn("outside the gateway", prompt)
                self.assertIn("post-restart audit", prompt)

    def test_both_setup_prompts_stop_on_incomplete_guide_extraction(self):
        source = (ROOT / "docs/setup-prompt.md").read_text(encoding="utf-8")
        for index, block in enumerate(re.findall(r"```text\n(.*?)\n```", source, re.S)):
            prompt = " ".join(block.split())
            with self.subTest(block=index):
                self.assertIn("If web extraction of a guide fails, has gaps or is incomplete, stop and report it", prompt)
                self.assertIn("Do not continue setup or fill in missing instructions", prompt)

    def test_mac_scripts_parse(self):
        for name in ("connect-mac.sh", "install-mac.sh"):
            subprocess.run(["sh", "-n", str(ROOT / "scripts" / name)], check=True)

    def test_fresh_app_install_distinguishes_release_from_connector_pin(self):
        prompt = " ".join(prompt_block("docs/setup-prompt.md").split())
        for detail in ("latest published app release", "releases/latest", "--skip-install",
                       "-SkipInstall", "source-build installers", "main",
                       "not pinned to the skill's desktop revision", "release asset is unavailable"):
            with self.subTest(detail=detail):
                self.assertIn(detail, prompt)
        self.assertNotIn("any install/build dependencies resolved to the reviewed desktop pin", prompt)


if __name__ == "__main__":
    unittest.main()
