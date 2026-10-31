import importlib.util
from pathlib import Path
import unittest

_spec = importlib.util.spec_from_file_location('browser_egress', Path(__file__).parents[1] / 'scripts/browser_egress.py')
egress = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(egress)


class BrowserEgressTests(unittest.TestCase):
    def test_distinct_users_and_bounded_port(self):
        for values in [(0, 1), (1, 1), (-1, 2), ('1', 2)]:
            with self.assertRaises(ValueError):
                egress.rules(*values)
        with self.assertRaises(ValueError):
            egress.rules(1001, 1002, 0)

    def test_private_ranges_and_cdp_reply_are_explicit(self):
        rules = egress.rules(1001, 1002)
        for value in ['10.0.0.0/8', '100.64.0.0/10', '169.254.0.0/16', 'ip6 daddr != 2000::/3', 'ct direction reply', 'meta skuid != 1002']:
            self.assertIn(value, rules)
        self.assertNotIn('ct state established accept', rules)
        self.assertNotIn('flush ruleset', rules)
        self.assertIn('Before=alan-browser.service', egress.unit())
