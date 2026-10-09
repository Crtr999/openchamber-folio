// Audio processing stays off the renderer thread. This source contains no data or URLs.
export const meetingWorkletSource = `
class MeetingPCM extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(1600);
    this.offset = 0; this.phase = 0; this.sum = 0; this.count = 0;
    this.port.onmessage = (event) => {
      if (event.data !== 'flush') return;
      if (this.offset) {
        const tail = this.buffer.slice(0, this.offset);
        this.port.postMessage(tail, [tail.buffer]);
      }
      this.buffer.fill(0); this.offset = 0; this.phase = 0; this.sum = 0; this.count = 0;
      this.port.postMessage({ flushed: true });
    };
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels || !channels.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] / channels.length;
      this.sum += value; this.count++; this.phase += 16000;
      if (this.phase >= sampleRate) {
        this.phase -= sampleRate;
        this.buffer[this.offset++] = Math.max(-1, Math.min(1, this.sum / this.count));
        this.sum = 0; this.count = 0;
        if (this.offset === this.buffer.length) {
          this.port.postMessage(this.buffer, [this.buffer.buffer]);
          this.buffer = new Float32Array(1600); this.offset = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('meeting-pcm', MeetingPCM);
`;
