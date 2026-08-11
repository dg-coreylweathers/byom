/**
 * BYOM browser client.
 *
 * Imports the same `markup.js` the server does, so the live tag count shown while
 * typing comes from the identical strip contract — PRD §5.2's mirror. The server
 * remains the authority; where they differ, the difference is rendered.
 */

import { analyze } from "./markup.js";

const $ = (id) => document.getElementById(id);

const el = {
  form: $("form"),
  text: $("text"),
  voice: $("voice"),
  run: $("run"),
  reset: $("reset"),
  counter: $("counter"),
  ring: $("ring"),
  error: $("error"),
  report: $("report"),
  submitted: $("n-submitted"),
  billed: $("n-billed"),
  billedNote: $("billed-note"),
  stripped: $("n-stripped"),
  disagreement: $("disagreement"),
  provenance: $("provenance"),
  tags: $("tags"),
  tagsEmpty: $("tags-empty"),
  wave: $("wave"),
  audio: $("audio"),
  audioMeta: $("audio-meta"),
  audioNotes: $("audio-notes"),
  logBody: $("log-body"),
  envChrome: $("env-chrome"),
};

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let config = { maxInputChars: 900, voices: [], defaultVoice: "", preset: "" };
let objectUrl = null;

/* ── Live mirror ─────────────────────────────────────────────────────────────── */

function updateCounter() {
  const value = el.text.value;
  const a = analyze(value);
  const over = a.submitted > config.maxInputChars;

  el.counter.textContent = `${a.submitted}/${config.maxInputChars} · ${a.stripped.length} tag${
    a.stripped.length === 1 ? "" : "s"
  } · ${a.billed} billable`;
  if (over) el.counter.setAttribute("data-over", "");
  else el.counter.removeAttribute("data-over");

  el.run.disabled = over || value.trim() === "";
}

/* ── Number rolling ──────────────────────────────────────────────────────────── */

/**
 * Roll the billed figure from the submitted count down to the billed count.
 * PRD §3's receipt reveal: the total rolls from submitted → billed while the tags
 * strike out. Writes only the text node so the `<small>` note is preserved, and
 * the cell has a fixed height so nothing reflows.
 */
function rollTo(node, from, to, ms = 520) {
  const write = (v) => {
    node.firstChild.nodeValue = String(v);
  };
  if (reduceMotion || from === to) {
    write(to);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - start) / ms);
    // Ease-out so it settles rather than stopping dead.
    const eased = 1 - (1 - p) ** 3;
    write(Math.round(from + (to - from) * eased));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Strike the tags out in sequence, in document order. */
function strikeSequence(items) {
  if (reduceMotion) {
    for (const li of items) li.setAttribute("data-struck", "");
    return;
  }
  items.forEach((li, i) => {
    setTimeout(() => li.setAttribute("data-struck", ""), 90 + i * 110);
  });
}

/* ── Rendering ───────────────────────────────────────────────────────────────── */

function renderProvenance(upstream) {
  if (!upstream) {
    el.provenance.hidden = true;
    return;
  }
  // Deliberately plain and permanent. A number that did not come from the API is
  // marked, per PRD §3's rule for locally-computed figures.
  el.provenance.innerHTML = "";
  const strong = document.createElement("strong");
  strong.textContent = "Reference upstream";
  const p = document.createElement("span");
  p.textContent =
    "This instance is connected to a reference implementation of the streaming endpoint, not to the API. " +
    "The protocol and the character accounting are accurate. The audio is structured tone, not synthesized speech, " +
    "and the figures below are reference-reported rather than API-reported.";
  el.provenance.append(strong, p);
  el.provenance.hidden = false;
}

function renderReceipt(data) {
  el.submitted.textContent = String(data.submitted.value);
  el.stripped.textContent = String(data.submitted.value - data.billed.value);

  // Start at the submitted figure and roll down to what was actually billed.
  el.billed.firstChild.nodeValue = String(data.submitted.value);
  rollTo(el.billed, data.submitted.value, data.billed.value);

  // Say where the number came from, always — including when it is authoritative.
  if (data.billed.note) {
    el.billedNote.textContent = data.billed.note;
  } else if (data.billed.origin === "api") {
    el.billedNote.textContent = "Reported by the API for this turn.";
  } else {
    el.billedNote.textContent = "";
  }
}

function renderTags(data) {
  el.tags.textContent = "";
  const entries = data.stripped.entries;

  if (entries.length === 0) {
    el.tagsEmpty.hidden = false;
    return;
  }
  el.tagsEmpty.hidden = true;

  // Advice is keyed by raw span so the two lists cannot drift out of alignment.
  const adviceFor = new Map(data.advice.map((a) => [a.raw, a]));
  const items = [];

  for (const entry of entries) {
    const li = document.createElement("li");

    const code = document.createElement("code");
    // textContent, never innerHTML — this is untrusted pasted input.
    code.textContent = entry.raw;

    const advice = document.createElement("div");
    advice.className = "advice";
    const known = adviceFor.get(entry.raw);
    const replacement = entry.replacement || (known && known.advice) || null;

    if (replacement) {
      advice.textContent = replacement;
    } else {
      // PRD §5.4: say "no direct equivalent" where none exists. Never invent one.
      advice.textContent = "No direct equivalent.";
      advice.setAttribute("data-none", "");
    }

    li.append(code, advice);
    el.tags.append(li);
    items.push(li);
  }

  strikeSequence(items);
}

function renderDisagreement(notes) {
  if (!notes || notes.length === 0) {
    el.disagreement.hidden = true;
    return;
  }
  el.disagreement.textContent = "";
  const strong = document.createElement("strong");
  strong.textContent = "Mirror and server disagree";
  const ul = document.createElement("ul");
  for (const note of notes) {
    const li = document.createElement("li");
    li.textContent = note;
    ul.append(li);
  }
  el.disagreement.append(strong, ul);
  el.disagreement.hidden = false;
}

function renderAudio(audio) {
  el.wave.textContent = "";
  for (const v of audio.envelope) {
    const bar = document.createElement("span");
    bar.style.height = `${Math.max(1, Math.round(v * 100))}%`;
    el.wave.append(bar);
  }

  if (objectUrl) URL.revokeObjectURL(objectUrl);
  const bytes = Uint8Array.from(atob(audio.wav), (c) => c.charCodeAt(0));
  objectUrl = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
  el.audio.src = objectUrl;

  const peak = audio.peak.dbfs === null ? "silent" : `${audio.peak.dbfs.toFixed(2)} dBFS`;
  el.audioMeta.textContent = `${audio.durationMs} ms · ${audio.sampleRate} Hz · peak ${peak}`;

  // Both PRD §5.3 disclosures. Shown, not hidden.
  const notes = [];
  if (audio.trim.wasTrimmed) {
    notes.push(
      `${Math.round(audio.trim.trimmedMs)} ms of leading silence was trimmed server-side, ` +
        `keeping a ${audio.trim.preRollMs} ms pre-roll so the attack is not clipped.`,
    );
  }
  if (audio.peak.needsNormalize) {
    notes.push(
      `Output peaks at ${peak}, above the −0.5 dBFS threshold — there is no headroom. ` +
        "Normalize before mixing this with anything else.",
    );
  }

  if (notes.length === 0) {
    el.audioNotes.hidden = true;
    return;
  }
  el.audioNotes.textContent = "";
  const strong = document.createElement("strong");
  strong.textContent = "Applied to this audio";
  const ul = document.createElement("ul");
  for (const n of notes) {
    const li = document.createElement("li");
    li.textContent = n;
    ul.append(li);
  }
  el.audioNotes.append(strong, ul);
  el.audioNotes.hidden = false;
}

function renderLog(wire) {
  el.logBody.textContent = "";
  for (const entry of wire) {
    const tr = document.createElement("tr");

    const seq = document.createElement("td");
    seq.className = "seq";
    seq.textContent = String(entry.seq);

    const dir = document.createElement("td");
    dir.className = "dir";
    dir.dataset.dir = entry.direction;
    dir.textContent = entry.direction === "send" ? "→" : "←";

    const type = document.createElement("td");
    type.className = "type";
    type.textContent = entry.type;
    if (!entry.recognized) type.setAttribute("data-unrecognized", "");

    const body = document.createElement("td");
    if (entry.binary) {
      body.textContent = `${entry.bytes} bytes`;
    } else {
      // Verbatim, including any `source` field. PRD §3 permits vendor/format names
      // in the log; UI chrome renders none.
      const pre = document.createElement("pre");
      pre.textContent = JSON.stringify(entry.frame);
      body.append(pre);
    }

    tr.append(seq, dir, type, body);
    el.logBody.append(tr);
  }
}

/* ── Submit ──────────────────────────────────────────────────────────────────── */

function setBusy(busy) {
  el.run.disabled = busy;
  if (busy) el.ring.setAttribute("data-active", "");
  else el.ring.removeAttribute("data-active");
}

function showError(message) {
  el.error.textContent = "";
  const strong = document.createElement("strong");
  strong.textContent = "Could not complete the report";
  const span = document.createElement("span");
  span.textContent = message;
  el.error.append(strong, span);
  el.error.hidden = false;
}

el.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  el.error.hidden = true;
  setBusy(true);

  try {
    const res = await fetch("/api/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: el.text.value, voice: el.voice.value }),
    });
    const data = await res.json();

    if (!res.ok) {
      showError(data.error || `request failed (${res.status})`);
      el.report.hidden = true;
      return;
    }

    renderProvenance(data.upstream);
    renderReceipt(data);
    renderDisagreement(data.disagreement);
    renderTags(data);
    renderAudio(data.audio);
    renderLog(data.wire);
    el.report.hidden = false;
  } catch (err) {
    showError(err && err.message ? err.message : "network error");
  } finally {
    setBusy(false);
  }
});

el.reset.addEventListener("click", () => {
  el.text.value = config.preset;
  el.report.hidden = true;
  el.error.hidden = true;
  updateCounter();
});

el.text.addEventListener("input", updateCounter);

/* ── Boot ────────────────────────────────────────────────────────────────────── */

(async function boot() {
  try {
    const res = await fetch("/api/config");
    config = await res.json();
  } catch {
    showError("could not load configuration");
    return;
  }

  for (const voice of config.voices) {
    const option = document.createElement("option");
    option.value = voice;
    option.textContent = voice;
    if (voice === config.defaultVoice) option.selected = true;
    el.voice.append(option);
  }

  el.text.value = config.preset;
  el.envChrome.textContent = `Cap ${config.maxInputChars} chars`;
  updateCounter();
})();
