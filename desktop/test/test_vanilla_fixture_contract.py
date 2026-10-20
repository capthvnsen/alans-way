"""Actual inert model-handler HTTP contract; no Hermes or browser is launched."""
import ast
import copy
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import time
import traceback
import types
import unittest
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


SOURCE = Path(__file__).with_name("vanilla-hermes-approval.py")
NAMES = ["mcp__workspace_browser__" + name for name in (
    "cua_alans_way_status", "cua_alans_way_tabs", "cua_alans_way_open",
    "cua_alans_way_snapshot", "cua_alans_way_action")]


def declaration(name):
    return {"type": "function", "function": {
        "name": name, "parameters": {"type": "object"}}}


class VanillaFixtureDeclarationTests(unittest.TestCase):
    def setUp(self):
        tree = ast.parse(SOURCE.read_text())
        definitions = [node for node in tree.body
                       if isinstance(node, (ast.FunctionDef, ast.ClassDef))
                       and node.name in ("body_object", "Model")]
        self.assertEqual(len(definitions), 2)
        self.namespace = dict(json=json, re=re, time=time, traceback=traceback,
                              BaseHTTPRequestHandler=BaseHTTPRequestHandler,
                              a=types.SimpleNamespace(tool_search="off"),
                              lock=threading.RLock(), model_log=[], tools_seen=[], declaration_checks=[],
                              current={}, errors=[], dump=lambda *_: None,
                              web=types.SimpleNamespace(server_port=9))
        exec(compile(ast.Module(body=definitions, type_ignores=[]), str(SOURCE), "exec"), self.namespace)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), self.namespace["Model"])
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.01), daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)
        self.assertFalse(self.thread.is_alive(), "Owned model HTTP thread must exit")

    def request(self, value):
        connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=2)
        try:
            connection.request("POST", "/v1/chat/completions", json.dumps(value),
                               {"Content-Type": "application/json"})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def scenario(self, later=False):
        messages = [{"role": "system", "content": "Inert scenario transport."},
                    {"role": "user", "content": "FIXTURE approve"}]
        if later:
            messages.extend({"role": "tool", "tool_call_id": str(n), "content": "{}"} for n in range(2))
            messages.append({"role": "tool", "tool_call_id": "snapshot", "content": json.dumps({
                "epoch": 1, "elements": [{"ref": "buy", "name": "Buy local test item"}]})})
            self.namespace["current"]["approve"] = {"tabId": "owned-inert-tab", "epoch": 1}
        return {"messages": messages, "tools": [declaration(name) for name in NAMES]}

    def prime(self):
        status, body = self.request(self.scenario())
        self.assertEqual(status, 200)
        self.assertEqual(self.calls(body), [NAMES[0]])

    @staticmethod
    def calls(body):
        return [call["function"]["name"] for call in
                body.get("choices", [{}])[0].get("message", {}).get("tool_calls", [])]

    def test_valid_later_declarations_still_select_the_advertised_action(self):
        self.prime()
        status, body = self.request(self.scenario(later=True))
        self.assertEqual(status, 200)
        self.assertEqual(self.calls(body), [NAMES[-1]])

    def queue_to_actions(self, scenario="queue"):
        request = self.scenario()
        request["messages"][-1]["content"] = "FIXTURE " + scenario
        results = [{}, {"tab": {"id": "tab-a", "epoch": 1}},
                   {"epoch": 1, "elements": [{"ref": "buy-a", "name": "Buy local test item"}]},
                   {"tab": {"id": "tab-b", "epoch": 2}},
                   {"epoch": 2, "elements": [{"ref": "buy-b", "name": "Buy local test item"}]}]
        for expected, result in zip((NAMES[0], NAMES[2], NAMES[3], NAMES[2], NAMES[3]), results):
            status, body = self.request(request)
            self.assertEqual(status, 200)
            self.assertEqual(self.calls(body), [expected])
            message = body["choices"][0]["message"]
            request["messages"].extend([message, {"role": "tool", "tool_call_id": message["tool_calls"][0]["id"],
                                                  "content": json.dumps(result)}])
        return request

    def test_queue_emits_two_distinct_reviewed_actions_in_one_public_response(self):
        status, body = self.request(self.queue_to_actions())
        self.assertEqual(status, 200)
        self.assertEqual(self.calls(body), [NAMES[-1], NAMES[-1]])
        calls = body["choices"][0]["message"]["tool_calls"]
        self.assertEqual(len({call["id"] for call in calls}), 2)
        actions = [json.loads(call["function"]["arguments"]) for call in calls]
        self.assertEqual([(item["tabId"], item["epoch"], item["ref"]) for item in actions],
                         [("tab-a", 1, "buy-a"), ("tab-b", 2, "buy-b")])
        self.assertIn("queuea", actions[0]["commit"]["summary"])
        self.assertIn("queueb", actions[1]["commit"]["summary"])

    def test_queue_validates_action_and_final_request_declarations_and_never_repeats(self):
        request = self.queue_to_actions()
        invalid = copy.deepcopy(request)
        invalid["tools"] = [declaration("tool_call")]
        self.assertEqual(self.request(invalid)[0], 500)
        status, body = self.request(request)
        self.assertEqual(status, 200)
        message = body["choices"][0]["message"]
        request["messages"].append(message)
        # Result order may differ from action order. Binding uses tool_call_id.
        for call, result in zip(reversed(message["tool_calls"]), ({"error": "declined"}, {"ok": True})):
            request["messages"].append({"role": "tool", "tool_call_id": call["id"], "content": json.dumps(result)})
        invalid = copy.deepcopy(request)
        invalid["tools"] = []
        self.assertEqual(self.request(invalid)[0], 500)
        status, body = self.request(request)
        self.assertEqual(status, 200)
        self.assertEqual(self.calls(body), [])
        self.assertEqual(self.namespace["current"]["queue"]["results"], [{"ok": True}, {"error": "declined"}])

    def test_later_contradictions_fail_before_selecting_any_tool(self):
        self.prime()
        for invalid in ([declaration(name) for name in NAMES] + [declaration("tool_call")],
                        [declaration("tool_search")], [], None):
            with self.subTest(declarations=invalid):
                request = self.scenario(later=True)
                request["tools"] = copy.deepcopy(invalid)
                status, body = self.request(request)
                self.assertEqual(status, 500, "Every scenario request must validate its current declarations")
                self.assertEqual(self.calls(body), [])

    def test_missing_declarations_fail_for_initial_and_later_scenarios(self):
        for later in (False, True):
            with self.subTest(later=later):
                request = self.scenario(later=later)
                del request["tools"]
                status, body = self.request(request)
                self.assertEqual(status, 500)
                self.assertEqual(self.calls(body), [])

    def test_public_title_request_can_quote_the_scenario_without_tools(self):
        request = {"messages": [
            {"role": "system", "content": "You name chat sessions. Given the user's opening message, write a title."},
            {"role": "user", "content": "FIXTURE approve"}]}
        status, body = self.request(request)
        self.assertEqual(status, 200)
        self.assertEqual(self.calls(body), [])
        self.assertEqual(body["choices"][0]["finish_reason"], "stop")

    def test_non_scenario_ancillary_request_emits_no_tool(self):
        status, body = self.request({"messages": [{"role": "user", "content": "Name this inert conversation."}]})
        self.assertEqual(status, 200)
        self.assertEqual(self.calls(body), [])


class VanillaFixtureObserverTests(unittest.TestCase):
    def test_public_stdio_observation_preserves_bytes_and_ids(self):
        tree = ast.parse(SOURCE.read_text())
        observer = next(ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign)
                        and any(isinstance(t, ast.Name) and t.id == "MCP_OBSERVER" for t in node.targets))
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node is required by the optional public MCP fixture")
        payload = b'{"jsonrpc":"2.0","id":"one","method":"tools/list"}\n' + json.dumps(
            {"jsonrpc": "2.0", "id": "two", "result": {"text": "Consent ✓"}}, ensure_ascii=False).encode() + b'\n'
        with tempfile.TemporaryDirectory(prefix="vanilla-mcp-observer-") as directory:
            script, log = Path(directory) / "observer.cjs", Path(directory) / "wire.jsonl"
            script.write_text(observer)
            process = subprocess.Popen([node, str(script), str(log), node, "-e", "process.stdin.pipe(process.stdout)"],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                stdout, stderr = process.communicate(payload, timeout=5)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(5)
            self.assertEqual(process.returncode, 0, stderr)
            self.assertEqual(stdout, payload, "The observer must forward exact bytes")
            rows = [json.loads(line) for line in log.read_text().splitlines()]
            for direction in ("client-to-router", "router-to-client"):
                observed = [json.loads(row["line"]) for row in rows if row["direction"] == direction]
                self.assertEqual([value["id"] for value in observed], ["one", "two"])
                self.assertEqual(observed[-1]["result"]["text"], "Consent ✓")
            self.assertEqual([row["seq"] for row in rows], list(range(1, 5)))


class VanillaFixtureWireTests(unittest.TestCase):
    def test_overlapping_wire_binding_uses_action_summary_and_exact_scenario(self):
        # Synthetic observer-unit input only; the real public runtime serializes.
        def row(seq, direction, message):
            return {"seq": seq, "at": seq, "direction": direction, "message": message}
        def call(identifier, label):
            return {"id": identifier, "method": "tools/call", "params": {
                "name": "cua_alans_way_action", "arguments": {
                    "commit": {"summary": "Local " + label + " test item; no real purchase"}}}}
        def elicit(identifier, label):
            return {"id": identifier, "method": "elicitation/create", "params": {
                "message": "Review: Local " + label + " test item; no real purchase"}}
        rows = [row(1, "client-to-router", call(10, "queuea")),
                row(2, "client-to-router", call(20, "queueb")),
                row(3, "router-to-client", elicit("approval-a", "queuea")),
                row(4, "router-to-client", elicit("approval-b", "queueb")),
                row(5, "client-to-router", {"id": "approval-a", "result": {"action": "accept"}}),
                row(6, "router-to-client", {"id": 10, "result": {}}),
                row(7, "client-to-router", call(30, "queuestalea")),
                row(8, "router-to-client", elicit("unrelated", "queuestalea"))]
        definition = next(n for n in ast.parse(SOURCE.read_text()).body
                          if isinstance(n, ast.FunctionDef) and n.name == "queue_evidence")
        namespace = {"json": json, "mcp_trace": lambda: rows}
        exec(compile(ast.Module(body=[definition], type_ignores=[]), str(SOURCE), "exec"), namespace)
        evidence = namespace["queue_evidence"]("queue", 0)
        self.assertEqual([r["toolCallId"] for r in evidence["binding"]], [10, 20])
        self.assertEqual(evidence["pendingIds"], ["approval-b"])
        self.assertEqual(len(evidence["actionCalls"]), 2)


class VanillaFixturePromptTests(unittest.TestCase):
    def wait(self, redraw, **kwargs):
        definition = next(n for n in ast.parse(SOURCE.read_text()).body
                          if isinstance(n, ast.FunctionDef) and n.name == "wait_text")
        namespace = {"time": time, "pump": lambda *_: None, "plain": lambda *_: redraw,
                     "errors": [], "current": {}, "json": json,
                     "child": types.SimpleNamespace(poll=lambda: None)}
        exec(compile(ast.Module(body=[definition], type_ignores=[]), str(SOURCE), "exec"), namespace)
        return namespace["wait_text"]("Allow once", seconds=0.1, **kwargs)

    def test_real_differential_redraw_can_identify_target_by_its_intact_review_url(self):
        # Redacted excerpt of failed public output (loopback port normalized),
        # not a reconstructed screen.
        redraw = ('Local fixtur wants to buy: Local queuedeclinb test itm; no real purchse '
                  'Review page: http://127.0.0.1:9/review/queuedeclineb; '
                  'destination: http://127.0.0.1:9/pay/queuedeclineb.▸ 1. Allow once')
        self.wait(redraw, required=("Local queuedeclineb test item", "/review/queuedeclineb"))

    def test_stale_redraw_prompt_cannot_authorize_a_choice_after_settlement(self):
        with self.assertRaisesRegex(RuntimeError, "settled"):
            self.wait("Allow once Local queueb test item MODEL_FIXTURE_DONE queue",
                      required="Local queueb test item", settled_marker="MODEL_FIXTURE_DONE queue")


if __name__ == "__main__":
    unittest.main()
