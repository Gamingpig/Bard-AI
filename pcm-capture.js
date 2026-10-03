
class BardPcmCapture extends AudioWorkletProcessor {
  constructor() { super(); this.phase = 0; this.samples = []; this.ratio = 16000 / sampleRate; }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this.phase += this.ratio;
      if (this.phase >= 1) {
        this.phase -= 1;
        this.samples.push(channel[i]);
      }
    }
    if (this.samples.length >= 2048) {
      const chunk = new Float32Array(this.samples.splice(0, 2048));
      this.port.postMessage(chunk.buffer, [chunk.buffer]);
    }
    return true;
  }
}
registerProcessor('bard-pcm-capture', BardPcmCapture);
