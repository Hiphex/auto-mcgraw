try {
  importScripts("../lib/shared.js");
} catch (error) {
  // Best effort; fallback behavior still works without shared helpers.
}

const shared = globalThis.AutoMcGrawShared || {
  createQuestionId: () => `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  parseAiResponseText: () => ({
    ok: false,
    error: { code: "parse_error", detail: "Shared parser unavailable." },
  }),
  rankTabs: (tabs) => tabs,
};

const MHE_URLS = ["https://learning.mheducation.com/*"];
const PROVIDERS = {
  chatgpt: {
    urls: ["https://chatgpt.com/*"],
    hosts: ["chatgpt.com"],
  },
  gemini: {
    urls: ["https://gemini.google.com/*"],
    hosts: ["gemini.google.com"],
  },
  deepseek: {
    urls: ["https://chat.deepseek.com/*", "https://deepseek.chat/*"],
    hosts: ["chat.deepseek.com", "deepseek.chat"],
  },
};

const providerState = {
  chatgpt: { tabId: null, windowId: null },
  gemini: { tabId: null, windowId: null },
  deepseek: { tabId: null, windowId: null },
};

let mheTabId = null;
let mheWindowId = null;
let lastActiveTabId = null;
let currentQuestionId = null;
let processingQuestion = false;
const activationTimes = {};

function logState(questionId, phase, status, level = "log") {
  const id = questionId || "-";
  const text = `[AutoMcGraw][${id}][${phase}] ${status}`;
  const writer = console[level] || console.log;
  writer(text);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function classifyError(error) {
  const detail =
    (error && (error.detail || error.message)) || "Unknown runtime error.";
  const source = String(detail).toLowerCase();

  if (source.includes("no tab with id")) {
    return { code: "tab_missing", detail };
  }
  if (
    source.includes("receiving end does not exist") ||
    source.includes("could not establish connection")
  ) {
    return { code: "script_not_ready", detail };
  }
  if (source.includes("timeout")) {
    return { code: "timeout", detail };
  }
  if (source.includes("parse")) {
    return { code: "parse_error", detail };
  }
  return { code: "unknown", detail };
}

function parseHostname(url) {
  try {
    return new URL(url).hostname;
  } catch (error) {
    return "";
  }
}

function detectProviderFromUrl(url) {
  const host = parseHostname(url);
  if (host.includes("chatgpt.com")) return "chatgpt";
  if (host.includes("gemini.google.com")) return "gemini";
  if (host.includes("deepseek.chat") || host.includes("chat.deepseek.com")) {
    return "deepseek";
  }
  return null;
}

function tabMatchesProvider(tab, provider) {
  if (!tab || !tab.url || !PROVIDERS[provider]) return false;
  const host = parseHostname(tab.url);
  return PROVIDERS[provider].hosts.some((allowed) => host === allowed);
}

function tabMatchesMhe(tab) {
  if (!tab || !tab.url) return false;
  return parseHostname(tab.url) === "learning.mheducation.com";
}

async function getTabSafely(tabId) {
  if (!tabId) return null;
  try {
    return await chrome.tabs.get(tabId);
  } catch (error) {
    return null;
  }
}

function chooseBestTab(candidates, preferredTabId) {
  const ranked = shared.rankTabs(candidates, {
    preferredTabId,
    lastActiveTabId,
    activationTimes,
  });
  return ranked[0] || null;
}

async function resolveMheTab(preferredTabId) {
  const existing = await getTabSafely(mheTabId);
  if (tabMatchesMhe(existing)) {
    mheWindowId = existing.windowId;
    return existing;
  }

  const tabs = await chrome.tabs.query({ url: MHE_URLS });
  const tab = chooseBestTab(tabs, preferredTabId);
  if (!tab) {
    mheTabId = null;
    mheWindowId = null;
    return null;
  }

  mheTabId = tab.id;
  mheWindowId = tab.windowId;
  return tab;
}

async function resolveProviderTab(provider, preferredTabId) {
  const state = providerState[provider];
  const existing = await getTabSafely(state.tabId);
  if (tabMatchesProvider(existing, provider)) {
    state.windowId = existing.windowId;
    return existing;
  }

  const tabs = await chrome.tabs.query({ url: PROVIDERS[provider].urls });
  const tab = chooseBestTab(tabs, preferredTabId);
  if (!tab) {
    state.tabId = null;
    state.windowId = null;
    return null;
  }

  state.tabId = tab.id;
  state.windowId = tab.windowId;
  return tab;
}

function sendMessageOnce(tabId, message, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject({
        code: "timeout",
        detail: `Message timeout after ${timeoutMs}ms for tab ${tabId}.`,
      });
    }, timeoutMs);

    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);

      if (chrome.runtime.lastError) {
        reject(classifyError(chrome.runtime.lastError));
        return;
      }

      resolve(response);
    });
  });
}

async function sendMessageWithRetry(tabId, message, options = {}) {
  const maxAttempts = options.maxAttempts || 5;
  const baseDelay = options.baseDelay || 300;
  const timeoutMs = options.timeoutMs || 8000;
  const questionId = options.questionId || null;
  const phase = options.phase || "message";
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await sendMessageOnce(tabId, message, timeoutMs);
    } catch (error) {
      lastError = classifyError(error);
      logState(
        questionId,
        phase,
        `attempt ${attempt}/${maxAttempts} failed (${lastError.code})`,
        "warn"
      );

      if (attempt < maxAttempts) {
        await sleep(baseDelay * attempt);
      }
    }
  }

  throw lastError || { code: "unknown", detail: "Retry attempts exhausted." };
}

async function ensureTabReady(tabId, questionId, phase) {
  await sendMessageWithRetry(
    tabId,
    { type: "ping", questionId },
    { questionId, phase: `${phase}:ping`, maxAttempts: 5, timeoutMs: 4000 }
  );
}

async function focusTab(tabId) {
  if (!tabId) return false;
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
    return true;
  } catch (error) {
    return false;
  }
}

async function getActiveProvider() {
  const data = await chrome.storage.sync.get("aiModel");
  const value = data.aiModel || "chatgpt";
  if (!PROVIDERS[value]) return "chatgpt";
  return value;
}

async function notifyMhe(message, questionId, phase = "mhe-notify") {
  const tab = await resolveMheTab(null);
  if (!tab) return;

  try {
    await ensureTabReady(tab.id, questionId, phase);
    await sendMessageWithRetry(tab.id, message, { questionId, phase });
  } catch (error) {
    const classified = classifyError(error);
    logState(
      questionId,
      phase,
      `unable to notify MHE (${classified.code})`,
      "warn"
    );
  }
}

async function processQuestion(message) {
  if (processingQuestion) {
    return;
  }
  processingQuestion = true;

  const provider = await getActiveProvider();
  const question = message.question || {};
  const questionId = question.questionId || shared.createQuestionId();
  question.questionId = questionId;
  currentQuestionId = questionId;

  logState(questionId, "question", `received for ${provider}`);

  try {
    const sourceTabId = message.sourceTabId || mheTabId || null;
    const mheTab = await resolveMheTab(sourceTabId);
    if (!mheTab) {
      throw {
        code: "tab_missing",
        detail: "No McGraw tab found for automation.",
      };
    }

    const aiTab = await resolveProviderTab(provider, null);
    if (!aiTab) {
      await notifyMhe(
        {
          type: "automationError",
          error: {
            questionId,
            provider,
            code: "tab_missing",
            detail: `Please open ${provider} in another tab before using automation.`,
          },
        },
        questionId
      );
      processingQuestion = false;
      return;
    }

    const sameWindow = mheTab.windowId === aiTab.windowId;
    if (sameWindow) {
      await focusTab(aiTab.id);
      await sleep(250);
    }

    await ensureTabReady(aiTab.id, questionId, "provider-ready");
    await sendMessageWithRetry(
      aiTab.id,
      {
        type: "receiveQuestion",
        question,
      },
      { questionId, phase: "provider-send" }
    );
    logState(questionId, "provider-send", "question dispatched");

    if (sameWindow && lastActiveTabId && lastActiveTabId !== aiTab.id) {
      setTimeout(() => {
        focusTab(lastActiveTabId);
      }, 750);
    }
  } catch (error) {
    const classified = classifyError(error);
    logState(
      questionId,
      "question",
      `dispatch failed (${classified.code})`,
      "error"
    );
    await notifyMhe(
      {
        type: "automationError",
        error: {
          questionId,
          provider,
          code: classified.code,
          detail: classified.detail,
        },
      },
      questionId
    );
  } finally {
    processingQuestion = false;
  }
}

function normalizeLegacyResponse(message) {
  const typeToProvider = {
    chatGPTResponse: "chatgpt",
    geminiResponse: "gemini",
    deepseekResponse: "deepseek",
  };
  const provider = typeToProvider[message.type] || "chatgpt";
  const questionId = currentQuestionId || shared.createQuestionId();
  const parsed = shared.parseAiResponseText(message.response || "");

  if (!parsed.ok) {
    return {
      error: {
        questionId,
        provider,
        code: parsed.error.code,
        detail: parsed.error.detail,
      },
    };
  }

  return {
    response: {
      questionId,
      provider,
      answer: parsed.payload.answer,
      explanation: parsed.payload.explanation,
      raw: parsed.payload.raw,
    },
  };
}

async function processResponse(message) {
  const normalized =
    message.type === "aiResponse" ? { response: message.response } : normalizeLegacyResponse(message);

  if (normalized.error) {
    await processAIError({ type: "aiError", error: normalized.error });
    return;
  }

  const payload = normalized.response || {};
  const questionId = payload.questionId || currentQuestionId;
  if (!questionId) return;

  if (currentQuestionId && questionId !== currentQuestionId) {
    logState(
      questionId,
      "response",
      "stale response ignored (questionId mismatch)",
      "warn"
    );
    return;
  }

  try {
    const mheTab = await resolveMheTab(null);
    if (!mheTab) return;

    const sameWindow = mheWindowId && payload.provider
      ? mheWindowId === providerState[payload.provider]?.windowId
      : false;
    if (sameWindow) {
      await focusTab(mheTab.id);
      await sleep(250);
    }

    await ensureTabReady(mheTab.id, questionId, "mhe-ready");
    await sendMessageWithRetry(
      mheTab.id,
      {
        type: "processAIResponse",
        response: payload,
      },
      { questionId, phase: "mhe-response-send" }
    );
    logState(questionId, "response", "forwarded to MHE");
  } catch (error) {
    const classified = classifyError(error);
    logState(
      questionId,
      "response",
      `failed to forward (${classified.code})`,
      "error"
    );
  }
}

async function processAIError(message) {
  const payload = message.error || {};
  const questionId = payload.questionId || currentQuestionId;

  logState(
    questionId,
    "provider-error",
    `${payload.code || "unknown"}: ${payload.detail || "no detail"}`,
    "warn"
  );

  await notifyMhe(
    {
      type: "automationError",
      error: {
        questionId,
        provider: payload.provider || null,
        code: payload.code || "unknown",
        detail: payload.detail || "AI provider returned an error.",
      },
    },
    questionId,
    "mhe-provider-error"
  );
}

chrome.tabs.onActivated.addListener((activeInfo) => {
  lastActiveTabId = activeInfo.tabId;
  activationTimes[activeInfo.tabId] = Date.now();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.tab) {
    message.sourceTabId = sender.tab.id;
    activationTimes[sender.tab.id] = Date.now();

    if (tabMatchesMhe(sender.tab)) {
      mheTabId = sender.tab.id;
      mheWindowId = sender.tab.windowId;
    } else {
      const provider = detectProviderFromUrl(sender.tab.url || "");
      if (provider) {
        providerState[provider].tabId = sender.tab.id;
        providerState[provider].windowId = sender.tab.windowId;
      }
    }
  }

  if (message.type === "sendQuestionToAI" || message.type === "sendQuestionToChatGPT") {
    processQuestion(message);
    sendResponse({ received: true });
    return true;
  }

  if (
    message.type === "aiResponse" ||
    message.type === "chatGPTResponse" ||
    message.type === "geminiResponse" ||
    message.type === "deepseekResponse"
  ) {
    processResponse(message);
    sendResponse({ received: true });
    return true;
  }

  if (message.type === "aiError") {
    processAIError(message);
    sendResponse({ received: true });
    return true;
  }

  if (message.type === "openSettings") {
    chrome.windows.create({
      url: chrome.runtime.getURL("popup/settings.html"),
      type: "popup",
      width: 500,
      height: 520,
    });
    sendResponse({ received: true });
    return true;
  }

  sendResponse({ received: false });
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === mheTabId) {
    mheTabId = null;
    mheWindowId = null;
  }

  for (const provider of Object.keys(providerState)) {
    if (providerState[provider].tabId === tabId) {
      providerState[provider].tabId = null;
      providerState[provider].windowId = null;
    }
  }
});
