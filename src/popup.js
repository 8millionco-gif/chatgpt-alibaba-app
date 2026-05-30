const DEFAULT_SETTINGS = {
  apiEndpoint: "https://api.openai.com/v1/chat/completions",
  model: "gpt-4.1-mini",
  apiKey: "",
  language: "English",
  companyContext: ""
};

const state = {
  currentChat: null,
  isBusy: false,
  autoRefreshTimer: null
};

const elements = {
  status: document.querySelector("#status"),
  buyerName: document.querySelector("#buyerName"),
  scanButton: document.querySelector("#scanButton"),
  settingsButton: document.querySelector("#settingsButton"),
  settingsPanel: document.querySelector("#settingsPanel"),
  saveSettings: document.querySelector("#saveSettings"),
  saveSummary: document.querySelector("#saveSummary"),
  summary: document.querySelector("#summary"),
  suggestions: document.querySelector("#suggestions"),
  openItems: document.querySelector("#openItems"),
  apiEndpoint: document.querySelector("#apiEndpoint"),
  model: document.querySelector("#model"),
  apiKey: document.querySelector("#apiKey"),
  language: document.querySelector("#language"),
  companyContext: document.querySelector("#companyContext")
};

document.addEventListener("DOMContentLoaded", init);
elements.scanButton.addEventListener("click", scanAndGenerate);
elements.settingsButton.addEventListener("click", () => elements.settingsPanel.classList.toggle("hidden"));
elements.saveSettings.addEventListener("click", saveSettings);
elements.saveSummary.addEventListener("click", saveCurrentSummary);

async function init() {
  await loadSettings();
  await scanCurrentChat(false, { forceRender: true });
  startAutoRefresh();
}

async function loadSettings() {
  const settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS))) };
  for (const [key, value] of Object.entries(settings)) {
    if (elements[key]) elements[key].value = value;
  }
}

async function saveSettings() {
  const settings = {
    apiEndpoint: elements.apiEndpoint.value.trim() || DEFAULT_SETTINGS.apiEndpoint,
    model: elements.model.value.trim() || DEFAULT_SETTINGS.model,
    apiKey: elements.apiKey.value.trim(),
    language: elements.language.value,
    companyContext: elements.companyContext.value.trim()
  };
  await chrome.storage.sync.set(settings);
  setStatus("설정을 저장했습니다.");
}

function startAutoRefresh() {
  if (state.autoRefreshTimer) clearInterval(state.autoRefreshTimer);
  state.autoRefreshTimer = setInterval(async () => {
    if (state.isBusy) return;
    try {
      await scanCurrentChat(false, { onlyOnBuyerChange: true });
    } catch (error) {
      // The active tab may be a Chrome page or a non-supported site. Keep the panel open quietly.
    }
  }, 1500);
}

async function scanCurrentChat(showStatus = true, options = {}) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("현재 탭을 찾을 수 없습니다.");

  const chat = await sendExtractMessage(tab.id);
  const previousBuyerKey = state.currentChat?.buyerKey;
  const buyerChanged = Boolean(previousBuyerKey && chat.buyerKey && previousBuyerKey !== chat.buyerKey);
  const shouldRenderSaved = options.forceRender || buyerChanged || !options.onlyOnBuyerChange;
  state.currentChat = chat;
  elements.buyerName.textContent = chat.buyerName || "Unknown buyer";

  const saved = await loadBuyerRecord(chat.buyerKey);

  if (shouldRenderSaved) {
    elements.summary.value = saved.summary || "";
    if (saved.assistance) {
      renderAssistance(saved.assistance);
    } else {
      renderAssistance({});
    }
  }

  if (showStatus) {
    setStatus(`메시지 ${chat.messages.length}개를 읽었습니다.`);
  } else if (buyerChanged) {
    setStatus(`현재 바이어가 ${chat.buyerName || "Unknown buyer"}로 변경되었습니다.`);
  }
  return { chat, saved };
}

async function sendExtractMessage(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "EXTRACT_CHAT" });
  } catch (error) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content.js"]
    });
    return chrome.tabs.sendMessage(tabId, { type: "EXTRACT_CHAT" });
  }
}

async function scanAndGenerate() {
  try {
    setBusy(true, "현재 대화 내용을 읽는 중입니다.");
    const { chat, saved } = await scanCurrentChat(false);

    setStatus("AI가 요약과 답변 후보를 만들고 있습니다.");
    const result = await chrome.runtime.sendMessage({
      type: "GENERATE_ASSISTANCE",
      payload: {
        buyerName: chat.buyerName,
        previousSummary: saved.summary,
        historyMessages: saved.historyMessages || saved.lastMessages || [],
        messages: chat.messages
      }
    });

    if (!result?.ok) {
      throw new Error(result?.error || "AI 분석에 실패했습니다.");
    }

    renderAssistance(result.data);
    const mergedMessages = mergeMessages(saved.historyMessages || saved.lastMessages || [], chat.messages);
    await saveBuyerRecord(chat.buyerKey, {
      buyerName: chat.buyerName,
      summary: result.data.summary || elements.summary.value,
      assistance: result.data,
      historyMessages: mergedMessages,
      lastMessages: chat.messages.slice(-20),
      updatedAt: new Date().toISOString()
    });
    elements.summary.value = result.data.summary || "";
    setStatus("분석이 완료됐습니다.");
  } catch (error) {
    setStatus(error.message);
  } finally {
    setBusy(false);
  }
}

function renderAssistance(data) {
  const replies = normalizeReplies(data.next_replies);
  elements.suggestions.classList.toggle("empty", replies.length === 0);
  elements.suggestions.innerHTML = replies.length
    ? replies.map((reply) => `
      <article class="suggestion">
        ${reply.intent ? `<strong>${escapeHtml(reply.intent)}</strong>` : ""}
        <p class="buyer-text">${escapeHtml(reply.buyerLanguage)}</p>
        <p class="translation">${escapeHtml(reply.koreanTranslation)}</p>
        <button data-copy="${escapeHtml(reply.buyerLanguage)}">원문 복사</button>
      </article>
    `).join("")
    : "제안할 답변이 없습니다.";

  elements.suggestions.querySelectorAll("button[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      await navigator.clipboard.writeText(button.dataset.copy);
      setStatus("답변 후보를 복사했습니다.");
    });
  });

  const items = Array.isArray(data.open_items) ? data.open_items : [];
  elements.openItems.innerHTML = items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
}

function normalizeReplies(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === "string") {
      return {
        buyerLanguage: item,
        koreanTranslation: "",
        intent: ""
      };
    }

    return {
      buyerLanguage: item?.buyer_language || item?.buyerLanguage || item?.message || "",
      koreanTranslation: item?.korean_translation || item?.koreanTranslation || item?.translation_ko || "",
      intent: item?.intent || ""
    };
  }).filter((item) => item.buyerLanguage);
}

async function saveCurrentSummary() {
  if (!state.currentChat?.buyerKey) {
    setStatus("먼저 현재 채팅을 읽어주세요.");
    return;
  }
  await saveBuyerRecord(state.currentChat.buyerKey, {
    buyerName: state.currentChat.buyerName,
    summary: elements.summary.value.trim(),
    assistance: {
      ...(await loadBuyerRecord(state.currentChat.buyerKey)).assistance,
      summary: elements.summary.value.trim()
    },
    historyMessages: mergeMessages([], state.currentChat.messages),
    lastMessages: state.currentChat.messages.slice(-20),
    updatedAt: new Date().toISOString()
  });
  setStatus("요약을 저장했습니다.");
}

async function loadBuyerRecord(buyerKey) {
  if (!buyerKey) return {};
  const key = `buyer:${buyerKey}`;
  const data = await chrome.storage.local.get(key);
  return data[key] || {};
}

async function saveBuyerRecord(buyerKey, value) {
  const key = `buyer:${buyerKey}`;
  await chrome.storage.local.set({ [key]: value });
}

function mergeMessages(existingMessages, newMessages) {
  const seen = new Set();
  return [...existingMessages, ...newMessages]
    .filter((message) => message?.text)
    .filter((message) => {
      const key = [
        message.sender || "unknown",
        message.time || "",
        String(message.text).replace(/\s+/g, " ").trim()
      ].join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(-240);
}

function setStatus(message) {
  elements.status.textContent = message;
}

function setBusy(isBusy, message) {
  state.isBusy = isBusy;
  elements.scanButton.disabled = isBusy;
  elements.saveSummary.disabled = isBusy;
  if (message) setStatus(message);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
