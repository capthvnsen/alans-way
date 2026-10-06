// Inference worker for the voice view: Moonshine ASR (speech → text) and
// Kokoro TTS (text → audio chunks) on onnxruntime-web WASM. Models download
// from Hugging Face on first use and persist in the Cache API.
import { pipeline, env } from '@huggingface/transformers';
import { KokoroTTS, TextSplitterStream } from 'kokoro-js';

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = `${self.location.origin}/ort/`;
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, self.navigator.hardwareConcurrency || 4) : 1;
env.backends.onnx.wasm.proxy = false;

const post = (message, transfer = []) => self.postMessage(message, transfer);

let asr = null, asrModel = '';
let tts = null;
let settings = { sttModel: 'onnx-community/moonshine-base-ONNX', ttsVoice: 'af_heart' };
let generation = 0;             // bumped on cancel — stale loops drop their output
let queue = Promise.resolve();  // one inference at a time: STT or TTS

const progressFor = (stage) => (info) => post({ type: 'progress', stage, detail: { file: info.file, progress: info.progress, status: info.status } });

async function loadAsr() {
  if (asr && asrModel === settings.sttModel) return asr;
  post({ type: 'progress', stage: 'stt', detail: { status: 'initiate', file: settings.sttModel } });
  asr = await pipeline('automatic-speech-recognition', settings.sttModel, {
    dtype: 'q8', device: 'wasm', progress_callback: progressFor('stt'),
  });
  asrModel = settings.sttModel;
  return asr;
}

async function loadTts() {
  if (tts) return tts;
  post({ type: 'progress', stage: 'tts', detail: { status: 'initiate', file: 'kokoro' } });
  tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-ONNX', {
    dtype: 'q8', device: 'wasm', progress_callback: progressFor('tts'),
  });
  return tts;
}

async function transcribe(id, pcm) {
  const model = await loadAsr();
  const output = await model(pcm);
  const text = Array.isArray(output) ? output.map((part) => part?.text || '').join(' ') : output?.text || '';
  post({ type: 'transcript', id, text: text.trim() });
}

async function speak(job, text, voice, speed) {
  const engine = await loadTts();
  const splitter = new TextSplitterStream();
  splitter.push(text);
  splitter.close();
  const myGeneration = generation;
  for await (const chunk of engine.stream(splitter, { voice, speed })) {
    if (myGeneration !== generation) return;
    const pcm = chunk.audio?.audio;
    if (!pcm?.length) continue;
    const out = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
    post({ type: 'audio', job, pcm: out, rate: chunk.audio.sampling_rate }, [out]);
  }
  post({ type: 'speak-done', job });
}

function enqueue(task) {
  queue = queue.then(task).catch((error) => post({ type: 'error', message: error.message || String(error) }));
  return queue;
}

self.onmessage = (event) => {
  const message = event.data || {};
  switch (message.type) {
    case 'init':
      if (message.sttModel) settings.sttModel = message.sttModel;
      if (message.ttsVoice) settings.ttsVoice = message.ttsVoice;
      enqueue(async () => {
        await loadAsr(); await loadTts();
        post({ type: 'ready' });
      });
      break;
    case 'update-models': {
      const sttChanged = message.sttModel && message.sttModel !== settings.sttModel;
      if (message.sttModel) settings.sttModel = message.sttModel;
      if (message.ttsVoice) settings.ttsVoice = message.ttsVoice;
      if (sttChanged) enqueue(async () => { asr = null; await loadAsr(); post({ type: 'ready' }); });
      break;
    }
    case 'transcribe':
      enqueue(() => transcribe(message.id, new Float32Array(message.pcm)));
      break;
    case 'speak': {
      const gen = generation;
      enqueue(() => (gen === generation ? speak(message.job, message.text, message.voice || settings.ttsVoice, message.speed || 1) : Promise.resolve()));
      break;
    }
    case 'cancel':
      generation++;
      break;
  }
};
