/**
 * Audio post-processing. Every function here exists to satisfy a specific row of
 * PRD §5.3's launch production constraints, and each one reports what it did so
 * the UI can disclose it rather than hide it.
 *
 * The API returns raw linear16 (16-bit signed PCM, little-endian). The browser
 * needs a container, the head of the stream has dead air, and the output has no
 * headroom. All three are handled here, server-side, and all three are reported.
 */

const BYTES_PER_SAMPLE = 2;
const FULL_SCALE = 32768; // |min| of int16; the reference for dBFS

/** PRD §5.3: trim the ~350ms of dead air with a 12ms pre-roll — don't clip the attack. */
export const PRE_ROLL_MS = 12;

/**
 * Silence threshold. Chosen as a floor rather than exact zero because the dead
 * air at the head of the stream is not guaranteed to be bit-exact silence, and a
 * strict `=== 0` test would fail to trim anything if it carries dither.
 * -60 dBFS is well below anything audible as content.
 */
const SILENCE_FLOOR = Math.round(FULL_SCALE * 10 ** (-60 / 20)); // ≈33

/**
 * Find the first sample that is audibly non-silent, then back off by the
 * pre-roll. Returns a sample index, never negative.
 */
function firstSoundIndex(samples) {
  for (let i = 0; i < samples.length; i += 1) {
    if (Math.abs(samples[i]) > SILENCE_FLOOR) return i;
  }
  return samples.length; // entirely silent
}

/** Read a Buffer of linear16 as an Int16Array without copying when alignment allows. */
function asSamples(pcm) {
  if (pcm.byteOffset % BYTES_PER_SAMPLE === 0) {
    return new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / BYTES_PER_SAMPLE));
  }
  // Misaligned slice — copy rather than throw.
  const copy = Buffer.from(pcm);
  return new Int16Array(copy.buffer, copy.byteOffset, Math.floor(copy.length / BYTES_PER_SAMPLE));
}

/**
 * Trim leading silence.
 *
 * Returns `{ samples, trimmedMs, preRollMs, wasTrimmed }`. `trimmedMs` is what
 * the UI discloses — PRD §5.3 requires disclosure, not silent correction.
 */
export function trimLeadingSilence(pcm, sampleRate) {
  const samples = asSamples(pcm);
  const firstSound = firstSoundIndex(samples);

  if (firstSound === 0) {
    return { samples, trimmedMs: 0, preRollMs: PRE_ROLL_MS, wasTrimmed: false };
  }
  if (firstSound >= samples.length) {
    // Entirely silent. Return it untouched — trimming everything would turn a
    // diagnosable problem (no audio) into an invisible one (empty file).
    return { samples, trimmedMs: 0, preRollMs: PRE_ROLL_MS, wasTrimmed: false };
  }

  const preRollSamples = Math.round((PRE_ROLL_MS / 1000) * sampleRate);
  const cut = Math.max(0, firstSound - preRollSamples);

  return {
    samples: samples.subarray(cut),
    trimmedMs: (cut / sampleRate) * 1000,
    preRollMs: PRE_ROLL_MS,
    wasTrimmed: cut > 0,
  };
}

/**
 * True peak in dBFS.
 *
 * PRD §5.3: output peaks at full scale with no headroom — measure true peak and
 * warn above -0.5 dBFS. "True peak" here is sample peak; inter-sample peak
 * detection would need oversampling and is not what the constraint is about.
 *
 * Returns `{ peakDbfs, peakSample, needsNormalize }`. Digital silence reports
 * `-Infinity`, which the UI renders as "silent" rather than as a number.
 */
export function measurePeak(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  const peakDbfs = peak === 0 ? -Infinity : 20 * Math.log10(peak / FULL_SCALE);
  return {
    peakDbfs,
    peakSample: peak,
    needsNormalize: peakDbfs > -0.5,
  };
}

/**
 * Downsample to a fixed-width amplitude envelope for the waveform.
 * Computed server-side (PRD §5.2) so the browser renders a shape, not audio math.
 * Each bucket reports its peak, not its mean — a mean envelope hides clipping,
 * which is the exact thing this tool is trying to make visible.
 */
export function envelope(samples, buckets = 240) {
  if (samples.length === 0) return new Array(buckets).fill(0);
  const out = new Array(buckets);
  const per = samples.length / buckets;
  for (let b = 0; b < buckets; b += 1) {
    const start = Math.floor(b * per);
    const end = Math.min(samples.length, Math.max(start + 1, Math.floor((b + 1) * per)));
    let peak = 0;
    for (let i = start; i < end; i += 1) {
      const a = Math.abs(samples[i]);
      if (a > peak) peak = a;
    }
    out[b] = Number((peak / FULL_SCALE).toFixed(4));
  }
  return out;
}

/**
 * Wrap Int16 samples in a 44-byte canonical WAV header. Mono, 16-bit PCM.
 * PRD §5.2 lists this as a server responsibility.
 */
export function toWav(samples, sampleRate) {
  const dataBytes = samples.length * BYTES_PER_SAMPLE;
  const header = Buffer.alloc(44);
  const channels = 1;
  const byteRate = sampleRate * channels * BYTES_PER_SAMPLE;

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4); // RIFF chunk size
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * BYTES_PER_SAMPLE, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);

  const body = Buffer.from(samples.buffer, samples.byteOffset, dataBytes);
  return Buffer.concat([header, body]);
}

/**
 * Full pipeline: raw linear16 in, WAV plus the disclosures out.
 */
export function process(pcm, sampleRate) {
  const trim = trimLeadingSilence(pcm, sampleRate);
  const peak = measurePeak(trim.samples);
  return {
    wav: toWav(trim.samples, sampleRate),
    envelope: envelope(trim.samples),
    durationMs: (trim.samples.length / sampleRate) * 1000,
    sampleRate,
    trim: { trimmedMs: trim.trimmedMs, preRollMs: trim.preRollMs, wasTrimmed: trim.wasTrimmed },
    peak,
  };
}
