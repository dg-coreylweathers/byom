/**
 * Mocked `/v2/speak`.
 *
 * PRD §5.4: the automated suite must pass with a mocked /v2/speak — CI needs no
 * live API key. This mock is injected at the SDK-client boundary via
 * `clientFactory`, so `lib/flux.js` runs its real frame-reading, wire logging,
 * and audio pipeline against synthetic frames.
 *
 * The frame SHAPES here are copied from the SDK's own types
 * (`src/api/resources/speak/resources/v2/types/`) so the mock cannot drift into
 * testing a protocol the server does not speak — with the deliberate exception of
 * `Warning.stripped[]`, which the SDK does not type at all (SDK_WATCH W-001) and
 * which is exactly what needs exercising.
 */

/** Mirrors the binary shapes `lib/flux.js` accepts, so the mock cannot diverge. */
function isBinaryLike(value) {
  if (value === null || typeof value !== "object") return false;
  if (typeof Blob !== "undefined" && value instanceof Blob) return true;
  if (Buffer.isBuffer(value)) return true;
  if (value instanceof ArrayBuffer) return true;
  return ArrayBuffer.isView(value);
}

/** 16-bit PCM: `leadingSilenceMs` of digital silence, then a tone. */
export function makePcm({ sampleRate = 24000, leadingSilenceMs = 350, toneMs = 400, peak = 32767 } = {}) {
  const silent = Math.round((leadingSilenceMs / 1000) * sampleRate);
  const tone = Math.round((toneMs / 1000) * sampleRate);
  const samples = new Int16Array(silent + tone);
  for (let i = 0; i < tone; i += 1) {
    samples[silent + i] = Math.round(peak * Math.sin((2 * Math.PI * 220 * i) / sampleRate));
  }
  return Buffer.from(samples.buffer, samples.byteOffset, samples.length * 2);
}

/**
 * Build a fake client whose socket replays a scripted frame sequence.
 *
 * `frames` is emitted in order after `open`. Buffers are delivered as binary
 * audio; objects are delivered as JSON control frames.
 */
export function mockClientFactory({ frames, pcm, onConnect } = {}) {
  return function factory({ apiKey, baseUrl }) {
    if (onConnect) onConnect({ apiKey, baseUrl });

    return {
      speak: {
        v2: {
          async createConnection(args) {
            const handlers = new Map();
            let closed = false;

            const emit = (event, payload) => {
              const list = handlers.get(event);
              if (!list) return;
              for (const fn of list) fn(payload);
            };

            const script =
              frames ||
              defaultFrames({
                pcm: pcm || makePcm(),
                sampleRate: args.sample_rate || 24000,
              });

            return {
              args,
              on(event, fn) {
                if (!handlers.has(event)) handlers.set(event, []);
                handlers.get(event).push(fn);
              },
              sendSpeak() {},
              sendFlush() {},
              close() {
                if (closed) return;
                closed = true;
                emit("close");
              },
              connect() {
                // Async so callers can attach handlers exactly as they would with
                // a real socket.
                setImmediate(() => {
                  emit("open");
                  for (const frame of script) {
                    if (closed) return;
                    // Any binary shape passes through untouched — the real SDK
                    // delivers Blob under Node, and stringifying one yields "{}",
                    // which would silently turn audio into an empty control frame
                    // and make this mock test something the server never sees.
                    if (isBinaryLike(frame)) emit("message", frame);
                    else emit("message", JSON.stringify(frame));
                  }
                });
              },
            };
          },
        },
      },
    };
  };
}

/**
 * The well-behaved sequence.
 *
 * **Frame ORDER here matches what staging actually does**, verified by probe:
 *
 *     Connected → SpeechStarted → Flushed → audio… → SpeechMetadata
 *
 * `Flushed` arrives ~2ms after the Flush is sent and roughly 4s BEFORE the audio
 * finishes — it acknowledges the flush request, it does not terminate the turn.
 * `SpeechMetadata` is the terminator, and its `audio_duration_ms` matches the audio
 * actually delivered.
 *
 * The original version of this mock had it backwards (audio → SpeechMetadata →
 * Flushed), which taught the client to treat `Flushed` as completion. That passed
 * every test and failed against the real endpoint, closing the socket before any
 * audio arrived. Kept in this order deliberately so the mock cannot teach that
 * lesson again.
 *
 * Two frames here that staging does NOT currently send — see FLAGS.md F-012:
 *   - `SessionMetadata` (never observed)
 *   - `Warning` / `INPUT_MARKUP_STRIPPED` (never observed, even with markup input)
 * They are retained because they are the documented contract and BYOM must handle
 * them when they land. Tests that depend on them are testing the spec, not staging.
 */
export function defaultFrames({ pcm, sampleRate = 24000 } = {}) {
  return [
    { type: "Connected", request_id: "mock-request" },
    { type: "SessionMetadata", sample_rate: sampleRate },
    {
      type: "Warning",
      code: "INPUT_MARKUP_STRIPPED",
      description: "Input markup was removed before synthesis.",
      // Not on the SDK's Warning type. SDK_WATCH W-001.
      stripped: [
        { raw: "<s>", source: "ssml", replacement: null },
        { raw: "</s>", source: "ssml", replacement: null },
        { raw: '<break time="1s"/>', source: "ssml", replacement: null },
      ],
    },
    { type: "SpeechStarted", speech_id: "mock-speech" },
    // Ack, not completion. Ordered here on purpose.
    { type: "Flushed", speech_id: "mock-speech" },
    pcm || makePcm({ sampleRate }),
    {
      type: "SpeechMetadata",
      speech_id: "mock-speech",
      audio_duration_ms: 400,
      input_character_count: 87,
      billable_character_count: 62,
      // `breaks_applied` is returned by staging but is absent from the SDK's
      // ControlsApplied type — SDK_WATCH W-006.
      controls_applied: { pronunciations_applied: 0, breaks_applied: 0, pronunciation_warnings: 0 },
    },
  ];
}
