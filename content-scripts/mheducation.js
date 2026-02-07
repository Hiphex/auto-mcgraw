const shared = globalThis.AutoMcGrawShared || {
  createQuestionId: () => `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  parseAiResponseText: () => ({
    ok: false,
    error: { code: "parse_error", detail: "Unable to parse AI response." },
  }),
  buildQuestionSignature: (type, question, count) => `${type || "unknown"}|${question || ""}|${count || 0}`,
  areChoiceTextsEquivalent: (a, b) => String(a || "").trim() === String(b || "").trim(),
};

let messageListener = null;
let isAutomating = false;
let stepInProgress = false;
let lastIncorrectQuestion = null;
let lastCorrectAnswer = null;
let activeQuestionId = null;
let activeQuestionSignature = null;
let pendingQuestionData = null;
let questionRetryCount = 0;

const MAX_STEP_RETRIES = 2;
const MAX_QUESTION_RETRIES = 2;

function logState(questionId, phase, status, level = "log") {
  const id = questionId || "-";
  const text = `[AutoMcGraw][${id}][${phase}] ${status}`;
  const writer = console[level] || console.log;
  writer(text);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stopAutomationWithError(code, detail, questionId) {
  isAutomating = false;
  logState(questionId, "automation-stop", `${code}: ${detail}`, "error");
  alert(`Automation stopped (${code}). ${detail}`);
}

function waitForElement(selector, timeout = 5000, root = document) {
  return new Promise((resolve, reject) => {
    const immediate = root.querySelector(selector);
    if (immediate) {
      resolve(immediate);
      return;
    }

    let settled = false;
    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Element not found: ${selector}`));
    }, timeout);

    const observer = new MutationObserver(() => {
      if (settled) return;
      const found = root.querySelector(selector);
      if (found) {
        settled = true;
        cleanup();
        resolve(found);
      }
    });

    const intervalHandle = setInterval(() => {
      if (settled) return;
      const found = root.querySelector(selector);
      if (found) {
        settled = true;
        cleanup();
        resolve(found);
      }
    }, 150);

    function cleanup() {
      clearTimeout(timeoutHandle);
      clearInterval(intervalHandle);
      observer.disconnect();
    }

    observer.observe(root === document ? document.body : root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
  });
}

async function runWithStepRetries(stepName, fn, questionId) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_STEP_RETRIES + 1; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      logState(
        questionId,
        stepName,
        `attempt ${attempt}/${MAX_STEP_RETRIES + 1} failed`,
        "warn"
      );
      if (attempt <= MAX_STEP_RETRIES) {
        await sleep(400 * attempt);
      }
    }
  }
  throw lastError || new Error(`${stepName} failed`);
}

function normalizeAnswers(responseAnswer) {
  if (Array.isArray(responseAnswer)) {
    return responseAnswer.map((item) => String(item || "").trim());
  }
  if (responseAnswer === null || responseAnswer === undefined) {
    return [];
  }
  return [String(responseAnswer).trim()];
}

function getQuestionType(container) {
  if (container.querySelector(".awd-probe-type-multiple_choice")) {
    return "multiple_choice";
  }
  if (container.querySelector(".awd-probe-type-true_false")) {
    return "true_false";
  }
  if (container.querySelector(".awd-probe-type-multiple_select")) {
    return "multiple_select";
  }
  if (container.querySelector(".awd-probe-type-fill_in_the_blank")) {
    return "fill_in_the_blank";
  }
  if (container.querySelector(".awd-probe-type-matching")) {
    return "matching";
  }
  return "";
}

function extractQuestionText(container, questionType) {
  const promptEl = container.querySelector(".prompt");
  if (!promptEl) return "";

  if (questionType === "fill_in_the_blank") {
    const promptClone = promptEl.cloneNode(true);
    const uiSpans = promptClone.querySelectorAll(
      "span.response-container, span.fitb-span, span.blank-label, span.correctness, span._visuallyHidden"
    );
    uiSpans.forEach((span) => span.remove());

    const inputs = promptClone.querySelectorAll("input.fitb-input");
    inputs.forEach((input) => {
      const blankMarker = document.createTextNode("[BLANK]");
      if (input.parentNode) {
        input.parentNode.replaceChild(blankMarker, input);
      }
    });
    return promptClone.textContent.trim();
  }

  return promptEl.textContent.trim();
}

function parseQuestion() {
  const container = document.querySelector(".probe-container");
  if (!container || container.querySelector(".forced-learning")) return null;

  const questionType = getQuestionType(container);
  const questionText = extractQuestionText(container, questionType);

  let options = [];
  if (questionType === "matching") {
    const prompts = Array.from(
      container.querySelectorAll(".match-prompt .content")
    ).map((el) => el.textContent.trim());
    const choices = Array.from(
      container.querySelectorAll(".choices-container .content")
    ).map((el) => el.textContent.trim());
    options = { prompts, choices };
  } else if (questionType !== "fill_in_the_blank") {
    options = Array.from(container.querySelectorAll(".choiceText")).map((el) =>
      el.textContent.trim()
    );
  }

  const optionCount = Array.isArray(options)
    ? options.length
    : (options.prompts?.length || 0) + (options.choices?.length || 0);
  const questionSignature = shared.buildQuestionSignature(
    questionType,
    questionText,
    optionCount
  );

  return {
    type: questionType,
    question: questionText,
    options,
    questionSignature,
    previousCorrection: lastIncorrectQuestion
      ? {
          question: lastIncorrectQuestion,
          correctAnswer: lastCorrectAnswer,
        }
      : null,
  };
}

async function parseQuestionWithRetry() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const parsed = parseQuestion();
    if (parsed && parsed.type) {
      return parsed;
    }
    await sleep(350 * attempt);
  }
  return null;
}

function applyChoiceAnswers(container, answers) {
  const choices = Array.from(
    container.querySelectorAll('input[type="radio"], input[type="checkbox"]')
  );
  const isMultiSelect = !!container.querySelector(".awd-probe-type-multiple_select");
  let selectedOne = false;

  for (const choice of choices) {
    const label = choice.closest("label");
    const choiceText = label?.querySelector(".choiceText")?.textContent?.trim();
    if (!choiceText) continue;

    const shouldBeSelected = answers.some((answer) =>
      shared.areChoiceTextsEquivalent(choiceText, answer)
    );

    if (isMultiSelect) {
      if (shouldBeSelected !== choice.checked) {
        choice.click();
      }
      continue;
    }

    if (!selectedOne && shouldBeSelected && !choice.checked) {
      choice.click();
      selectedOne = true;
    } else if (!shouldBeSelected && choice.checked) {
      // Handle stale selection before submit.
      choice.click();
    }
  }
}

function applyFillInBlankAnswers(container, answers) {
  const inputs = Array.from(container.querySelectorAll("input.fitb-input"));
  if (!inputs.length) return;

  if (answers.length !== inputs.length) {
    logState(
      activeQuestionId,
      "fitb",
      `answer/input count mismatch (${answers.length}/${inputs.length})`,
      "warn"
    );
  }

  inputs.forEach((input, index) => {
    const value = answers[index] || "";
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function cleanAnswer(answer) {
  if (!answer) return answer;
  if (Array.isArray(answer)) {
    return answer.map((item) => cleanAnswer(item));
  }
  const cleaned = String(answer)
    .trim()
    .replace(/^Field \d+:\s*/, "")
    .split(" or ")[0]
    .trim();
  return cleaned;
}

function extractCorrectAnswer() {
  const container = document.querySelector(".probe-container");
  if (!container) return null;

  const incorrectMarker = container.querySelector(
    ".awd-probe-correctness.incorrect"
  );
  if (!incorrectMarker) return null;

  const questionType = getQuestionType(container);
  if (questionType === "matching") return null;

  const questionText = extractQuestionText(container, questionType);
  let correctAnswer = null;

  if (questionType === "multiple_choice" || questionType === "true_false") {
    const answerContainer = container.querySelector(
      ".answer-container .choiceText, .correct-answer-container .choiceText, .correct-answer-container .choice"
    );
    correctAnswer = answerContainer ? answerContainer.textContent.trim() : null;
  } else if (questionType === "multiple_select") {
    const correctAnswersList = container.querySelectorAll(
      ".correct-answer-container .choice"
    );
    if (correctAnswersList.length) {
      correctAnswer = Array.from(correctAnswersList).map((el) => {
        const choiceText = el.querySelector(".choiceText");
        return choiceText ? choiceText.textContent.trim() : el.textContent.trim();
      });
    }
  } else if (questionType === "fill_in_the_blank") {
    const correctAnswersList = container.querySelectorAll(".correct-answers");
    if (correctAnswersList.length === 1) {
      const valueEl = correctAnswersList[0].querySelector(".correct-answer");
      if (valueEl) {
        correctAnswer = valueEl.textContent.trim();
      } else {
        const fallback = correctAnswersList[0].textContent.trim();
        const match = fallback.match(/:\s*(.+)$/);
        correctAnswer = match ? match[1].trim() : fallback;
      }
    } else if (correctAnswersList.length > 1) {
      correctAnswer = Array.from(correctAnswersList).map((el) => {
        const valueEl = el.querySelector(".correct-answer");
        if (valueEl) return valueEl.textContent.trim();
        const fallback = el.textContent.trim();
        const match = fallback.match(/:\s*(.+)$/);
        return match ? match[1].trim() : fallback;
      });
    }
  }

  if (correctAnswer === null) return null;
  return {
    question: questionText,
    answer: correctAnswer,
    type: questionType,
  };
}

async function handleTopicOverview() {
  const continueButton = document.querySelector(
    "awd-topic-overview-button-bar .next-button, .button-bar-wrapper .next-button"
  );
  if (
    continueButton &&
    continueButton.textContent.trim().toLowerCase().includes("continue")
  ) {
    continueButton.click();
    await sleep(900);
    return true;
  }
  return false;
}

async function handleForcedLearning() {
  const forcedLearningAlert = document.querySelector(".forced-learning .alert-error");
  if (!forcedLearningAlert) return false;

  const readButton = document.querySelector(
    '[data-automation-id="lr-tray_reading-button"]'
  );
  if (!readButton) return false;

  await runWithStepRetries(
    "forced-learning",
    async () => {
      readButton.click();
      const toQuestionsButton = await waitForElement(
        '[data-automation-id="reading-questions-button"]',
        12000
      );
      toQuestionsButton.click();
      const nextButton = await waitForElement(".next-button", 12000);
      nextButton.click();
      await sleep(900);
    },
    activeQuestionId
  );

  return true;
}

async function sendQuestionToAI(questionData, retryReason = null) {
  if (!questionData) return;

  const questionId = shared.createQuestionId();
  const questionPayload = {
    ...questionData,
    questionId,
    retryReason,
  };

  pendingQuestionData = {
    ...questionData,
  };
  activeQuestionId = questionId;
  activeQuestionSignature = questionData.questionSignature || null;

  if (!retryReason) {
    questionRetryCount = 0;
  }

  logState(questionId, "question-send", retryReason ? "retry dispatch" : "dispatch");
  chrome.runtime.sendMessage({
    type: "sendQuestionToAI",
    question: questionPayload,
  });
}

async function retryCurrentQuestion(reason) {
  if (!pendingQuestionData) {
    stopAutomationWithError(
      "retry_unavailable",
      "No pending question state available for retry.",
      activeQuestionId
    );
    return;
  }

  questionRetryCount += 1;
  if (questionRetryCount > MAX_QUESTION_RETRIES) {
    stopAutomationWithError(
      "provider_failure",
      "Provider failed repeatedly on this question.",
      activeQuestionId
    );
    return;
  }

  await sendQuestionToAI(
    {
      ...pendingQuestionData,
      previousCorrection: pendingQuestionData.previousCorrection,
    },
    reason
  );
}

function normalizeResponsePayload(responseOrString) {
  if (!responseOrString) {
    return {
      ok: false,
      error: { code: "parse_error", detail: "Empty AI response payload." },
    };
  }

  if (typeof responseOrString === "object" && "answer" in responseOrString) {
    return {
      ok: true,
      payload: responseOrString,
    };
  }

  const parsed = shared.parseAiResponseText(String(responseOrString));
  if (!parsed.ok) {
    return {
      ok: false,
      error: parsed.error,
    };
  }

  return {
    ok: true,
    payload: {
      answer: parsed.payload.answer,
      explanation: parsed.payload.explanation,
      raw: parsed.payload.raw,
    },
  };
}

async function processAIResponse(responseOrString) {
  if (!isAutomating) return;

  const normalized = normalizeResponsePayload(responseOrString);
  if (!normalized.ok) {
    await retryCurrentQuestion(`${normalized.error.code}: ${normalized.error.detail}`);
    return;
  }

  const payload = normalized.payload;
  const questionId = payload.questionId || activeQuestionId;
  if (activeQuestionId && questionId && questionId !== activeQuestionId) {
    logState(questionId, "response", "stale response dropped", "warn");
    return;
  }

  const container = document.querySelector(".probe-container");
  if (!container) {
    await retryCurrentQuestion("probe_missing: unable to find question container");
    return;
  }

  const currentType = getQuestionType(container);
  const currentSignature = shared.buildQuestionSignature(
    currentType,
    extractQuestionText(container, currentType),
    container.querySelectorAll(".choiceText").length
  );
  if (activeQuestionSignature && currentSignature !== activeQuestionSignature) {
    logState(questionId, "response", "signature mismatch, response dropped", "warn");
    return;
  }

  const answers = normalizeAnswers(payload.answer);
  lastIncorrectQuestion = null;
  lastCorrectAnswer = null;

  if (container.querySelector(".awd-probe-type-matching")) {
    alert(
      "Matching Question Solution:\n\n" +
        answers.join("\n") +
        "\n\nPlease input these matches manually, then click high confidence and next."
    );
  } else if (container.querySelector(".awd-probe-type-fill_in_the_blank")) {
    applyFillInBlankAnswers(container, answers);
  } else {
    applyChoiceAnswers(container, answers);
  }

  try {
    await runWithStepRetries(
      "high-confidence",
      async () => {
        const button = await waitForElement(
          '[data-automation-id="confidence-buttons--high_confidence"]:not([disabled])',
          12000
        );
        button.click();
      },
      questionId
    );

    await sleep(1000);

    const incorrectMarker = container.querySelector(".awd-probe-correctness.incorrect");
    if (incorrectMarker) {
      const correctionData = extractCorrectAnswer();
      if (correctionData?.answer) {
        lastIncorrectQuestion = correctionData.question;
        lastCorrectAnswer = cleanAnswer(correctionData.answer);
      }
    }

    await runWithStepRetries(
      "next-button",
      async () => {
        const nextButton = await waitForElement(".next-button", 12000);
        nextButton.click();
      },
      questionId
    );

    await sleep(900);
    checkForNextStep();
  } catch (error) {
    stopAutomationWithError(
      "timeout",
      "Unable to continue to the next step after retries.",
      questionId
    );
  }
}

async function handleAutomationError(errorPayload) {
  if (!isAutomating) return;
  const payload = errorPayload || {};
  const questionId = payload.questionId || activeQuestionId;

  if (activeQuestionId && questionId && questionId !== activeQuestionId) {
    logState(questionId, "provider-error", "stale provider error ignored", "warn");
    return;
  }

  const code = payload.code || "unknown";
  const detail = payload.detail || "Provider returned an unknown error.";
  logState(questionId, "provider-error", `${code}: ${detail}`, "warn");
  await retryCurrentQuestion(`${code}: ${detail}`);
}

function setupMessageListener() {
  if (messageListener) {
    chrome.runtime.onMessage.removeListener(messageListener);
  }

  messageListener = (message, sender, sendResponse) => {
    if (message.type === "ping") {
      sendResponse({ ready: true });
      return true;
    }

    if (message.type === "processAIResponse") {
      processAIResponse(message.response);
      sendResponse({ received: true });
      return true;
    }

    if (message.type === "processChatGPTResponse") {
      processAIResponse(message.response);
      sendResponse({ received: true });
      return true;
    }

    if (message.type === "automationError") {
      handleAutomationError(message.error);
      sendResponse({ received: true });
      return true;
    }

    if (message.type === "alertMessage") {
      alert(message.message);
      sendResponse({ received: true });
      return true;
    }
  };

  chrome.runtime.onMessage.addListener(messageListener);
}

function addAssistantButton() {
  waitForElement("awd-header .header__navigation")
    .then((headerNav) => {
      if (document.getElementById("auto-mcgraw-controls")) return;

      const buttonContainer = document.createElement("div");
      buttonContainer.id = "auto-mcgraw-controls";
      buttonContainer.style.display = "flex";
      buttonContainer.style.marginLeft = "10px";

      chrome.storage.sync.get("aiModel", function (data) {
        const aiModel = data.aiModel || "chatgpt";
        let modelName = "ChatGPT";
        if (aiModel === "gemini") modelName = "Gemini";
        if (aiModel === "deepseek") modelName = "DeepSeek";

        const btn = document.createElement("button");
        btn.textContent = `Ask ${modelName}`;
        btn.classList.add("btn", "btn-secondary");
        btn.style.borderTopRightRadius = "0";
        btn.style.borderBottomRightRadius = "0";
        btn.addEventListener("click", async () => {
          if (isAutomating) {
            isAutomating = false;
            activeQuestionId = null;
            activeQuestionSignature = null;
            pendingQuestionData = null;
            questionRetryCount = 0;
            chrome.storage.sync.get("aiModel", function (currentData) {
              const currentModel = currentData.aiModel || "chatgpt";
              let currentModelName = "ChatGPT";
              if (currentModel === "gemini") currentModelName = "Gemini";
              if (currentModel === "deepseek") currentModelName = "DeepSeek";
              btn.textContent = `Ask ${currentModelName}`;
            });
            return;
          }

          const proceed = confirm(
            "Start automated answering? Click OK to begin, or Cancel to stop."
          );
          if (!proceed) return;

          isAutomating = true;
          btn.textContent = "Stop Automation";
          checkForNextStep();
        });

        const settingsBtn = document.createElement("button");
        settingsBtn.classList.add("btn", "btn-secondary");
        settingsBtn.style.borderTopLeftRadius = "0";
        settingsBtn.style.borderBottomLeftRadius = "0";
        settingsBtn.style.borderLeft = "1px solid rgba(0,0,0,0.2)";
        settingsBtn.style.padding = "6px 10px";
        settingsBtn.title = "Auto-McGraw Settings";
        settingsBtn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
          </svg>
        `;
        settingsBtn.addEventListener("click", () => {
          chrome.runtime.sendMessage({ type: "openSettings" });
        });

        buttonContainer.appendChild(btn);
        buttonContainer.appendChild(settingsBtn);
        headerNav.appendChild(buttonContainer);

        chrome.storage.onChanged.addListener((changes) => {
          if (!changes.aiModel || isAutomating) return;
          const newModel = changes.aiModel.newValue;
          let newModelName = "ChatGPT";
          if (newModel === "gemini") newModelName = "Gemini";
          if (newModel === "deepseek") newModelName = "DeepSeek";
          btn.textContent = `Ask ${newModelName}`;
        });
      });
    })
    .catch(() => {
      // No-op if header never appears.
    });
}

async function checkForNextStep() {
  if (!isAutomating || stepInProgress) return;
  stepInProgress = true;

  try {
    if (await handleTopicOverview()) {
      scheduleNextStep();
      return;
    }

    if (await handleForcedLearning()) {
      scheduleNextStep();
      return;
    }

    const parsed = await parseQuestionWithRetry();
    if (!parsed) {
      await sleep(800);
      scheduleNextStep();
      return;
    }

    if (!parsed.type) {
      stopAutomationWithError(
        "question_type_unknown",
        "Unable to determine question type after retries.",
        activeQuestionId
      );
      return;
    }

    await sendQuestionToAI(parsed, null);
  } catch (error) {
    stopAutomationWithError(
      "step_failure",
      "Unable to continue automation after retries.",
      activeQuestionId
    );
  } finally {
    stepInProgress = false;
  }
}

function scheduleNextStep(delay = 250) {
  if (!isAutomating) return;
  setTimeout(() => {
    checkForNextStep();
  }, delay);
}

setupMessageListener();
addAssistantButton();
