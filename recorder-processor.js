// AudioWorkletProcessor that captures raw PCM frames and posts them to the
// main thread in chunks. Buffering reduces the number of postMessage calls
// (raw process() runs every 128 frames ≈ 375x/sec at 48kHz).
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.chunkFrames = 16384; // frames to accumulate before posting
    this.buffers = null;      // Float32Array[] per channel
    this.offset = 0;
    this.channels = 0;

    this.port.onmessage = (e) => {
      if (e.data === 'start') {
        this.recording = true;
      } else if (e.data === 'stop') {
        this.flush();
        this.recording = false;
        this.buffers = null;
        this.offset = 0;
        this.port.postMessage({ type: 'stopped' });
      }
    };
  }

  allocate(channelCount) {
    this.channels = channelCount;
    this.buffers = [];
    for (let c = 0; c < channelCount; c++) {
      this.buffers.push(new Float32Array(this.chunkFrames));
    }
    this.offset = 0;
  }

  flush() {
    if (!this.buffers || this.offset === 0) return;
    const out = this.buffers.map((b) => b.slice(0, this.offset));
    this.port.postMessage({ type: 'chunk', channels: out, frames: this.offset }, out.map((b) => b.buffer));
    // buffers were transferred; reallocate
    this.allocate(this.channels);
  }

  process(inputs) {
    const input = inputs[0];
    if (!this.recording || !input || input.length === 0) return true;

    const channelCount = input.length;
    if (!this.buffers || this.channels !== channelCount) {
      this.allocate(channelCount);
    }

    const frames = input[0].length;
    for (let i = 0; i < frames; i++) {
      if (this.offset >= this.chunkFrames) this.flush();
      for (let c = 0; c < channelCount; c++) {
        this.buffers[c][this.offset] = input[c][i];
      }
      this.offset++;
    }
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
