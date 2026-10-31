/**
 * 16-bit PCM WAV encoding for anything shaped like an AudioBuffer.
 * @param {{ numberOfChannels: number, length: number, sampleRate: number,
 *           getChannelData: (c: number) => Float32Array }} buffer
 * @returns {Buffer}
 */
export function encodeWav(buffer) {
  const { numberOfChannels: channels, length: frames, sampleRate } = buffer;
  const bytesPerFrame = channels * 2;
  const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  const out = Buffer.alloc(44 + frames * bytesPerFrame);

  out.write('RIFF', 0);
  out.writeUInt32LE(36 + frames * bytesPerFrame, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(16, 16); // fmt chunk size
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * bytesPerFrame, 28);
  out.writeUInt16LE(bytesPerFrame, 32);
  out.writeUInt16LE(16, 34); // bits per sample
  out.write('data', 36);
  out.writeUInt32LE(frames * bytesPerFrame, 40);

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, data[c][i]));
      out.writeInt16LE(Math.round(v * 32767), offset);
      offset += 2;
    }
  }
  return out;
}
