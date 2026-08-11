/**
 * UI-chrome constraints. Static-source assertions, because the hard constraint is
 * about what ships, and these files ARE what ships.
 *
 * Closes the one PRD §5.4 item the server-side suite could only partly cover:
 * "No vendor names in UI chrome; `source` field visible only in the log."
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createApp, DEFAULT_PRESET } from "../server.js";
import { mockClientFactory } from "./mock-speak.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");

const UI_FILES = ["index.html", "app.js", "styles.css", "markup.js"];

/**
 * Competitor and vendor names. Word-boundary matched so ordinary words are not
 * false positives.
 */
const VENDOR_NAMES =
  /\b(amazon|aws|polly|google|azure|microsoft|elevenlabs|eleven ?labs|openai|open ?ai|play\.?ht|playht|resemble|murf|wellsaid|well ?said|speechify|cartesia|rime|lmnt|coqui|nuance|ibm ?watson|watson|assemblyai|assembly ?ai|rev\.?ai|speechmatics|whisper)\b/i;

test("no vendor or competitor name appears in any shipped UI file", async () => {
  for (const file of UI_FILES) {
        const source = await readFile(path.join(PUBLIC, file), "utf8");
    const match = source.match(VENDOR_NAMES);
    assert.equal(match, null, `${file} contains a vendor name: ${match && match[0]}`);
  }
});

test("no vendor or competitor name appears in the README", async () => {
  // The README is shipped copy on a public repo, so it is in scope for the same
  // constraint as the UI.
  const readme = await readFile(path.join(ROOT, "README.md"), "utf8");
  const match = readme.match(VENDOR_NAMES);
  assert.equal(match, null, `README.md contains a vendor name: ${match && match[0]}`);
});

test("the README documents the two required env vars and why they have no defaults", async () => {
  const readme = await readFile(path.join(ROOT, "README.md"), "utf8");
  assert.match(readme, /DEEPGRAM_BASE_URL/);
  assert.match(readme, /DEEPGRAM_STAGING_API_KEY/);
  // The production-fallback hazard is the single most important thing to convey.
  assert.match(readme, /production/i);
});

test("no vendor name appears in alt text, titles, or aria labels", async () => {
  const html = await readFile(path.join(PUBLIC, "index.html"), "utf8");
  const attrs = html.match(/(alt|title|aria-label|aria-description)="([^"]*)"/gi) || [];
  for (const attr of attrs) {
    assert.equal(VENDOR_NAMES.test(attr), false, `vendor name in attribute: ${attr}`);
  }
});

test("the UI never renders a `source` field outside the wire log", async () => {
  const app = await readFile(path.join(PUBLIC, "app.js"), "utf8");

  // The log renders whole frames verbatim via JSON.stringify, which legitimately
  // includes `source`. What must not exist is a read of `.source` used to build
  // any other piece of UI.
  const reads = app.match(/\.source\b/g) || [];
  assert.deepEqual(reads, [], "app.js reads a `source` field; it belongs only in the verbatim log");

  // And the log path must be the verbatim one.
  assert.match(app, /JSON\.stringify\(entry\.frame\)/, "the log should render frames verbatim");
});

test("the UI uses textContent for pasted input, never innerHTML", async () => {
  const app = await readFile(path.join(PUBLIC, "app.js"), "utf8");
  // innerHTML is permitted only for clearing (= ""), never for interpolation.
  const assignments = app.match(/\.innerHTML\s*=\s*(.+)/g) || [];
  for (const line of assignments) {
    assert.match(line, /=\s*""\s*;?$/, `innerHTML used with content: ${line.trim()}`);
  }
  assert.match(app, /code\.textContent = entry\.raw/, "pasted spans must be set as text");
});

test("the receipt cell has a fixed height so the rolling total cannot shift layout", async () => {
  const css = await readFile(path.join(PUBLIC, "styles.css"), "utf8");
  assert.match(css, /font-variant-numeric:\s*tabular-nums/, "numbers must be tabular");
  assert.match(css, /\.cell dd\s*\{[^}]*min-height/s, "the figure cell needs a reserved height");
  assert.match(css, /\.ring-slot\s*\{[^}]*min-height/s, "the ring slot must be reserved");
});

test("reduced motion is respected for both the ring and the strike-out", async () => {
  const css = await readFile(path.join(PUBLIC, "styles.css"), "utf8");
  const app = await readFile(path.join(PUBLIC, "app.js"), "utf8");

  const block = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/);
  assert.ok(block, "a reduced-motion block must exist");
  assert.match(block[0], /animation:\s*none/, "the ring must stop");

  // The JS-driven number roll and strike sequence must also honour it.
  assert.match(app, /prefers-reduced-motion: reduce/, "app.js must check reduced motion");
  assert.match(app, /if \(reduceMotion/, "and short-circuit its animations");
});

test("no box-shadow declaration is used anywhere; depth comes from gradients", async () => {
  const css = await readFile(path.join(PUBLIC, "styles.css"), "utf8");
  // Matches the declaration, not the word — naming it in a comment is fine.
  assert.equal(/box-shadow\s*:/.test(css), false, "PRD §3 forbids box-shadow declarations");
  assert.match(css, /radial-gradient/, "glow should be gradient-based");
});

test("exactly one mint accent hue is used as the signal color", async () => {
  const css = await readFile(path.join(PUBLIC, "styles.css"), "utf8");
  // Stripped must be a neutral, not a second hue, so the single-accent rule holds.
  assert.match(css, /--sig-kept:\s*var\(--mint\)/);
  assert.match(css, /--sig-stripped:\s*var\(--ink-dimmer\)/);
});

test("the shared markup mirror is served to the browser", async (t) => {
  const app = createApp({
    env: {
      DEEPGRAM_BASE_URL: "wss://staging.example.internal",
      DEEPGRAM_STAGING_API_KEY: "k",
    },
    clientFactory: mockClientFactory(),
  });
  await new Promise((resolve) => app.server.listen(0, resolve));
  const port = app.server.address().port;
  t.after(() => new Promise((resolve) => app.server.close(resolve)));

  // The browser imports the same file the server does — the inventory cannot fork.
  const res = await fetch(`http://127.0.0.1:${port}/markup.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /javascript/);
  const body = await res.text();
  assert.match(body, /export function analyze/);

  const index = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /Bring Your Own Markup/);
});

test("the audio section carries its own voice selector", async () => {
  const html = await readFile(path.join(PUBLIC, "index.html"), "utf8");
  const app = await readFile(path.join(PUBLIC, "app.js"), "utf8");

  // The selector must sit inside the audio panel, next to the audio it changes.
  const audioPanel = html.slice(html.indexOf("Audio as spoken"), html.indexOf("Wire log"));
  assert.match(audioPanel, /id="voice-audio"/, "voice selector belongs in the audio section");

  // Changing it re-runs the same text, and the two selectors stay in sync so there
  // is one selected voice rather than two competing ones.
  assert.match(app, /voiceAudio\.addEventListener\("change"/);
  assert.match(app, /el\.voice\.value = el\.voiceAudio\.value/);
  assert.match(app, /el\.voiceAudio\.value = el\.voice\.value/);
  assert.match(app, /await run\(\)/, "the change handler should re-run the report");
});

test("the how-to block explains the intended interaction", async () => {
  const html = await readFile(path.join(PUBLIC, "index.html"), "utf8");
  const howto = html.slice(html.indexOf('class="howto"'), html.indexOf("</section>", html.indexOf('class="howto"')));
  // The load-bearing instruction: do not clean the input up first.
  assert.match(howto, /don't tidy it first|Don't tidy it first/i);
  assert.match(howto, /never logged/i, "must state the text-retention position");
  assert.equal((howto.match(/<li>/g) || []).length >= 4, true, "should be a short numbered sequence");
});

test("the sample loader keeps a fixed-height note so the form never reflows", async () => {
  const css = await readFile(path.join(PUBLIC, "styles.css"), "utf8");
  assert.match(css, /\.samples-note\s*\{[^}]*min-height/s, "the note line needs a reserved height");
});

test("the default preset is what the UI loads, and it is the correct one", async (t) => {
  const app = createApp({
    env: {
      DEEPGRAM_BASE_URL: "wss://staging.example.internal",
      DEEPGRAM_STAGING_API_KEY: "k",
    },
    clientFactory: mockClientFactory(),
  });
  await new Promise((resolve) => app.server.listen(0, resolve));
  const port = app.server.address().port;
  t.after(() => new Promise((resolve) => app.server.close(resolve)));

  const config = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
  assert.equal(config.preset, DEFAULT_PRESET);
  assert.equal(config.preset.length, 87);
});
