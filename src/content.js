if (!window.__buyerChatAssistantContentLoaded) {
window.__buyerChatAssistantContentLoaded = true;

const MESSAGE_SELECTORS = [
  "[class*='message']",
  "[class*='Message']",
  "[class*='chat']",
  "[class*='Chat']",
  "[class*='bubble']",
  "[class*='Bubble']",
  "[data-role*='message']"
];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "EXTRACT_CHAT") {
    sendResponse(extractChatFromPage());
  }
});

function extractChatFromPage() {
  const chatRoot = findChatRoot();
  const messages = findMessages(chatRoot);
  const buyerName = findBuyerName(chatRoot, messages);

  return {
    url: location.href,
    title: document.title,
    buyerName,
    buyerKey: normalizeBuyerKey(buyerName, location.href),
    messages,
    extractedAt: new Date().toISOString()
  };
}

function findChatRoot() {
  const messageNodes = findMessageNodes(document);
  const scored = new Map();

  for (const node of messageNodes) {
    let current = node;
    for (let depth = 0; current && depth < 8; depth += 1) {
      if (current === document.body || current === document.documentElement) break;
      const rect = current.getBoundingClientRect();
      if (!isVisibleRect(rect)) {
        current = current.parentElement;
        continue;
      }

      const key = current;
      const existing = scored.get(key) || { node: current, hits: 0, score: 0 };
      existing.hits += 1;
      existing.score += scoreChatContainer(current, rect, depth);
      scored.set(key, existing);
      current = current.parentElement;
    }
  }

  const best = Array.from(scored.values())
    .filter((item) => item.hits >= 2)
    .sort((a, b) => b.score - a.score)[0];

  return best?.node || document.body;
}

function scoreChatContainer(node, rect, depth) {
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1;
  const centerX = rect.left + rect.width / 2;
  const isMainPane = centerX > viewportWidth * 0.35;
  const isTooWide = rect.width > viewportWidth * 0.96;
  const isTooNarrow = rect.width < 240;
  const areaScore = Math.min((rect.width * rect.height) / 10000, 80);
  const className = String(node.className || "").toLowerCase();
  const chatHint = /(chat|conversation|message|im|dialog|session)/.test(className) ? 30 : 0;
  const listPenalty = /(list|menu|sidebar|contact-list|session-list)/.test(className) ? -45 : 0;

  return areaScore
    + (isMainPane ? 50 : -20)
    + (isTooWide ? -35 : 0)
    + (isTooNarrow ? -40 : 0)
    + chatHint
    + listPenalty
    - depth * 4;
}

function isVisibleRect(rect) {
  return rect.width > 20 && rect.height > 20 && rect.bottom > 0 && rect.right > 0;
}

function findBuyerName(chatRoot, messages) {
  const scopedName = findBuyerNameInRoot(chatRoot, messages);
  if (scopedName) return scopedName;

  const selectedName = findSelectedBuyerName();
  if (selectedName) return selectedName;

  const candidates = [
    "[class*='buyer']",
    "[class*='Buyer']",
    "[class*='customer']",
    "[class*='Customer']",
    "[class*='contact']",
    "[class*='Contact']",
    "[class*='user-name']",
    "[class*='nickname']",
    "h1",
    "h2"
  ];

  for (const selector of candidates) {
    const text = firstUsefulText(document, selector);
    if (text && text.length <= 80) return text;
  }

  const titleParts = document.title.split(/[|-]/).map((part) => part.trim()).filter(Boolean);
  return titleParts[0] || "Unknown buyer";
}

function findBuyerNameInRoot(chatRoot, messages) {
  const selectors = [
    "[class*='header']",
    "[class*='Header']",
    "[class*='title']",
    "[class*='Title']",
    "[class*='name']",
    "[class*='Name']",
    "[class*='buyer']",
    "[class*='Buyer']",
    "[class*='contact']",
    "[class*='Contact']",
    "h1",
    "h2",
    "h3"
  ];

  const rootRect = chatRoot.getBoundingClientRect();
  const messageTexts = new Set((messages || []).map((item) => item.text));

  for (const selector of selectors) {
    const nodes = Array.from(chatRoot.querySelectorAll(selector));
    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      const isNearTop = rect.top <= rootRect.top + Math.max(140, rootRect.height * 0.2);
      const text = cleanText(node.innerText || node.textContent || "");
      if (isNearTop && isLikelyBuyerName(text) && !messageTexts.has(text)) return text;
    }
  }

  return "";
}

function findSelectedBuyerName() {
  const selectors = [
    "[aria-selected='true']",
    "[class*='active']",
    "[class*='Active']",
    "[class*='selected']",
    "[class*='Selected']",
    "[class*='current']",
    "[class*='Current']"
  ];

  for (const selector of selectors) {
    const text = firstUsefulText(document, selector);
    if (isLikelyBuyerName(text)) return text;
  }

  return "";
}

function firstUsefulText(root, selector) {
  const nodes = Array.from(root.querySelectorAll(selector));
  for (const node of nodes) {
    const text = cleanText(node.innerText || node.textContent || "");
    if (text && text.length > 1) return text;
  }
  return "";
}

function findMessages(chatRoot) {
  const nodeSet = findMessageNodes(chatRoot);

  const messages = Array.from(nodeSet)
    .map((node) => parseMessageNode(node))
    .filter((item) => isUsefulMessage(item.text))
    .filter((item, index, array) => array.findIndex((other) => other.text === item.text) === index)
    .slice(-120);

  if (messages.length >= 2) return messages;
  return fallbackVisibleText(chatRoot);
}

function findMessageNodes(root) {
  const nodeSet = new Set();
  for (const selector of MESSAGE_SELECTORS) {
    root.querySelectorAll(selector).forEach((node) => {
      if (node instanceof HTMLElement && isElementVisible(node)) nodeSet.add(node);
    });
  }
  return nodeSet;
}

function isElementVisible(node) {
  const rect = node.getBoundingClientRect();
  const style = window.getComputedStyle(node);
  return isVisibleRect(rect) && style.visibility !== "hidden" && style.display !== "none";
}

function parseMessageNode(node) {
  const text = cleanText(node.innerText || node.textContent || "");
  const className = String(node.className || "").toLowerCase();
  const sender = className.includes("self") || className.includes("right") || className.includes("seller")
    ? "seller"
    : className.includes("buyer") || className.includes("left") || className.includes("customer")
      ? "buyer"
      : "unknown";

  return {
    sender,
    text,
    time: findTimeNear(node)
  };
}

function findTimeNear(node) {
  const text = cleanText(node.innerText || "");
  const match = text.match(/\b(?:\d{1,2}:\d{2}|20\d{2}[-/.]\d{1,2}[-/.]\d{1,2})\b/);
  return match?.[0] || "";
}

function fallbackVisibleText(root) {
  const text = cleanText(root.innerText || "");
  return text
    .split("\n")
    .map((line) => cleanText(line))
    .filter(isUsefulMessage)
    .slice(-80)
    .map((line) => ({ sender: "unknown", text: line, time: "" }));
}

function cleanText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function isUsefulMessage(text) {
  if (!text || text.length < 2 || text.length > 1200) return false;
  const noisy = ["copyright", "privacy policy", "terms of use", "download app"];
  return !noisy.some((word) => text.toLowerCase().includes(word));
}

function isLikelyBuyerName(text) {
  if (!text || text.length < 2 || text.length > 80) return false;
  const blocked = [
    "message",
    "messages",
    "chat",
    "inquiry",
    "orders",
    "contacts",
    "search",
    "online",
    "offline",
    "type a message"
  ];
  const lower = text.toLowerCase();
  if (blocked.some((word) => lower.includes(word))) return false;
  if (text.split(" ").length > 8) return false;
  return true;
}

function normalizeBuyerKey(name, url) {
  const urlBuyerId = new URL(url).searchParams.get("buyerId")
    || new URL(url).searchParams.get("memberId")
    || new URL(url).searchParams.get("uid");
  const raw = urlBuyerId || name || url;
  return raw.toLowerCase().replace(/[^a-z0-9가-힣_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

}
