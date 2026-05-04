const $ = (id) => document.getElementById(id);
const input = $("input");
const output = $("output");
const status = $("status");
const keyBtn = $("key-btn");
const autoBtn = $("auto-btn");

const MODEL = "gemini-flash-latest";
const KEY_STORAGE = "gemini_api_key";
const AUTO_STORAGE = "auto_rewrite";
const DEBOUNCE_MS = 700;
const isMac = navigator.platform.toLowerCase().includes("mac");
const RUN_HINT = isMac ? "⌘↵" : "Ctrl+↵";

const SYSTEM_PROMPT = `You are a prompt engineer. The user gives you a rough draft of something they want to ask an AI assistant. Rewrite it as the strongest possible prompt — the version that would let a capable AI produce the best answer in one shot.

Think from the receiving AI's perspective: "To answer this well, what do I need explicit about?" Then structure the user's words to provide exactly that.

Output sections (Markdown, include only those that apply):
**Role:** one line, only if a specific expertise would clearly improve the answer.
**Context:** the relevant facts the user stated, in plain explicit language.
**Task:** one imperative sentence — the exact thing the AI should do.
**Requirements:** bulleted constraints the user mentioned (stack, style, length, must/must-not).
**Output format:** how the answer should be shaped (steps, code, table, etc.) — infer the obvious one from the task.
**Open questions:** 1–3 short bullets listing genuinely missing info that would materially change the answer. Phrase as direct questions to the user.

Handling unknowns:
- If the user did not provide a detail you'd need, do NOT fabricate it. Either put it under **Open questions**, or use a clearly marked placeholder like \`[your stack]\`, \`[target audience]\`.
- Do not invent constraints, requirements, or background facts.

Style:
- Translate non-English input to English. Resolve pronouns, slang, shorthand.
- Be terse. Each section is one sentence or a tight bullet list.
- Skip empty sections entirely. Most prompts won't need all six.
- No preamble, no commentary, no sign-off, no outer code fence. Output only the prompt itself.`;

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

async function streamGemini(text, model, signal, onChunk) {
  const key = getKey();
  if (!key) throw new Error("Set your API key (top right).");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;

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

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${detail.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const json = line.slice(5).trim();
      if (!json) continue;
      try {
        const data = JSON.parse(json);
        const chunk = (data?.candidates?.[0]?.content?.parts || [])
          .map((p) => p.text || "")
          .join("");
        if (chunk) onChunk(chunk);
      } catch { /* skip malformed line */ }
    }
  }
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

  output.value = "";
  setStatus("rewriting…", "working");
  try {
    let acc = "";
    await streamGemini(text, MODEL, ctrl.signal, (chunk) => {
      acc += chunk;
      output.value = acc;
      output.scrollTop = output.scrollHeight;
    });
    output.value = acc.trim();
    setStatus("ready", "ok");
  } catch (err) {
    if (err.name === "AbortError") return;
    setStatus(err.message || "error", "err");
  } finally {
    if (inflight === ctrl) inflight = null;
  }
}

function isAuto() {
  return localStorage.getItem(AUTO_STORAGE) !== "0";
}

function renderAutoBtn() {
  autoBtn.textContent = isAuto() ? "Auto: on" : `Auto: off (${RUN_HINT})`;
}

function setAuto(on) {
  localStorage.setItem(AUTO_STORAGE, on ? "1" : "0");
  renderAutoBtn();
  if (on) schedule();
}

autoBtn.addEventListener("click", () => setAuto(!isAuto()));

function schedule() {
  clearTimeout(pending);
  if (!isAuto()) return;
  pending = setTimeout(rewrite, DEBOUNCE_MS);
}

input.addEventListener("input", schedule);

document.addEventListener("keydown", (e) => {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod && e.key === "Enter") {
    e.preventDefault();
    clearTimeout(pending);
    rewrite();
  }
});

renderAutoBtn();
if (!getKey()) setStatus("set API key →", "warn");
