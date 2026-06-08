'use strict';

// ---------- Element references ----------
const el = (id) => document.getElementById(id);
const deviceSelect = el('device-select');
const permissionBtn = el('permission-btn');
const optNoise = el('opt-noise-suppression');
const optEcho = el('opt-echo-cancellation');
const optAutoGain = el('opt-auto-gain');
const channelSelect = el('channel-select');
const bitdepthSelect = el('bitdepth-select');
const meterL = el('meter-l');
const meterR = el('meter-r');
const peakL = el('peak-l');
const peakR = el('peak-r');
const clipWarning = el('clip-warning');
const gainSlider = el('gain-slider');
const gainValue = el('gain-value');
const optMonitor = el('opt-monitor');
const recordBtn = el('record-btn');
const timerEl = el('timer');
const statusEl = el('status');
const recordingsList = el('recordings-list');
const recordingsEmpty = el('recordings-empty');

// ---------- Audio state ----------
let audioCtx = null;
let mediaStream = null;
let sourceNode = null;
let gainNode = null;
let analyserL = null;
let analyserR = null;
let splitterNode = null;
let workletNode = null;
let meterRaf = null;

let isRecording = false;
let recordedChunks = [];   // array of { channels: Float32Array[], frames }
let recordedFrames = 0;
let recordChannels = 2;
let recordSampleRate = 48000;
let recordStartTime = 0;
let timerInterval = null;
let recordingCount = 0;

const peakHold = { l: 0, r: 0 };

// ---------- Permission / device enumeration ----------
permissionBtn.addEventListener('click', async () => {
  try {
    statusEl.textContent = 'アクセスを要求中…';
    // Request access so device labels become available, then stop it.
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach((t) => t.stop());
    await refreshDevices();
    permissionBtn.textContent = 'デバイス再読み込み';
    await startMonitoring();
  } catch (err) {
    statusEl.textContent = 'アクセスが拒否されました: ' + err.message;
  }
});

async function refreshDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((d) => d.kind === 'audioinput');
  const current = deviceSelect.value;
  deviceSelect.innerHTML = '';
  inputs.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `入力 ${i + 1}`;
    deviceSelect.appendChild(opt);
  });
  if ([...deviceSelect.options].some((o) => o.value === current)) {
    deviceSelect.value = current;
  }
  deviceSelect.disabled = inputs.length === 0;
}

navigator.mediaDevices.addEventListener?.('devicechange', () => {
  if (!deviceSelect.disabled) refreshDevices();
});

// Re-open the stream when device or processing options change.
[deviceSelect, optNoise, optEcho, optAutoGain, channelSelect].forEach((node) => {
  node.addEventListener('change', () => {
    if (mediaStream && !isRecording) startMonitoring();
  });
});

// ---------- Monitoring graph ----------
async function startMonitoring() {
  if (isRecording) return;
  stopMonitoring();

  const constraints = {
    audio: {
      deviceId: deviceSelect.value ? { exact: deviceSelect.value } : undefined,
      echoCancellation: optEcho.checked,
      noiseSuppression: optNoise.checked,
      autoGainControl: optAutoGain.checked,
      channelCount: parseInt(channelSelect.value, 10),
    },
  };

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    statusEl.textContent = '入力を開けません: ' + err.message;
    return;
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  recordSampleRate = audioCtx.sampleRate;

  try {
    await audioCtx.audioWorklet.addModule('recorder-processor.js');
  } catch (err) {
    statusEl.textContent = 'ワークレットを読み込めません: ' + err.message;
    return;
  }

  sourceNode = audioCtx.createMediaStreamSource(mediaStream);
  gainNode = audioCtx.createGain();
  gainNode.gain.value = dbToGain(parseFloat(gainSlider.value));

  const track = mediaStream.getAudioTracks()[0];
  const settings = track.getSettings();
  recordChannels = settings.channelCount || parseInt(channelSelect.value, 10) || 2;

  // Analysers for L/R metering.
  splitterNode = audioCtx.createChannelSplitter(2);
  analyserL = audioCtx.createAnalyser();
  analyserR = audioCtx.createAnalyser();
  analyserL.fftSize = 1024;
  analyserR.fftSize = 1024;

  // Recorder worklet.
  workletNode = new AudioWorkletNode(audioCtx, 'recorder-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: recordChannels,
    channelCountMode: 'explicit',
    channelInterpretation: 'discrete',
  });
  workletNode.port.onmessage = onWorkletMessage;

  // Graph: source -> gain -> [splitter -> analysers] and -> worklet
  sourceNode.connect(gainNode);
  gainNode.connect(splitterNode);
  splitterNode.connect(analyserL, 0);
  splitterNode.connect(analyserR, recordChannels > 1 ? 1 : 0);
  gainNode.connect(workletNode);
  // Worklet needs a sink to keep its process() pumping.
  const silent = audioCtx.createGain();
  silent.gain.value = 0;
  workletNode.connect(silent);
  silent.connect(audioCtx.destination);

  updateMonitorRouting();

  recordBtn.disabled = false;
  statusEl.textContent = `準備完了 (${recordSampleRate} Hz / ${recordChannels === 1 ? 'モノラル' : 'ステレオ'})`;
  runMeter();
}

function stopMonitoring() {
  if (meterRaf) cancelAnimationFrame(meterRaf);
  meterRaf = null;
  try { sourceNode?.disconnect(); } catch {}
  try { gainNode?.disconnect(); } catch {}
  try { workletNode?.disconnect(); } catch {}
  if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
  mediaStream = null;
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
}

function updateMonitorRouting() {
  if (!gainNode || !audioCtx) return;
  // Disconnect any existing monitor path by reconnecting carefully.
  try { gainNode.disconnect(audioCtx.destination); } catch {}
  if (optMonitor.checked) {
    gainNode.connect(audioCtx.destination);
  }
}

optMonitor.addEventListener('change', updateMonitorRouting);

// ---------- Gain ----------
gainSlider.addEventListener('input', () => {
  const db = parseFloat(gainSlider.value);
  gainValue.textContent = `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
  if (gainNode) gainNode.gain.value = dbToGain(db);
});

function dbToGain(db) { return Math.pow(10, db / 20); }

// ---------- Level meter ----------
function runMeter() {
  const bufL = new Float32Array(analyserL.fftSize);
  const bufR = new Float32Array(analyserR.fftSize);

  function tick() {
    analyserL.getFloatTimeDomainData(bufL);
    analyserR.getFloatTimeDomainData(bufR);
    const pl = peak(bufL);
    const pr = peak(bufR);

    meterL.style.width = (pl * 100).toFixed(1) + '%';
    meterR.style.width = (pr * 100).toFixed(1) + '%';

    peakHold.l = Math.max(peakHold.l * 0.95, pl);
    peakHold.r = Math.max(peakHold.r * 0.95, pr);
    peakL.style.left = (peakHold.l * 100).toFixed(1) + '%';
    peakR.style.left = (peakHold.r * 100).toFixed(1) + '%';

    const clipping = pl > 0.99 || pr > 0.99;
    clipWarning.hidden = !clipping;

    meterRaf = requestAnimationFrame(tick);
  }
  tick();
}

function peak(buf) {
  let max = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i]);
    if (v > max) max = v;
  }
  return Math.min(max, 1);
}

// ---------- Recording ----------
recordBtn.addEventListener('click', () => {
  if (!isRecording) startRecording();
  else stopRecording();
});

function startRecording() {
  if (!workletNode) return;
  recordedChunks = [];
  recordedFrames = 0;
  isRecording = true;
  workletNode.port.postMessage('start');

  recordBtn.textContent = '■ 録音停止';
  recordBtn.classList.add('recording');
  statusEl.textContent = '録音中…';
  // Lock settings that require reopening the stream.
  [deviceSelect, optNoise, optEcho, optAutoGain, channelSelect].forEach((n) => (n.disabled = true));

  recordStartTime = performance.now();
  timerInterval = setInterval(updateTimer, 200);
  updateTimer();
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  workletNode.port.postMessage('stop'); // worklet flushes then replies 'stopped'
  clearInterval(timerInterval);

  recordBtn.textContent = '● 録音開始';
  recordBtn.classList.remove('recording');
  statusEl.textContent = 'エンコード中…';
}

function onWorkletMessage(e) {
  const msg = e.data;
  if (msg.type === 'chunk') {
    if (isRecording || recordedChunks.length >= 0) {
      recordedChunks.push({ channels: msg.channels, frames: msg.frames });
      recordedFrames += msg.frames;
    }
  } else if (msg.type === 'stopped') {
    finalizeRecording();
  }
}

function finalizeRecording() {
  deviceSelect.disabled = false;
  [optNoise, optEcho, optAutoGain, channelSelect].forEach((n) => (n.disabled = false));

  if (recordedFrames === 0) {
    statusEl.textContent = '録音データがありません。';
    return;
  }

  const bitDepth = parseInt(bitdepthSelect.value, 10);
  const channelCount = recordedChunks[0].channels.length;
  const wavBlob = encodeWav(recordedChunks, recordedFrames, channelCount, recordSampleRate, bitDepth);

  recordingCount++;
  addRecording(wavBlob, recordedFrames / recordSampleRate, channelCount, bitDepth);

  recordedChunks = [];
  recordedFrames = 0;
  statusEl.textContent = '録音を保存しました。';
}

function updateTimer() {
  const elapsed = (performance.now() - recordStartTime) / 1000;
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = Math.floor(elapsed % 60);
  timerEl.textContent = [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

// ---------- WAV encoding ----------
function encodeWav(chunks, totalFrames, channels, sampleRate, bitDepth) {
  const bytesPerSample = bitDepth / 8;
  const blockAlign = channels * bytesPerSample;
  const dataSize = totalFrames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);             // fmt chunk size
  view.setUint16(20, 1, true);              // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  if (bitDepth === 16) {
    for (const chunk of chunks) {
      const { channels: chans, frames } = chunk;
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < channels; c++) {
          let s = Math.max(-1, Math.min(1, chans[c][i]));
          view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
          offset += 2;
        }
      }
    }
  } else { // 24-bit
    for (const chunk of chunks) {
      const { channels: chans, frames } = chunk;
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < channels; c++) {
          let s = Math.max(-1, Math.min(1, chans[c][i]));
          let val = s < 0 ? s * 0x800000 : s * 0x7fffff;
          val = Math.round(val);
          view.setUint8(offset, val & 0xff);
          view.setUint8(offset + 1, (val >> 8) & 0xff);
          view.setUint8(offset + 2, (val >> 16) & 0xff);
          offset += 3;
        }
      }
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

// ---------- Recordings list ----------
function addRecording(blob, durationSec, channels, bitDepth) {
  recordingsEmpty.hidden = true;
  const url = URL.createObjectURL(blob);
  const now = new Date();
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const filename = `recording-${stamp}.wav`;

  const li = document.createElement('li');
  li.className = 'recording-item';

  const head = document.createElement('div');
  head.className = 'ri-head';
  const name = document.createElement('span');
  name.className = 'ri-name';
  name.textContent = `録音 #${recordingCount}`;
  const meta = document.createElement('span');
  meta.className = 'ri-meta';
  meta.textContent = `${formatDuration(durationSec)} ・ ${channels === 1 ? 'モノラル' : 'ステレオ'} ・ ${bitDepth}-bit ・ ${(blob.size / 1048576).toFixed(1)} MB`;
  head.append(name, meta);

  const audio = document.createElement('audio');
  audio.controls = true;
  audio.src = url;

  const actions = document.createElement('div');
  actions.className = 'ri-actions';
  const download = document.createElement('a');
  download.className = 'btn btn-sm btn-download';
  download.href = url;
  download.download = filename;
  download.textContent = '⬇ ダウンロード (WAV)';
  const del = document.createElement('button');
  del.className = 'btn btn-sm btn-delete';
  del.textContent = '削除';
  del.addEventListener('click', () => {
    URL.revokeObjectURL(url);
    li.remove();
    if (!recordingsList.querySelector('.recording-item')) recordingsEmpty.hidden = false;
  });
  actions.append(download, del);

  li.append(head, audio, actions);
  recordingsList.insertBefore(li, recordingsList.firstChild);
}

function pad(n) { return String(n).padStart(2, '0'); }
function formatDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${pad(m)}:${pad(s)}`;
}

// ---------- Init ----------
(function init() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    statusEl.textContent = 'このブラウザは録音に対応していません。最新のChrome/Safari/Edgeをお使いください。';
    permissionBtn.disabled = true;
    return;
  }
  if (!window.AudioWorkletNode) {
    statusEl.textContent = 'このブラウザはAudioWorkletに対応していません。';
    permissionBtn.disabled = true;
    return;
  }
  gainValue.textContent = '+0.0 dB';
  statusEl.textContent = 'マイク／入力の許可を押してください。';
})();
