const $ = (id) => document.getElementById(id);
const input = $("input");
const output = $("output");
const status = $("status");
const keyBtn = $("key-btn");

const MODEL = "gemini-flash-latest";
const KEY_STORAGE = "gemini_api_key";
const DEBOUNCE_MS = 700;

const SYSTEM_PROMPT = `Rewrite the user's Markdown draft so an AI assistant can read and act on it without ambiguity.
Rules:
- Preserve the user's intent and facts. Do not invent information.
- Replace pronouns and vague references with explicit nouns.
- Resolve idioms, slang, and shorthand into plain language.
- Keep or improve Markdown structure: headings, bullet lists, fenced code blocks, tables.
- Keep it concise. No preamble. No commentary. Output only the rewritten Markdown.`;

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

document.querySelectorAll("button[data-copy]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const target = $(btn.dataset.copy);
    if (!target.value) return;
    try {
      await navigator.clipboard.writeText(target.value);
      const old = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = old), 900);
    } catch {
      target.select();
      document.execCommand("copy");
    }
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
