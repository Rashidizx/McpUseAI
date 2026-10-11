import type { Site } from "../shared/protocol.js";

/**
 * Built-in chat sites.
 *
 * These selectors are best knowledge, not measurements: sites redeploy and
 * class names rot. That is why every list has fallbacks, why the UI has a
 * "check site" button that reports which selector matched, and why the user
 * can override any list from settings without rebuilding anything.
 * Structural selectors (roles, data attributes, aria labels) come first
 * because hashed CSS classes change on every deploy.
 */
export const DEFAULT_SITES: readonly Site[] = [
  {
    id: "chatgpt",
    label: "ChatGPT",
    url: "https://chatgpt.com/",
    match: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
    composer: ["#prompt-textarea", "div[contenteditable='true'].ProseMirror", "form textarea"],
    send: ["button[data-testid='send-button']", "#composer-submit-button", "button[aria-label*='Send']"],
    stop: ["[data-message-role='assistant']:not([data-message-complete])", "button[data-testid='stop-button']", "button[aria-label*='Stop']"],
    // 2026-10 redesign: messages are li[data-message-role]; the older attribute is kept as a fallback.
    reply: ["[data-message-role='assistant']", "[data-assistant-markdown]", "[data-message-author-role='assistant']"],
  },
  {
    id: "gemini",
    label: "Gemini",
    url: "https://gemini.google.com/app",
    match: ["https://gemini.google.com/*"],
    composer: ["rich-textarea .ql-editor", "div.ql-editor[contenteditable='true']", "rich-textarea [contenteditable='true']"],
    send: ["button.send-button", "button[aria-label*='Send']", "button[aria-label*='ارسال']"],
    stop: ["button.send-button.stop", "button[aria-label*='Stop']", "button[aria-label*='توقف']"],
    reply: ["model-response message-content", "model-response", ".model-response-text"],
  },
  {
    id: "claude",
    label: "Claude",
    url: "https://claude.ai/new",
    match: ["https://claude.ai/*"],
    composer: ["div.ProseMirror[contenteditable='true']", "[contenteditable='true'][data-placeholder]", "fieldset [contenteditable='true']"],
    send: ["button[aria-label='Send message']", "button[aria-label*='Send']"],
    stop: ["button[aria-label='Stop response']", "button[aria-label*='Stop']", "[data-is-streaming='true']"],
    reply: [".font-claude-response", "[data-is-streaming]", ".font-claude-message"],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    url: "https://chat.deepseek.com/",
    match: ["https://chat.deepseek.com/*"],
    composer: ["textarea#chat-input", "textarea", "div[contenteditable='true']"],
    // Measured 2026-10-09 with "check site": the send control is an unlabelled
    // icon div; the same div shows a square while the model is writing.
    send: ["div[role='button'].ds-button--primary.ds-button--filled", "div[role='button'].ds-button--primary"],
    stop: ["div[role='button'].ds-button--primary svg rect", "button[aria-label*='Stop']"],
    reply: [".ds-markdown", "[class*='ds-markdown']"],
  },
];

/**
 * Built-ins merged with the user's overrides. An override replaces the whole
 * field it names and nothing else; an override with an unknown id is a site of
 * its own, which is how a new chat site is added without touching code.
 */
export function mergeSites(overrides: Record<string, Partial<Site>>): Site[] {
  const merged = DEFAULT_SITES.map((site) => ({ ...site, ...(overrides[site.id] ?? {}), id: site.id }));
  for (const [id, extra] of Object.entries(overrides)) {
    if (merged.some((site) => site.id === id)) continue;
    const candidate = { id, label: id, url: "", match: [], composer: [], send: [], stop: [], reply: [], ...extra };
    if (isCompleteSite(candidate)) merged.push({ ...candidate, id });
  }
  return merged;
}

/** Whether a value is usable as a site. Runs on user input from the UI. */
export function isCompleteSite(value: unknown): value is Site {
  if (value === null || typeof value !== "object") return false;
  const site = value as Record<string, unknown>;
  const strings = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === "string");
  return (
    typeof site.id === "string" &&
    /^[a-z0-9-]{1,32}$/.test(site.id) &&
    typeof site.label === "string" &&
    typeof site.url === "string" &&
    /^https:\/\//.test(site.url) &&
    strings(site.match) &&
    (site.match as string[]).length > 0 &&
    strings(site.composer) &&
    (site.composer as string[]).length > 0 &&
    strings(site.send) &&
    strings(site.stop) &&
    strings(site.reply) &&
    (site.reply as string[]).length > 0
  );
}
