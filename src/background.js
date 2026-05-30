const DEFAULT_SETTINGS = {
  apiEndpoint: "https://api.openai.com/v1/chat/completions",
  model: "gpt-4.1-mini",
  apiKey: "",
  language: "English",
  companyContext: ""
};

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS));
  const missing = Object.fromEntries(
    Object.entries(DEFAULT_SETTINGS).filter(([key]) => existing[key] === undefined)
  );
  if (Object.keys(missing).length) {
    await chrome.storage.sync.set(missing);
  }

  if (chrome.sidePanel?.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (chrome.sidePanel?.open && tab?.id) {
    await chrome.sidePanel.open({ tabId: tab.id });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GENERATE_ASSISTANCE") {
    generateAssistance(message.payload)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});

async function generateAssistance(payload) {
  const settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS))) };

  if (!settings.apiKey) {
    return {
      ok: false,
      error: "AI API key is not configured. Open Settings and add your key."
    };
  }

  const buyerName = payload?.buyerName || "Unknown buyer";
  const previousSummary = payload?.previousSummary || "";
  const historyMessages = Array.isArray(payload?.historyMessages) ? payload.historyMessages : [];
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const historyTranscript = historyMessages
    .slice(-160)
    .map((item) => `[${item.time || "no time"}] ${item.sender || "unknown"}: ${item.text}`)
    .join("\n");
  const currentTranscript = messages
    .slice(-120)
    .map((item) => `[${item.time || "no time"}] ${item.sender || "unknown"}: ${item.text}`)
    .join("\n");

  const systemPrompt = [
    "You are a B2B sales assistant helping an Alibaba seller remember buyer context.",
    "Return concise, practical output for a human seller.",
    "The summary must describe the whole relationship and conversation flow from the earliest known context through the latest message, not only the last message.",
    "Keep important changes over time: first inquiry, product interest, negotiation, decisions, promises, objections, unresolved issues, and the latest state.",
    "Format the Korean summary with short section headings and bullet points so it is easy to scan.",
    "Use this exact Korean summary structure: [현재 상태], [대화 흐름], [바이어 관심/조건], [결정/약속], [미해결], [다음 액션].",
    "Each suggested reply must include the buyer-language message and a Korean translation for the seller.",
    "Never invent facts. If information is missing, say it should be confirmed.",
    `Write buyer-facing suggested replies in ${settings.language}.`,
    settings.companyContext ? `Seller/company context:\n${settings.companyContext}` : ""
  ].filter(Boolean).join("\n\n");

  const userPrompt = `Buyer: ${buyerName}

Previous saved summary:
${previousSummary || "(none)"}

Previously stored message history:
${historyTranscript || "(none)"}

Current visible conversation, including the latest messages:
${currentTranscript || "(no visible messages found)"}

Create JSON with these exact keys:
{
  "summary": "[현재 상태]\\n- ...\\n\\n[대화 흐름]\\n- ...\\n\\n[바이어 관심/조건]\\n- ...\\n\\n[결정/약속]\\n- ...\\n\\n[미해결]\\n- ...\\n\\n[다음 액션]\\n- ...",
  "open_items": ["Unresolved issue or follow-up item"],
  "buyer_profile": ["Preference, product interest, constraints, tone"],
  "next_replies": [
    {
      "buyer_language": "Suggested message to send to the buyer in ${settings.language}",
      "korean_translation": "Natural Korean translation of the suggested message",
      "intent": "Short Korean label explaining when to use this reply"
    }
  ],
  "internal_note": "Short Korean note for the seller"
}`;

  const response = await fetch(settings.apiEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.3,
      response_format: { type: "json_object" }
    })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error?.message || `AI request failed with HTTP ${response.status}`);
  }

  const content = body?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("AI response did not include content.");
  }

  return { ok: true, data: JSON.parse(content) };
}
