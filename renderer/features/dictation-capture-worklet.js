/* Dictation capture worklet (row 84): runs on the audio thread of a 16 kHz
 * AudioContext and posts the mono input in 50 ms blocks (800 samples). A
 * 'flush' message posts the partial block and then 'flushed', so the last
 * words before release are not lost. Loaded as a file module because the app
 * CSP blocks blob: worklets. */
/* global AudioWorkletProcessor, registerProcessor */
const BLOCK = 800;

class JennyDictationCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(BLOCK);
    this.filled = 0;
    this.port.onmessage = (event) => {
      if (event.data !== 'flush') return;
      if (this.filled > 0) this.port.postMessage(this.block.slice(0, this.filled));
      this.filled = 0;
      this.port.postMessage('flushed');
    };
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i += 1) {
      this.block[this.filled] = channel[i];
      this.filled += 1;
      if (this.filled === BLOCK) {
        this.port.postMessage(this.block, [this.block.buffer]);
        this.block = new Float32Array(BLOCK);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('jenny-dictation-capture', JennyDictationCapture);
