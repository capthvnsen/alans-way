// The voice view's page: owns the microphone (Silero VAD) and the speaker
// (AudioContext playback). All inference lives in voice-worker.js. Only text
// and control events cross to main — no audio ever leaves this view.
import { MicVAD } from '@ricky0123/vad-web';

const emit = (event) => window.voiceBridge.emit(event);
const ORIGIN = location.origin;

let vad = null, worker = null;
let inputGated = true;          // hard gate: drop VAD events while the bot speaks or nobody asked for the mic
let audioCtx = null;
let playUntil = 0;
const playing = new Set();
let expectedJob = 0;            // jobs speak in order; stale chunks die here
let latestIssuedJob = 0;        // highest job id main has asked us to speak
let activeJobs = new Map();     // job -> {chunks, done}
let utteranceSeq = 0;
let transcribeInflight = 0;

// ---------- microphone / VAD ----------
async function ensureVad() {
  if (vad) return vad;
  vad = await MicVAD.new({
    baseAssetPath: `${ORIGIN}/vad/`,
    onnxWASMBasePath: `${ORIGIN}/ort-vad/`,
    model: 'v5',
    startOnLoad: false,
    positiveSpeechThreshold: 0.6,
    minSpeechMs: 250,
    redemptionMs: 700,
    preSpeechPadMs: 250,
    getStream: () => navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false } }),
    pauseStream: async (stream) => { stream.getTracks().forEach((track) => track.stop()); },
    resumeStream: () => navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false } }),
    onSpeechStart: () => { if (!inputGated) emit({ type: 'speech-start' }); },
    onSpeechEnd: (audio) => {
      if (inputGated || !worker) return;
      const id = ++utteranceSeq;
      transcribeInflight++;
      emit({ type: 'transcribing' });
      // The worker takes ownership of the buffer.
      worker.postMessage({ type: 'transcribe', id, pcm: audio }, [audio.buffer]);
    },
    onVADMisfire: () => {},
  });
  return vad;
}

async function setListening(on) {
  const instance = await ensureVad().catch((error) => { emit({ type: 'error', message: `Microphone: ${error.message}` }); return null; });
  if (!instance) return;
  inputGated = !on;
  try { on ? await instance.start() : await instance.pause(); } catch (error) { emit({ type: 'error', message: `Microphone: ${error.message}` }); }
}

// ---------- playback ----------
function playAudio(job, pcm, rate) {
  if (job < expectedJob) return;
  audioCtx ??= new AudioContext();
  const buffer = audioCtx.createBuffer(1, pcm.length, rate);
  buffer.getChannelData(0).set(pcm);
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);
  const at = Math.max(audioCtx.currentTime + 0.05, playUntil);
  source.start(at);
  playUntil = at + buffer.duration;
  playing.add(source);
  const jobState = activeJobs.get(job) || { chunks: 0, done: false };
  jobState.chunks++; activeJobs.set(job, jobState);
  source.onended = () => { playing.delete(source); jobState.chunks--; maybeFinished(); };
}

// A job set is finished only when the worker says done AND every queued chunk
// has played out — the speaker, not the synthesizer, decides when speech ends.
function maybeFinished() {
  if (playing.size || !activeJobs.size) return;
  if (![...activeJobs.values()].every((job) => job.done && job.chunks === 0)) return;
  const last = expectedJob;
  activeJobs.clear(); expectedJob = 0;
  inputGated = false;
  emit({ type: 'speak-end', job: last });
}

function handleWorker(message) {
  switch (message.type) {
    case 'audio': {
      const { job, rate } = message;
      const startPlayback = !playing.size;
      playAudio(job, new Float32Array(message.pcm), rate);
      if (startPlayback && playing.size) { inputGated = true; emit({ type: 'speak-start', job }); }
      break;
    }
    case 'speak-done': {
      const jobState = activeJobs.get(message.job) || { chunks: 0, done: false };
      jobState.done = true; activeJobs.set(message.job, jobState);
      expectedJob = message.job;
      maybeFinished();
      break;
    }
    case 'transcript':
      transcribeInflight = Math.max(0, transcribeInflight - 1);
      emit({ type: 'utterance', id: message.id, text: message.text });
      break;
    default: emit(message);
  }
}

function cancelSpeech() {
  // Push the job barrier past everything issued so worker chunks that are
  // already in flight for cancelled jobs get dropped, not played.
  expectedJob = latestIssuedJob + 1; activeJobs.clear(); playUntil = 0;
  for (const source of playing) { try { source.onended = null; source.stop(); } catch {} }
  playing.clear();
  worker?.postMessage({ type: 'cancel' });
  inputGated = false;
}

// ---------- worker ----------
function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(`${ORIGIN}/worker.js`);
  worker.onmessage = (event) => handleWorker(event.data || {});
  worker.onerror = (event) => emit({ type: 'error', message: `Voice worker: ${event.message || 'failed'}` });
  return worker;
}

// ---------- control channel from main ----------
window.voiceBridge.onControl((message) => {
  switch (message?.type) {
    case 'init':
      ensureWorker().postMessage({ type: 'init', sttModel: message.sttModel, ttsVoice: message.ttsVoice });
      break;
    case 'listen': setListening(!!message.on); break;
    case 'gate': inputGated = !!message.on; break;
    case 'speak':
      latestIssuedJob = Math.max(latestIssuedJob, Number(message.job) || 0);
      ensureWorker().postMessage({ type: 'speak', job: message.job, text: message.text, voice: message.voice, speed: message.speed });
      break;
    case 'cancel-speech': cancelSpeech(); break;
    case 'transcribe-audio': break; // reserved for future recorded-clip paths
    case 'update-models':
      ensureWorker().postMessage({ type: 'update-models', sttModel: message.sttModel, ttsVoice: message.ttsVoice });
      break;
  }
});
emit({ type: 'view-ready' });
