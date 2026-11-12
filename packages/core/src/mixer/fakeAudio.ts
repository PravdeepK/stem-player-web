// Just enough of Web Audio for the mixer's tests to run in plain Node. Only the
// tests import this.

export interface FakeFile {
  seconds: number;
  channels: number;
}

export class FakeBuffer {
  readonly length: number;
  private readonly data: Float32Array[] = [];

  constructor(
    readonly numberOfChannels: number,
    length: number,
    readonly sampleRate: number,
  ) {
    this.length = length;
  }

  get duration() {
    return this.length / this.sampleRate;
  }

  // Allocated on first use, so a long stem only costs memory in the tests
  // that read its samples.
  getChannelData(channel: number) {
    this.data[channel] ??= new Float32Array(this.length);
    return this.data[channel];
  }
}

class FakeParam {
  value = 1;
  events: { type: string; value: number; time: number }[] = [];
  setTargetAtTime(value: number, time: number) {
    this.events.push({ type: "target", value, time });
  }
  setValueAtTime(value: number, time: number) {
    this.events.push({ type: "value", value, time });
  }
}

class FakeNode {
  connected: unknown[] = [];
  connect(node: unknown) {
    this.connected.push(node);
  }
  disconnect() {
    this.connected = [];
  }
}

export class FakeSource extends FakeNode {
  buffer: FakeBuffer | null = null;
  started: { when: number; offset: number } | null = null;
  stopped = false;
  start(when: number, offset: number) {
    this.started = { when, offset };
  }
  stop() {
    this.stopped = true;
  }
}

export class FakeContext {
  currentTime = 0;
  state: AudioContextState = "suspended";
  outputLatency = 0.02;
  baseLatency = 0.005;
  destination = new FakeNode();
  sources: FakeSource[] = [];
  gains: { gain: FakeParam }[] = [];
  // Every file handed to decodeAudioData, keyed by its bytes.
  files = new WeakMap<ArrayBuffer, FakeFile>();
  decodes = 0;
  inFlight = 0;
  maxInFlight = 0;
  closed = false;

  constructor(readonly sampleRate: number) {}

  createGain() {
    const node = Object.assign(new FakeNode(), { gain: new FakeParam() });
    this.gains.push(node);
    return node;
  }

  createAnalyser() {
    return Object.assign(new FakeNode(), {
      fftSize: 2048,
      getFloatTimeDomainData(out: Float32Array) {
        out.fill(0.5);
      },
    });
  }

  createBufferSource() {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }

  createBuffer(channels: number, length: number, sampleRate: number) {
    return new FakeBuffer(channels, length, sampleRate);
  }

  async decodeAudioData(bytes: ArrayBuffer) {
    const file = this.files.get(bytes);
    if (!file) throw new Error("not a fake file");
    this.decodes++;
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    // Lets any other decode that could start in parallel do so.
    await new Promise((resolve) => setTimeout(resolve, 1));
    this.inFlight--;
    return new FakeBuffer(file.channels, Math.round(file.seconds * this.sampleRate), this.sampleRate);
  }

  async resume() {
    this.state = "running";
  }

  async close() {
    this.state = "closed";
    this.closed = true;
  }

  // Bytes the probe can't read, so the length is only known once decoded.
  file(seconds: number, channels = 2) {
    const bytes = new ArrayBuffer(16);
    this.files.set(bytes, { seconds, channels });
    return bytes;
  }

  // A real WAV file of silence, 8-bit at 8 kHz to keep it small.
  wav(seconds: number, channels = 2) {
    const byteRate = 8000 * channels;
    const dataSize = Math.round(seconds * byteRate);
    const bytes = new ArrayBuffer(44 + dataSize);
    const view = new DataView(bytes);
    const tag = (at: number, text: string) => {
      for (let i = 0; i < 4; i++) view.setUint8(at + i, text.charCodeAt(i));
    };
    tag(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    tag(8, "WAVE");
    tag(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, 8000, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, channels, true);
    view.setUint16(34, 8, true);
    tag(36, "data");
    view.setUint32(40, dataSize, true);
    this.files.set(bytes, { seconds, channels });
    return bytes;
  }
}
