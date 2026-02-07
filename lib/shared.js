(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.AutoMcGrawShared = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const OPTION_PREFIX_RE = /^\s*[A-Za-z]\s*[\.\)\-:]\s*/;

  function toText(value) {
    if (value === null || value === undefined) return "";
    return String(value);
  }

  function normalizeComparableText(value) {
    let text = toText(value);

    if (typeof text.normalize === "function") {
      text = text.normalize("NFKC");
    }

    text = text
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/\u00A0/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    text = text.replace(OPTION_PREFIX_RE, "");
    text = text.replace(/\s*\.\s*$/, "");

    return text.trim().toLowerCase();
  }

  function areChoiceTextsEquivalent(choiceText, answerText) {
    const left = normalizeComparableText(choiceText);
    const right = normalizeComparableText(answerText);
    if (!left || !right) return false;
    if (left === right) return true;

    const leftNoPrefix = left.replace(OPTION_PREFIX_RE, "");
    const rightNoPrefix = right.replace(OPTION_PREFIX_RE, "");
    return leftNoPrefix === rightNoPrefix;
  }

  function cleanupAiJsonText(text) {
    return toText(text)
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/```(?:json)?/gi, "")
      .replace(/```/g, "")
      .trim();
  }

  function extractBalancedJsonObject(text) {
    const source = cleanupAiJsonText(text);
    if (!source) return null;

    let fallback = null;
    for (
      let start = source.indexOf("{");
      start !== -1;
      start = source.indexOf("{", start + 1)
    ) {
      let depth = 0;
      let inString = false;
      let escape = false;

      for (let i = start; i < source.length; i++) {
        const char = source[i];

        if (escape) {
          escape = false;
          continue;
        }

        if (char === "\\") {
          escape = true;
          continue;
        }

        if (char === '"') {
          inString = !inString;
          continue;
        }

        if (inString) continue;

        if (char === "{") depth += 1;
        if (char === "}") {
          depth -= 1;
          if (depth === 0) {
            const candidate = source.slice(start, i + 1);
            if (!fallback) fallback = candidate;
            if (candidate.includes('"answer"')) {
              return candidate;
            }
            break;
          }
        }
      }
    }

    return fallback;
  }

  function tryParseJson(text) {
    const candidates = [
      text,
      text.replace(/,\s*([}\]])/g, "$1"),
      text.replace(/\\n/g, " "),
    ];

    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate);
      } catch (error) {
        // Keep trying relaxed variants.
      }
    }
    return null;
  }

  function parseAiResponseText(rawText) {
    const cleaned = cleanupAiJsonText(rawText);
    const candidates = [];

    if (cleaned.startsWith("{") && cleaned.endsWith("}")) {
      candidates.push(cleaned);
    }

    const balanced = extractBalancedJsonObject(cleaned);
    if (balanced) {
      candidates.push(balanced);
    }

    const regexMatch = cleaned.match(/\{[\s\S]*\}/);
    if (regexMatch) {
      candidates.push(regexMatch[0]);
    }

    const seen = new Set();
    for (const candidate of candidates) {
      const dedupeKey = candidate.trim();
      if (!dedupeKey || seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const parsed = tryParseJson(dedupeKey);
      if (!parsed) continue;
      if (!Object.prototype.hasOwnProperty.call(parsed, "answer")) continue;

      return {
        ok: true,
        payload: {
          answer: parsed.answer,
          explanation:
            typeof parsed.explanation === "string" ? parsed.explanation : "",
          raw: cleaned,
        },
      };
    }

    return {
      ok: false,
      error: {
        code: "parse_error",
        detail: "Unable to parse AI response payload.",
      },
    };
  }

  function rankTabs(candidates, options) {
    const input = Array.isArray(candidates) ? [...candidates] : [];
    const config = options || {};
    const preferredTabId = config.preferredTabId || null;
    const lastActiveTabId = config.lastActiveTabId || null;
    const activationTimes = config.activationTimes || {};

    function rankTuple(tab) {
      if (!tab || typeof tab.id !== "number") {
        return [0, 0, 0, 0, 0];
      }

      return [
        preferredTabId && tab.id === preferredTabId ? 1 : 0,
        lastActiveTabId && tab.id === lastActiveTabId ? 1 : 0,
        tab.active ? 1 : 0,
        typeof activationTimes[tab.id] === "number" ? activationTimes[tab.id] : 0,
        typeof tab.lastAccessed === "number" ? tab.lastAccessed : 0,
      ];
    }

    return input.sort((a, b) => {
      const left = rankTuple(a);
      const right = rankTuple(b);
      for (let i = 0; i < left.length; i++) {
        if (left[i] === right[i]) continue;
        return right[i] - left[i];
      }
      return 0;
    });
  }

  function buildQuestionSignature(type, prompt, optionCount) {
    const normalizedType = toText(type).trim().toLowerCase() || "unknown";
    const normalizedPrompt = normalizeComparableText(prompt);
    const normalizedCount = Number.isFinite(optionCount) ? optionCount : 0;
    return `${normalizedType}|${normalizedPrompt}|${normalizedCount}`;
  }

  function createQuestionId() {
    const random = Math.random().toString(36).slice(2, 8);
    return `q_${Date.now()}_${random}`;
  }

  return {
    normalizeComparableText,
    areChoiceTextsEquivalent,
    cleanupAiJsonText,
    extractBalancedJsonObject,
    parseAiResponseText,
    rankTabs,
    buildQuestionSignature,
    createQuestionId,
  };
});
