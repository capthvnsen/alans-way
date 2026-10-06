// Voice mode orchestrator. Owns the hidden voice WebContentsView, the call
// state machine, reply collection (quiescence + coalescing), and the
// single-outstanding-send rule that works around Hermes' pending-slot burst
// collapse. Audio never crosses IPC — the view handles capture, inference and
// playback; main only sees transcripts, reply text and lifecycle events.
const path = require('node:path');
const { toSpeech } = require('./speech-text.cjs');
const { VOICE_PARTITION, VOICE_URL } = require('./voice-protocol.cjs');

const REPLY_QUIESCENCE_MS = 1200;   // edits/drafts settle before we speak
const AWAIT_REPLY_MS = 120000;      // a turn's patience for the agent
const VOICE_PREFIX = '🎙 ';
const CALL_START_MESSAGE = '🎙 Voice call started — reply conversationally and briefly; put code, tables and long detail in the chat as normal messages.';
const CALL_END_MESSAGE = '🎙 Voice call ended — please post a brief summary of what we discussed and any open items.';

// deps: { getView: () => telegramView, telegramSend, openBot, hostWindow: () => backgroundWindow,
//         getPrefs, savePrefs, broadcast, electron: { WebContentsView, systemPreferences } }
// electron is injected (not required) so this module loads under plain node tests.
function createVoiceMode({ getView, telegramSend, openBot, hostWindow, getPrefs, savePrefs, broadcast, electron }) {
  let view = null, viewReady = false;
  let status = 'off'; // off | starting | listening | transcribing | thinking | speaking
  let dictating = false;
  let lastTranscript = '';
  let muted = false;
  let error = '';
  let botTyping = false;
  let modelProgress = null; // last model-download progress event for the UI
  let speakJob = 0;
  let speakQueue = [];
  let speakActive = false;
  let queuedTranscripts = [];
  let sendOutstanding = false;
  let awaitTimer = null;
  let pendingReplies = new Map(); // messageId -> text
  let quiesceTimer = null;

  const prefs = () => getPrefs()?.voice || {};
  const active = () => status !== 'off';
  const callBotId = () => active() ? (getPrefs()?.selectedBotId || '') : '';
  const setStatus = (next) => { if (status !== next) { status = next; broadcast(); } };
  const control = (message) => { if (view && !view.webContents.isDestroyed()) view.webContents.send('voice:control', message); };
  const micLive = () => (dictating || active()) && !muted;

  function describe() {
    return { status, dictating, transcript: lastTranscript, muted, error,
      callActive: active(), speaking: speakActive || status === 'speaking',
      botTyping, queued: queuedTranscripts.length,
      modelsReady: viewReady, progress: modelProgress,
      voice: prefs().voiceId || 'af_heart', sttModel: prefs().sttModel || 'onnx-community/moonshine-base-ONNX' };
  }

  function ensureView() {
    if (view && !view.webContents.isDestroyed()) return view;
    viewReady = false;
    view = new electron.WebContentsView({ webPreferences: {
      preload: path.join(__dirname, 'voice-preload.bundle.cjs'),
      partition: VOICE_PARTITION, contextIsolation: true, nodeIntegration: false,
      sandbox: true, backgroundThrottling: false,
    } });
    view.setBackgroundColor('#09090a');
    const host = hostWindow();
    host.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 1, height: 1 });
    view.webContents.loadURL(VOICE_URL).catch((e) => { error = e.message; broadcast(); });
    return view;
  }

  async function ensureReady() {
    if (process.platform === 'darwin' && electron.systemPreferences) {
      const granted = await electron.systemPreferences.askForMediaAccess('microphone').catch(() => false);
      if (!granted) throw new Error('Microphone access denied — enable it in System Settings → Privacy & Security → Microphone.');
    }
    ensureView();
    if (!viewReady) {
      await new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('Voice engine did not finish loading.')), 180000);
        const check = () => viewReady ? (clearTimeout(deadline), resolve()) : setTimeout(check, 200);
        check();
      });
    }
    if (error) throw new Error(error);
  }

  // ---------- outgoing ----------
  async function sendVoiceTurn(text) {
    const botId = callBotId();
    if (!botId) return;
    sendOutstanding = true;
    setStatus('thinking');
    try { await telegramSend.send(botId, `${VOICE_PREFIX}${text}`); }
    catch (e) { error = `Send failed: ${e.message}`; sendOutstanding = false; broadcast(); return; }
    // The call may have ended while the send was in flight — don't arm a
    // reply timer that outlives the call (and would hold the process open).
    if (!active()) { sendOutstanding = false; return; }
    clearTimeout(awaitTimer);
    awaitTimer = setTimeout(() => { sendOutstanding = false; if (status === 'thinking') setStatus('listening'); flushQueued(); }, AWAIT_REPLY_MS);
  }

  function flushQueued() {
    if (sendOutstanding || !queuedTranscripts.length || !active()) return;
    sendVoiceTurn(queuedTranscripts.shift());
    broadcast();
  }

  // ---------- incoming replies ----------
  function onBotMessage({ chatId, id, text, edited }) {
    if (!active() || chatId !== callBotId() || typeof text !== 'string') return;
    sendOutstanding = false;
    pendingReplies.set(id ?? `m${Date.now()}`, text);
    clearTimeout(quiesceTimer);
    // Hermes streams replies as drafts/edits — speak only after the text goes
    // quiet and the typing action stops.
    quiesceTimer = setTimeout(flushReplies, edited ? REPLY_QUIESCENCE_MS : REPLY_QUIESCENCE_MS);
  }

  function onBotTyping(typing) {
    botTyping = typing;
    if (typing) { clearTimeout(quiesceTimer); quiesceTimer = setTimeout(flushReplies, REPLY_QUIESCENCE_MS); }
  }

  function flushReplies() {
    if (!pendingReplies.size) return;
    const merged = [...pendingReplies.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join('\n');
    pendingReplies.clear();
    const { text } = toSpeech(merged);
    if (text) enqueueSpeak(text);
    else if (active()) setStatus('listening');
    if (text && active()) setStatus('thinking'); // stays until speak-start or next utterance
    flushQueued();
  }

  // ---------- speaking ----------
  function enqueueSpeak(text) {
    speakQueue.push({ job: ++speakJob, text });
    if (!speakActive) drainSpeak();
  }
  function drainSpeak() {
    const next = speakQueue.shift();
    if (!next) { speakActive = false; if (status === 'speaking' || status === 'thinking') setStatus('listening'); broadcast(); return; }
    speakActive = true;
    setStatus('speaking');
    control({ type: 'speak', job: next.job, text: next.text, voice: prefs().voiceId || 'af_heart' });
  }

  // ---------- voice view events ----------
  function onViewEvent(event) {
    switch (event?.type) {
      case 'view-ready':
        control({ type: 'init', sttModel: prefs().sttModel, ttsVoice: prefs().voiceId });
        break;
      case 'ready':
        viewReady = true; modelProgress = null; error = ''; broadcast();
        break;
      case 'progress':
        modelProgress = { stage: event.stage, ...event.detail }; broadcast();
        break;
      case 'speech-start':
        if (active()) setStatus('listening');
        break;
      case 'transcribing':
        if (active()) setStatus('transcribing');
        break;
      case 'utterance': {
        const text = (event.text || '').trim();
        if (!text) { if (active() && status === 'transcribing') setStatus('listening'); break; }
        lastTranscript = text;
        if (active()) {
          if (sendOutstanding) { queuedTranscripts.push(text); broadcast(); }
          else sendVoiceTurn(text);
        } else if (dictating) {
          const botId = getPrefs()?.selectedBotId;
          if (botId) telegramSend.insertDraft(botId, `${text} `).catch((e) => { error = `Dictation failed: ${e.message}`; broadcast(); });
        }
        broadcast();
        break;
      }
      case 'speak-start':
        speakActive = true; if (active()) setStatus('speaking');
        break;
      case 'speak-end':
        drainSpeak();
        break;
      case 'error':
        error = event.message || 'Voice error';
        // A failed synthesis never posts speak-done — release the queue slot.
        if (speakActive) { speakActive = false; drainSpeak(); }
        broadcast();
        break;
    }
  }

  function onBotAction(botId, action) {
    // Any non-cancel chat action (typing, uploading, choosing…) means the bot
    // is still working — hold the reply quiet period open.
    if (active() && String(botId) === callBotId()) onBotTyping(action !== 'cancel');
  }

  // ---------- call control ----------
  async function startCall() {
    if (active()) return;
    const botId = getPrefs()?.selectedBotId;
    if (!botId) throw new Error('Select a bot first — that is who you will call.');
    if (dictating) await stopDictation();
    setStatus('starting');
    await ensureReady();
    control({ type: 'gate', on: false });
    control({ type: 'listen', on: true });
    setStatus('listening');
    sendOutstanding = true;
    try { await telegramSend.send(botId, CALL_START_MESSAGE); }
    catch (e) { error = `Call notice failed: ${e.message}`; sendOutstanding = false; broadcast(); }
  }

  async function stopCall() {
    if (!active()) return;
    const botId = callBotId();
    status = 'off';
    speakQueue = []; queuedTranscripts = []; pendingReplies.clear(); sendOutstanding = false; botTyping = false;
    clearTimeout(awaitTimer); clearTimeout(quiesceTimer);
    control({ type: 'cancel-speech' });
    speakActive = false;
    control({ type: 'listen', on: dictating });
    broadcast();
    if (botId) telegramSend.send(botId, CALL_END_MESSAGE).catch(() => {});
  }

  async function toggleCall() { return active() ? stopCall() : startCall(); }

  // ---------- dictation ----------
  async function startDictation() {
    if (dictating) return;
    if (!getPrefs()?.selectedBotId) throw new Error('Select a bot first — dictation lands in that composer.');
    await ensureReady();
    dictating = true;
    control({ type: 'listen', on: true });
    broadcast();
  }
  async function stopDictation() {
    if (!dictating) return;
    dictating = false;
    if (!active()) control({ type: 'listen', on: false });
    broadcast();
  }
  async function toggleDictation() { return dictating ? stopDictation() : startDictation(); }

  function interrupt() { speakQueue = []; speakActive = false; control({ type: 'cancel-speech' }); if (active()) setStatus('listening'); }

  function setMuted(next) {
    muted = !!next;
    control({ type: 'gate', on: muted });
    control({ type: 'listen', on: micLive() });
    broadcast();
  }

  async function command(name, value = {}) {
    switch (name) {
      case 'voice-call': await toggleCall(); return describe();
      case 'voice-dictation': await toggleDictation(); return describe();
      case 'voice-mute': setMuted(value.muted === undefined ? !muted : !!value.muted); return describe();
      case 'voice-interrupt': interrupt(); return describe();
      case 'voice-settings': {
        const v = { ...prefs() };
        if (typeof value.voiceId === 'string') v.voiceId = value.voiceId.slice(0, 40);
        if (typeof value.sttModel === 'string') v.sttModel = value.sttModel.slice(0, 120);
        const prefsObj = getPrefs(); prefsObj.voice = v; savePrefs();
        control({ type: 'update-models', sttModel: v.sttModel, ttsVoice: v.voiceId });
        return describe();
      }
      default: return describe();
    }
  }

  return { describe, command, onViewEvent, onBotMessage, onBotAction,
    endCall: () => active() && stopCall(),
    get view() { return view; } };
}
module.exports = { createVoiceMode };
