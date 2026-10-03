"""Offline content contracts, not runtime/model/delivery certification."""
from pathlib import Path
import ast
import json
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "plugins" / "proactive-primary" / "skills" / "proactive-primary" / "SKILL.md"
DOCS = ROOT / "docs" / "proactivity.md"


class ProactiveSkillTests(unittest.TestCase):
    def skill(self):
        self.assertTrue(SKILL.is_file(), "The plugin-bundled task skill must exist")
        return SKILL.read_text(encoding="utf-8")

    def test_chat_adjustments_use_durable_explicit_controls_with_readback(self):
        content = self.skill()
        calls = re.findall(r'proactive_control\(action="([a-z_]+)"', content)
        self.assertTrue({"status", "pause", "resume", "configure", "review"}.issubset(calls))
        for requirement in (
            "quiet_start", "quiet_end", "max_daily_wakes", "min_interval_seconds",
            "$HERMES_HOME/companion/proactivity", "ordinary chat", "priorities",
            "schema", "read back", "survives restart", "general memory",
            "Never automatically resume", "unsupported", "/proactivity",
            "proactive-primary:proactive-primary",
        ):
            with self.subTest(requirement=requirement):
                self.assertTrue(requirement in " ".join(content.split()), f"Missing contract: {requirement}")

    def test_review_is_ordered_evidence_backed_and_owner_routed(self):
        content = self.skill()
        self.assertIn("## Procedure", content)
        headings = re.findall(r"(?m)^\d+\. \*\*([^*]+)\*\*", content)
        self.assertEqual(headings, [
            "Load live policy.", "Inspect relevant evidence.", "Resolve ownership.",
            "Choose one useful outcome.", "Execute one bounded chunk.",
            "Record, verify, and route.",
        ])
        for requirement in (
            "native memory", "schedule", "goals", "approved tasks", "evidence reference",
            "why now", "exact profile and session key", "bound primary lane",
            "existing delegation", "another owner", "no-op", "20 minutes",
            "cronjob", "session_search", "Kanban", "No calendar connector",
            "record_task", "finish_task", "artifact", "verification", "next action",
        ):
            with self.subTest(requirement=requirement):
                self.assertTrue(requirement in " ".join(content.split()), f"Missing contract: {requirement}")
        self.assertNotIn("## Routing Table", content)

    def test_specialist_followup_is_finite_and_does_not_start_a_ping_loop(self):
        content = self.skill()
        self.assertIn("## Specialist Follow-up", content)
        for requirement in (
            "delegate_task", "finite independent", "existing owner", "task ID",
            "result summary", "verify the artifact", "awaiting approval",
            "no recursive delegation", "no polling loop", "no re-delegation",
            "same unchanged checkpoint", "own ledger writes", "replace the primary",
        ):
            with self.subTest(requirement=requirement):
                self.assertTrue(requirement in " ".join(content.split()), f"Missing contract: {requirement}")

    def test_automatic_wakes_are_event_driven_silent_and_ceiling_limited(self):
        content = self.skill()
        self.assertIn("## Silence and Budgets", content)
        for requirement in (
            "22:00–08:00", "America/Denver", "at most 3", "at most 1",
            "within the total", "upper limits, not quotas", "Zero events means zero model turns",
            "No always-on AI loop", "no native cron", "no catch-up filler",
            "paused", "cancelled", "uncertain queued wake", "Never retry",
            "acceptance is not turn completion or platform delivery",
        ):
            with self.subTest(requirement=requirement):
                self.assertTrue(requirement in " ".join(content.split()), f"Missing contract: {requirement}")

    def test_approval_and_privacy_boundaries_are_explicit_not_a_sandbox_claim(self):
        content = self.skill()
        self.assertIn("## Safety Boundaries", content)
        for requirement in (
            "Ask before", "external messages/posts", "purchases", "credentials/permissions",
            "production changes", "destructive actions", "new scopes", "third-party",
            "secrets", "other profiles", "raw specialist-chat", "not a sandbox",
            "Native broad tools", "native core", "## Pitfalls", "## Verification",
        ):
            with self.subTest(requirement=requirement):
                self.assertTrue(requirement in " ".join(content.split()), f"Missing contract: {requirement}")

    def test_public_docs_explain_reviewable_install_binding_and_limits(self):
        self.assertTrue(DOCS.is_file(), "A concise public proactivity guide must exist")
        content = DOCS.read_text(encoding="utf-8")
        for requirement in (
            "$HERMES_HOME/plugins/proactive-primary", "hermes plugins enable proactive-primary",
            "plugins:", "enabled:", "entries:", "allow_gateway_injection: true",
            "fragment", "Do not replace", "existing", "session_key", "default",
            "proactive-primary:proactive-primary", "/proactivity", "proactive_control",
            "$HERMES_HOME/companion/proactivity", "22:00–08:00", "America/Denver",
            "upper limits, not quotas", "zero model turns", "not a sandbox",
            "acceptance is not turn completion or platform delivery", "Do not retry",
            "Mac/phone", "Content tests", "test_proactive_skill.py",
        ):
            with self.subTest(requirement=requirement):
                self.assertTrue(requirement in " ".join(content.split()), f"Missing contract: {requirement}")
        self.assertLessEqual(len(content), 12_000, "Keep the public guide concise")

    def test_native_startup_hook_is_separate_trusted_optin_not_cli_dispatch(self):
        self.assertTrue(DOCS.is_file())
        for path in (SKILL, DOCS):
            content = " ".join(path.read_text(encoding="utf-8").split())
            for requirement in (
                "gateway:startup", "HOOK.yaml", "handler.py", "trusted by placement",
                "plugins.enabled", "gateway-owner.json", "CLI/doctor", "pre_gateway_dispatch",
                "before authentication", "no automatic retarget",
            ):
                with self.subTest(path=path.name, requirement=requirement):
                    self.assertTrue(requirement in content, f"Missing contract: {requirement}")

    def test_documented_frontend_commands_and_tool_examples_are_actionable(self):
        for path in (SKILL, DOCS):
            content = path.read_text(encoding="utf-8")
            for action in ("status", "pause", "resume", "review"):
                with self.subTest(path=path.name, action=action):
                    self.assertTrue(f"/proactivity {action}" in content,
                                    f"Missing frontend command: {action}")
            configure = re.findall(r'/proactivity configure (\{[^`\n]+\})', content)
            self.assertTrue(configure, "Show an actual configure JSON command")
            for payload in configure:
                self.assertIsInstance(json.loads(payload), dict)
            examples = re.findall(r"```python\n(.*?)\n```", content, re.DOTALL)
            self.assertTrue(examples, "Show literal Hermes tool invocations")
            for example in examples:
                tree = ast.parse(example)
                for statement in tree.body:
                    self.assertIsInstance(statement, ast.Expr)
                    call = statement.value
                    self.assertIsInstance(call, ast.Call)
                    self.assertIsInstance(call.func, ast.Name)
                    self.assertEqual(call.func.id, "proactive_control")
                    self.assertFalse(call.args, "Use explicit tool keyword arguments")
                    arguments = {kw.arg: ast.literal_eval(kw.value) for kw in call.keywords}
                    self.assertIn(arguments["action"], {
                        "status", "pause", "resume", "configure", "review",
                        "record_task", "finish_task",
                    })
                    if arguments["action"] == "configure":
                        self.assertIsInstance(arguments["settings"], dict)
                        self.assertTrue(arguments["settings"], "An empty change is not an example")

    def test_consent_is_rechecked_at_action_and_reporting_boundaries(self):
        content = " ".join(self.skill().split())
        self.assertTrue("Recheck live policy and task consent before work and before reporting" in content)
        self.assertTrue("Stop immediately if paused, cancelled, or awaiting approval" in content)
        self.assertTrue("without creating a task" in content)

    def test_frontmatter_is_a_portable_human_credited_skill_contract(self):
        content = self.skill()
        self.assertTrue(content.startswith("---\n"))
        frontmatter, separator, body = content[4:].partition("\n---\n")
        self.assertTrue(separator, "Frontmatter must close before the body")
        self.assertTrue(body.strip(), "The skill must have an actionable body")
        fields = dict(re.findall(r"^([a-z_]+): (.+)$", frontmatter, re.MULTILINE))
        self.assertEqual(fields["name"], "proactive-primary")
        self.assertRegex(fields["name"], r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
        self.assertLessEqual(len(fields["name"]), 64)
        description = json.loads(fields["description"])
        self.assertIsInstance(description, str)
        self.assertTrue(description.strip())
        self.assertLessEqual(len(description), 60)
        self.assertTrue(description.endswith("."))
        self.assertEqual(description.count("."), 1)
        self.assertNotIn(fields["name"], description.casefold())
        self.assertRegex(fields["version"], r"^\d+\.\d+\.\d+$")
        self.assertEqual(fields["author"], "Alex (capthvnsen), Hermes Agent")
        self.assertEqual(fields["license"], "MIT")
        self.assertEqual(fields["platforms"], "[linux, macos]")
        self.assertRegex(frontmatter, r"(?m)^metadata:\n  hermes:\n")
        self.assertRegex(frontmatter, r"(?m)^    tags: \[[^\n]+\]$")
        self.assertRegex(frontmatter, r"(?m)^    related_skills: \[\]$")
        self.assertLessEqual(len(content), 100_000)


if __name__ == "__main__":
    unittest.main()
