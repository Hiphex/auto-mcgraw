const shared = globalThis.AutoMcGrawShared || {
  parseAiResponseText: () => ({
    ok: false,
    error: { code: "parse_error", detail: "Unable to parse AI output." },
  }),
};

const PROVIDER = "deepseek";
const INPUT_SELECTORS = [
  "#chat-input",
  "textarea#chat-input",
  '[contenteditable="true"][data-testid="chat-input"]',
  '[role="textbox"]',
];
const SEND_SELECTORS = [
  '[aria-label="Send message"]',
  'button[type="submit"]',
  '[data-testid="send-button"]',
  '[role="button"].f6d670',
  ".f6d670",
  'button:has(svg)',
];
const ASSISTANT_MESSAGE_SELECTORS = [
  "[data-testid='chat-message-assistant']",
  "model-response",
  ".ds-markdown",
  ".f9bf7997",
];

let hasResponded = false;
let messageCountAtQuestion = 0;
let observationStartTime = 0;
let observationTimeout = null;
let observer = null;
let intervalId = null;
let activeQuestionId = null;

function logState(questionId, phase, status, level = "log") {
  const id = questionId || "-";
  const text = `[AutoMcGraw][${id}][${phase}] ${status}`;
  const writer = console[level] || console.log;
  writer(text);
}

function resetObservation() {
  if (observationTimeout) {
    clearTimeout(observationTimeout);
    observationTimeout = null;
  }
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  hasResponded = false;
}

function getAssistantMessages() {
  for (const selector of ASSISTANT_MESSAGE_SELECTORS) {
    const found = document.querySelectorAll(selector);
    if (found.length) return Array.from(found);
  }
  return [];
}

function waitForAnySelector(selectors, timeout = 15000, requireEnabled = false) {
  return new Promise((resolve, reject) => {
    function findMatch() {
      for (const selector of selectors) {
        try {
          const element = document.querySelector(selector);
          if (!element) continue;
          if (requireEnabled && element.disabled) continue;
          return element;
        } catch (error) {
          // Skip invalid selectors.
        }
      }
      return null;
    }

    const immediate = findMatch();
    if (immediate) {
      resolve(immediate);
      return;
    }

    let settled = false;
    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Selector timeout: ${selectors.join(", ")}`));
    }, timeout);

    const observerHandle = new MutationObserver(() => {
      if (settled) return;
      const found = findMatch();
      if (found) {
        settled = true;
        cleanup();
        resolve(found);
      }
    });

    const pollHandle = setInterval(() => {
      if (settled) return;
      const found = findMatch();
      if (found) {
        settled = true;
        cleanup();
        resolve(found);
      }
    }, 120);

    function cleanup() {
      clearTimeout(timeoutHandle);
      clearInterval(pollHandle);
      observerHandle.disconnect();
    }

    observerHandle.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
  });
}

function setInputValue(input, text) {
  if (!input) return;

  if (input.isContentEditable) {
    input.focus();
    input.innerHTML = "";
    input.textContent = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  input.focus();
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function buildPrompt(questionData) {
  const { type, question, options, previousCorrection } = questionData;
  let text = `Type: ${type}\nQuestion: ${question}`;

  if (
    previousCorrection &&
    previousCorrection.question &&
    previousCorrection.correctAnswer
  ) {
    text =
      `CORRECTION FROM PREVIOUS ANSWER: For the question "${
        previousCorrection.question
      }", your answer was incorrect. The correct answer was: ${JSON.stringify(
        previousCorrection.correctAnswer
      )}\n\nNow answer this new question:\n\n` + text;
  }

  if (type === "matching") {
    text +=
      "\nPrompts:\n" +
      options.prompts.map((prompt, i) => `${i + 1}. ${prompt}`).join("\n");
    text +=
      "\nChoices:\n" +
      options.choices.map((choice, i) => `${i + 1}. ${choice}`).join("\n");
    text +=
      "\n\nPlease match each prompt with the correct choice. Format your answer as an array where each element is 'Prompt -> Choice'.";
  } else if (type === "fill_in_the_blank") {
    text +=
      "\n\nThis is a fill in the blank question. If there are multiple blanks, provide answers as an array in order of appearance. For a single blank, you can provide a string.";
  } else if (options && options.length > 0) {
    text +=
      "\nOptions:\n" + options.map((opt, i) => `${i + 1}. ${opt}`).join("\n");
    text +=
      "\n\nIMPORTANT: Your answer must EXACTLY match one of the above options. Do not include numbers in your answer. If there are periods, include them.";
  }

  text +=
    '\n\nPlease provide your answer in JSON format with keys "answer" and "explanation". Explanations should be no more than one sentence. DO NOT acknowledge the correction in your response, only answer the new question.';

  return text;
}

async function insertQuestion(questionData) {
  const input = await waitForAnySelector(INPUT_SELECTORS, 15000, false);
  const sendButton = await waitForAnySelector(SEND_SELECTORS, 15000, true);
  setInputValue(input, buildPrompt(questionData));
  sendButton.click();
}

function isGenerating() {
  return !!document.querySelector(
    ".result-streaming, .loading, .typing, .cursor, [aria-busy='true']"
  );
}

function sendResponseToBackground(parsedPayload) {
  if (hasResponded) return;
  hasResponded = true;

  chrome.runtime.sendMessage({
    type: "aiResponse",
    response: {
      questionId: activeQuestionId,
      provider: PROVIDER,
      answer: parsedPayload.answer,
      explanation: parsedPayload.explanation || "",
      raw: parsedPayload.raw || "",
    },
  });

  logState(activeQuestionId, "provider-response", "parsed and dispatched");
  resetObservation();
}

function sendErrorToBackground(code, detail) {
  if (hasResponded) return;
  hasResponded = true;

  chrome.runtime.sendMessage({
    type: "aiError",
    error: {
      questionId: activeQuestionId,
      provider: PROVIDER,
      code,
      detail,
    },
  });

  logState(activeQuestionId, "provider-error", `${code}: ${detail}`, "warn");
  resetObservation();
}

function gatherCandidateTexts(messageElement) {
  const candidates = [];
  const codeBlocks = messageElement.querySelectorAll("pre code, pre");
  for (const block of codeBlocks) {
    const text = block.textContent?.trim();
    if (text) candidates.push(text);
  }

  const fullText = messageElement.textContent?.trim();
  if (fullText) candidates.push(fullText);

  return candidates;
}

function tryProcessResponse() {
  if (hasResponded) return;

  const messages = getAssistantMessages();
  if (messages.length <= messageCountAtQuestion) return;

  const latest = messages[messages.length - 1];
  const candidates = gatherCandidateTexts(latest);
  for (const candidate of candidates) {
    const parsed = shared.parseAiResponseText(candidate);
    if (parsed.ok) {
      sendResponseToBackground(parsed.payload);
      return;
    }
  }

  const elapsed = Date.now() - observationStartTime;
  if (elapsed > 45000 && !isGenerating()) {
    sendErrorToBackground("parse_error", "Unable to parse provider JSON response.");
  }
}

function startObserving() {
  observationStartTime = Date.now();
  observationTimeout = setTimeout(() => {
    if (!hasResponded) {
      sendErrorToBackground("timeout", "Timed out waiting for provider response.");
    }
  }, 180000);

  observer = new MutationObserver(() => {
    tryProcessResponse();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
  });

  intervalId = setInterval(tryProcessResponse, 1000);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "ping") {
    sendResponse({ ready: true });
    return true;
  }

  if (message.type === "receiveQuestion") {
    resetObservation();
    const questionData = message.question || {};
    activeQuestionId =
      questionData.questionId || `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    messageCountAtQuestion = getAssistantMessages().length;

    insertQuestion(questionData)
      .then(() => {
        logState(activeQuestionId, "provider-send", "question submitted");
        startObserving();
        sendResponse({ received: true, status: "processing" });
      })
      .catch((error) => {
        sendErrorToBackground("script_not_ready", error.message || "Input/send control unavailable.");
        sendResponse({ received: false, error: error.message });
      });

    return true;
  }
});
