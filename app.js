const $ = (id) => document.getElementById(id);
const input = $("input");
const output = $("output");
const status = $("status");
const keyBtn = $("key-btn");

const MODEL = "gemini-flash-latest";
const KEY_STORAGE = "gemini_api_key";
const DEBOUNCE_MS = 700;

const SYSTEM_PROMPT = `Convert the user's rough draft into a well-engineered prompt for an AI coding/writing assistant.

Output format (Markdown), include only the sections that apply:
**Context:** background facts the user actually stated.
**Task:** the single concrete thing the user is asking the AI to do, as an imperative.
**Constraints:** explicit limits, requirements, or preferences the user mentioned (stack, style, length, must/must-not).
**Output format:** how the user wants the answer (only if the user implied one).

Hard rules:
- Use ONLY information present in the user's draft. Do not invent facts, requirements, tech choices, or background.
- Translate any non-English text to English.
- Replace pronouns and shorthand with explicit nouns. Resolve slang.
- Be terse. Each section is one short sentence or a tight bullet list. Skip empty sections entirely.
- No preamble, no commentary, no sign-off, no code fences around the whole output. Output only the prompt.`;

function setStatus(text, cls) {
  status.textContent = text;
  status.className = "status " + (cls || "idle");
}

function getKey() {
  return localStorage.getItem(KEY_STORAGE) || "";
}

function promptForKey() {
  const current = getKey();
  const next = window.prompt("Gemini API key (stored locally in your browser):", current);
  if (next === null) return;
  localStorage.setItem(KEY_STORAGE, next.trim());
  setStatus(next.trim() ? "key saved" : "key cleared", "ok");
}

keyBtn.addEventListener("click", promptForKey);

function flash(btn, label) {
  const old = btn.textContent;
  btn.textContent = label;
  setTimeout(() => (btn.textContent = old), 900);
}

document.querySelectorAll("button[data-copy]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const target = $(btn.dataset.copy);
    if (!target.value) return;
    try {
      await navigator.clipboard.writeText(target.value);
      flash(btn, "Copied");
    } catch {
      target.select();
      document.execCommand("copy");
    }
  });
});

document.querySelectorAll("button[data-paste]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const target = $(btn.dataset.paste);
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      target.value = text;
      target.focus();
      flash(btn, "Pasted");
      schedule();
    } catch {
      flash(btn, "Blocked");
    }
  });
});

document.querySelectorAll("button[data-clear]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = $(btn.dataset.clear);
    target.value = "";
    output.value = "";
    target.focus();
    setStatus("idle", "idle");
  });
});

let pending = null;
let inflight = null;

async function callGemini(text, model, signal) {
  const key = getKey();
  if (!key) throw new Error("Set your API key (top right).");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${detail.slice(0, 200)}`);
  }

  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || "").join("").trim();
}

async function rewrite() {
  const text = input.value.trim();
  if (!text) {
    output.value = "";
    setStatus("idle", "idle");
    return;
  }

  if (inflight) inflight.abort();
  const ctrl = new AbortController();
  inflight = ctrl;

  setStatus("rewriting…", "working");
  try {
    const result = await callGemini(text, MODEL, ctrl.signal);
    output.value = result;
    setStatus("ready", "ok");
  } catch (err) {
    if (err.name === "AbortError") return;
    setStatus(err.message || "error", "err");
  } finally {
    if (inflight === ctrl) inflight = null;
  }
}

function schedule() {
  clearTimeout(pending);
  pending = setTimeout(rewrite, DEBOUNCE_MS);
}

input.addEventListener("input", schedule);

if (!getKey()) setStatus("set API key →", "warn");
