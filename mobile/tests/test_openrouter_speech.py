import base64
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from mobile.voice.openrouter_speech import OpenRouterSpeech


class OpenRouterSpeechTests(unittest.TestCase):
    def setUp(self):
        self.requests = []
        requests = self.requests
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                requests.append((self.path, self.headers.get('Authorization'), body))
                if body.get('model') == 'fail-model':
                    self.send_response(402); self.end_headers(); self.wfile.write(b'{"error":"private-provider-error"}'); return
                self.send_response(200)
                self.send_header('Content-Type', 'audio/mpeg' if self.path.endswith('/speech') else 'application/json')
                self.end_headers()
                self.wfile.write(b'fixture-audio' if self.path.endswith('/speech') else b'{"text":"The test word is apricot."}')
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.temp = tempfile.TemporaryDirectory()
        self.client = OpenRouterSpeech(lambda: 'profile-key', base_url=f'http://127.0.0.1:{self.server.server_port}/api/v1')

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.temp.cleanup()

    def test_budget_tts_and_stt_use_scoped_key_and_real_http_contract(self):
        output = Path(self.temp.name)/'reply.mp3'
        self.assertEqual(self.client.synthesize('The test word is apricot.', str(output)), str(output))
        self.assertEqual(output.read_bytes(), b'fixture-audio')
        result = self.client.transcribe(str(output))
        self.assertTrue(result['success'])
        self.assertIn('apricot', result['transcript'])
        self.assertEqual(self.requests[0][0], '/api/v1/audio/speech')
        self.assertEqual(self.requests[0][1], 'Bearer profile-key')
        self.assertEqual(self.requests[0][2]['model'], 'canopylabs/orpheus-3b-0.1-ft')
        self.assertEqual(self.requests[0][2]['voice'], 'leo')
        self.assertEqual(self.requests[1][0], '/api/v1/audio/transcriptions')
        self.assertEqual(self.requests[1][2]['model'], 'openai/whisper-large-v3-turbo')
        self.assertEqual(self.requests[1][2]['input_audio'], {'data': base64.b64encode(b'fixture-audio').decode(), 'format': 'mp3'})

    def test_explicit_hermes_settings_are_forwarded_and_provider_failures_are_redacted(self):
        output = str(Path(self.temp.name)/'reply.wav')
        self.client.synthesize('hello', output, model='other-model', voice='am_adam', format='wav', speed=1.1)
        self.assertEqual(self.requests[0][2]['response_format'], 'wav')
        self.assertEqual(self.requests[0][2]['speed'], 1.1)
        result = self.client.transcribe(output, model='fail-model')
        self.assertFalse(result['success'])
        self.assertIn('402', result['error'])
        self.assertNotIn('private-provider-error', result['error'])
        self.assertNotIn('profile-key', result['error'])
        with self.assertRaisesRegex(RuntimeError, '402'):
            self.client.synthesize('hello', output, model='fail-model')

    def test_missing_key_fails_without_network_request(self):
        client = OpenRouterSpeech(lambda: '')
        with self.assertRaisesRegex(RuntimeError, 'OPENROUTER_API_KEY'):
            client.synthesize('hello', str(Path(self.temp.name)/'reply.mp3'))
        self.assertEqual(self.requests, [])
