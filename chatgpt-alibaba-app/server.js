const http = require("http");
const crypto = require("crypto");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");

loadEnvFile(path.join(__dirname, ".env"));

const config = {
  port: Number(process.env.PORT || 8787),
  baseUrl: process.env.BASE_URL || `http://localhost:${process.env.PORT || 8787}`,
  sharedSecret: process.env.APP_SHARED_SECRET || "",
  mcpRequireAuth: String(process.env.MCP_REQUIRE_AUTH || "").toLowerCase() === "true",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiModel: process.env.OPENAI_MODEL || "gpt-4.1-mini",
  openaiUrl: process.env.OPENAI_CHAT_COMPLETIONS_URL || "https://api.openai.com/v1/chat/completions",
  alibabaAppKey: process.env.ALIBABA_APP_KEY || "",
  alibabaAppSecret: process.env.ALIBABA_APP_SECRET || "",
  alibabaAccessToken: process.env.ALIBABA_ACCESS_TOKEN || "",
  alibabaRefreshToken: process.env.ALIBABA_REFRESH_TOKEN || "",
  alibabaGateway: process.env.ALIBABA_GATEWAY || "https://eco.taobao.com/router/rest",
  alibabaRestGateway: process.env.ALIBABA_REST_GATEWAY || "https://openapi-api.alibaba.com/rest",
  alibabaSelfAccountId: process.env.ALIBABA_SELF_ACCOUNT_ID || "",
  alibabaTopSignMethod: process.env.ALIBABA_TOP_SIGN_METHOD || "hmac",
  alibabaImConversationListMethod: process.env.ALIBABA_IM_CONVERSATION_LIST_METHOD || "alibaba.interaction.im.conversation.list.query",
  alibabaImMessageListMethod: process.env.ALIBABA_IM_MESSAGE_LIST_METHOD || "alibaba.interaction.im.message.list.query"
};

const MCP_PROTOCOL_VERSION = "2025-06-18";
const APP_VERSION = "0.2.0";
const TOKEN_REFRESH_SAFETY_MS = 5 * 60 * 1000;

const tokenState = {
  accessToken: config.alibabaAccessToken,
  refreshToken: config.alibabaRefreshToken,
  accessTokenExpiresAt: parseDateMs(process.env.ALIBABA_ACCESS_TOKEN_EXPIRES_AT),
  refreshTokenExpiresAt: parseDateMs(process.env.ALIBABA_REFRESH_TOKEN_EXPIRES_AT),
  lastRefreshAt: 0
};

const server = http.createServer(async (req, res) => {
  try {
    setCorsHeaders(res);
    if (req.method === "OPTIONS") return sendJson(res, 204, {});

    const url = new URL(req.url, config.baseUrl);
    const routeKey = `${req.method} ${url.pathname}`;

    if (routeKey === "GET /health") {
      return sendJson(res, 200, {
        ok: true,
        service: "chatgpt-alibaba-app",
        alibabaConfigured: isAlibabaConfigured(),
        openaiConfigured: Boolean(config.openaiApiKey)
      });
    }

    if (routeKey === "GET /openapi.json") {
      return sendJson(res, 200, buildOpenApiSpec(getExternalBaseUrl(req)));
    }

    if (routeKey === "GET /api/alibaba/oauth/callback") {
      return sendOAuthCallback(res, url);
    }

    if (url.pathname === "/mcp") {
      return handleMcpRequest(req, res);
    }

    if (url.pathname.startsWith("/api/")) {
      assertAuthorized(req);
    }

    if (routeKey === "GET /api/alibaba/status") {
      return sendJson(res, 200, {
        configured: isAlibabaConfigured(),
        hasAppKey: Boolean(config.alibabaAppKey),
        hasAppSecret: Boolean(config.alibabaAppSecret),
        hasAccessToken: Boolean(tokenState.accessToken),
        hasRefreshToken: Boolean(tokenState.refreshToken),
        accessTokenExpiresAt: toIsoOrNull(tokenState.accessTokenExpiresAt),
        refreshTokenExpiresAt: toIsoOrNull(tokenState.refreshTokenExpiresAt),
        lastRefreshAt: toIsoOrNull(tokenState.lastRefreshAt),
        canAutoRefresh: canRefreshAlibabaToken(),
        hasSelfAccountId: Boolean(config.alibabaSelfAccountId),
        gateway: config.alibabaGateway
      });
    }

    if (routeKey === "POST /api/alibaba/oauth/token") {
      const input = await readJson(req);
      const result = await exchangeAlibabaCode(input);
      return sendJson(res, 200, result);
    }

    if (routeKey === "POST /api/alibaba/oauth/refresh") {
      const input = await readJson(req);
      const result = await refreshAlibabaAccessToken({
        force: input.force !== false,
        refreshToken: input.refresh_token || input.refreshToken || undefined
      });
      return sendJson(res, 200, result);
    }

    if (routeKey === "POST /api/products/search") {
      const input = await readJson(req);
      const products = await searchProducts(input);
      return sendJson(res, 200, products);
    }

    if (routeKey === "POST /api/buyer/summary") {
      const input = await readJson(req);
      const result = await summarizeBuyer(input);
      return sendJson(res, 200, result);
    }

    if (routeKey === "POST /api/buyer/history") {
      const input = await readJson(req);
      const result = await fetchConversationHistory(input);
      return sendJson(res, 200, result);
    }

    if (routeKey === "POST /api/buyer/conversations") {
      const input = await readJson(req);
      const result = await listImConversations(input);
      return sendJson(res, 200, result);
    }

    if (routeKey === "POST /api/buyer/recommend-products") {
      const input = await readJson(req);
      const result = await recommendProducts(input);
      return sendJson(res, 200, result);
    }

    if (routeKey === "POST /api/orders/brief") {
      const input = await readJson(req);
      const result = await getOrdersBrief(input);
      return sendJson(res, 200, result);
    }

    sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    const status = error.statusCode || 500;
    sendJson(res, status, {
      ok: false,
      error: error.message,
      code: error.code || "SERVER_ERROR"
    });
  }
});

function startServer(port = config.port) {
  return server.listen(port, () => {
    console.log(`ChatGPT Alibaba app backend running at ${config.baseUrl}`);
    console.log(`OpenAPI schema: ${config.baseUrl}/openapi.json`);
    console.log(`MCP endpoint: ${config.baseUrl}/mcp`);
  });
}

if (require.main === module) {
  startServer();
}

async function handleMcpRequest(req, res) {
  setMcpHeaders(res);

  if (config.mcpRequireAuth) {
    assertAuthorized(req);
  }

  if (req.method === "GET") {
    return sendJson(res, 200, {
      ok: true,
      service: "chatgpt-alibaba-app",
      protocol: "mcp",
      endpoint: "/mcp",
      message: "Send JSON-RPC MCP requests with POST."
    });
  }

  if (req.method === "DELETE") {
    res.writeHead(202);
    return res.end();
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }

  const payload = await readJson(req);
  const isBatch = Array.isArray(payload);
  const messages = isBatch ? payload : [payload];

  if (isBatch && messages.length === 0) {
    return sendJson(res, 400, jsonRpcError(null, -32600, "Invalid Request"));
  }

  const responses = [];
  for (const message of messages) {
    const response = await handleMcpMessage(message, req);
    if (response) responses.push(response);
  }

  if (!responses.length) {
    res.writeHead(202);
    return res.end();
  }

  return sendJson(res, 200, isBatch ? responses : responses[0]);
}

async function handleMcpMessage(message, req) {
  const id = message && Object.prototype.hasOwnProperty.call(message, "id") ? message.id : null;

  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return jsonRpcError(id, -32600, "Invalid Request");
  }

  if (!Object.prototype.hasOwnProperty.call(message, "id")) {
    return null;
  }

  try {
    switch (message.method) {
      case "initialize":
        return jsonRpcResult(id, {
          protocolVersion: message.params?.protocolVersion || MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false },
            prompts: { listChanged: false }
          },
          serverInfo: {
            name: "chatgpt-alibaba-assistant",
            title: "ChatGPT Alibaba Assistant",
            version: APP_VERSION
          },
          instructions: [
            "Use this server to help a Korean Alibaba seller inspect connection status, search products, summarize buyer conversations, and suggest product/reply follow-ups.",
            "Do not invent product URLs, prices, MOQ, delivery promises, or buyer facts. Use only returned Alibaba data or user-provided conversation text.",
            "When drafting buyer-facing replies, include the buyer language version and a Korean translation."
          ].join("\n")
        });

      case "ping":
        return jsonRpcResult(id, {});

      case "tools/list":
        return jsonRpcResult(id, { tools: getMcpTools() });

      case "tools/call":
        return jsonRpcResult(id, await callMcpTool(message.params || {}));

      case "resources/list":
        return jsonRpcResult(id, { resources: [] });

      case "prompts/list":
        return jsonRpcResult(id, { prompts: [] });

      default:
        return jsonRpcError(id, -32601, `Method not found: ${message.method}`);
    }
  } catch (error) {
    return jsonRpcResult(id, {
      isError: true,
      content: [
        {
          type: "text",
          text: `요청 처리 중 오류가 발생했습니다: ${error.message}`
        }
      ],
      structuredContent: {
        ok: false,
        error: error.message,
        code: error.code || "MCP_TOOL_ERROR"
      }
    });
  }
}

function getMcpTools() {
  return [
    {
      name: "alibaba_connection_status",
      title: "Alibaba connection status",
      description: "Check whether the Alibaba API credentials and seller account identifiers are configured on the backend.",
      inputSchema: {
        type: "object",
        properties: {}
      },
      annotations: {
        readOnlyHint: true
      }
    },
    {
      name: "search_alibaba_products",
      title: "Search Alibaba products",
      description: "Search the seller's Alibaba products by keyword and return product titles, ids, images, and URLs when available.",
      inputSchema: {
        type: "object",
        properties: {
          subject: {
            type: "string",
            description: "Product keyword or subject, for example cosmetic, pouch, bottle, or packaging."
          },
          page_size: {
            type: "number",
            minimum: 1,
            maximum: 30,
            description: "Number of products to return."
          },
          current_page: {
            type: "number",
            minimum: 1,
            description: "Result page number."
          },
          language: {
            type: "string",
            description: "Alibaba product language value. Defaults to ENGLISH."
          },
          products: {
            type: "array",
            description: "Optional product list already fetched from Alibaba, useful for testing formatting without calling the API.",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                product_id: { type: "string" },
                subject: { type: "string" },
                title: { type: "string" },
                pc_detail_url: { type: "string" },
                url: { type: "string" },
                status: { type: "string" },
                display: { type: "string" }
              }
            }
          }
        }
      },
      annotations: {
        readOnlyHint: true
      }
    },
    {
      name: "summarize_buyer_conversation",
      title: "Summarize buyer conversation",
      description: "Summarize the full buyer conversation flow in Korean and list likely next actions.",
      inputSchema: {
        type: "object",
        properties: {
          buyer_name: {
            type: "string",
            description: "Buyer name or account label."
          },
          conversation: {
            type: "string",
            description: "Conversation text copied from Alibaba chat or gathered by another client."
          },
          conversation_id: {
            type: "string",
            description: "Optional Alibaba IM conversation id. When provided, the server tries to fetch older messages from Alibaba before summarizing."
          },
          self_account_id: {
            type: "string",
            description: "Optional seller account id for IM lookup. Defaults to ALIBABA_SELF_ACCOUNT_ID."
          },
          max_pages: {
            type: "number",
            minimum: 1,
            maximum: 10,
            description: "Maximum IM message pages to fetch when conversation_id is provided."
          },
          messages: {
            type: "array",
            items: {
              type: "object",
              properties: {
                sender: { type: "string" },
                text: { type: "string" },
                time: { type: "string" }
              }
            }
          }
        }
      },
      annotations: {
        readOnlyHint: true
      }
    },
    {
      name: "list_alibaba_im_conversations",
      title: "List Alibaba IM conversations",
      description: "List recent Alibaba IM conversations for the configured seller account. Use this to find a conversation_id before fetching older messages.",
      inputSchema: {
        type: "object",
        properties: {
          seller_account_id: {
            type: "string",
            description: "Seller account id or seller short code. Defaults to ALIBABA_SELF_ACCOUNT_ID."
          },
          count: {
            type: "number",
            minimum: 1,
            maximum: 50,
            description: "Number of conversations to return."
          },
          limit_time_stamp: {
            type: "number",
            description: "Millisecond timestamp used as the pagination anchor. Defaults to current time."
          },
          include_session: {
            type: "boolean",
            description: "Send Alibaba access token as TOP session. Defaults to false because this API is documented as not requiring authorization."
          }
        }
      },
      annotations: {
        readOnlyHint: true
      }
    },
    {
      name: "fetch_alibaba_conversation_history",
      title: "Fetch Alibaba conversation history",
      description: "Fetch Alibaba IM messages by conversation_id, including older unloaded messages through timestamp pagination when available.",
      inputSchema: {
        type: "object",
        properties: {
          conversation_id: {
            type: "string",
            description: "Alibaba IM conversation id."
          },
          self_account_id: {
            type: "string",
            description: "Bound seller account id. Defaults to ALIBABA_SELF_ACCOUNT_ID."
          },
          count: {
            type: "number",
            minimum: 1,
            maximum: 100,
            description: "Messages per page."
          },
          max_pages: {
            type: "number",
            minimum: 1,
            maximum: 10,
            description: "Maximum pages to fetch while has_more is true."
          },
          forward: {
            type: "boolean",
            description: "Alibaba query direction. false means toward earlier timestamps; true means toward later timestamps."
          },
          limit_time_stamp: {
            type: "number",
            description: "Millisecond timestamp used as the pagination anchor. Defaults to current time."
          },
          include_session: {
            type: "boolean",
            description: "Send Alibaba access token as TOP session. Defaults to false because this API is documented as not requiring authorization."
          },
          messages: {
            type: "array",
            description: "Optional messages for testing normalization without calling Alibaba.",
            items: {
              type: "object",
              properties: {
                sender: { type: "string" },
                sender_account_id: { type: "string" },
                content: { type: "string" },
                text: { type: "string" },
                send_time: { type: "number" },
                time: { type: "string" }
              }
            }
          }
        }
      },
      annotations: {
        readOnlyHint: true
      }
    },
    {
      name: "recommend_products_for_buyer",
      title: "Recommend products for buyer",
      description: "Recommend seller products for a buyer based on conversation context, then draft a buyer-facing reply with Korean translation and next follow-up questions.",
      inputSchema: {
        type: "object",
        properties: {
          buyer_name: { type: "string" },
          conversation: {
            type: "string",
            description: "Buyer conversation text."
          },
          conversation_id: {
            type: "string",
            description: "Optional Alibaba IM conversation id. When provided, the server tries to fetch older messages before recommending products."
          },
          self_account_id: {
            type: "string",
            description: "Optional seller account id for IM lookup. Defaults to ALIBABA_SELF_ACCOUNT_ID."
          },
          max_pages: {
            type: "number",
            minimum: 1,
            maximum: 10,
            description: "Maximum IM message pages to fetch when conversation_id is provided."
          },
          product_query: {
            type: "string",
            description: "Keyword to search seller products with."
          },
          language: {
            type: "string",
            description: "Buyer language for the outgoing message, for example English, Spanish, Arabic, or Korean."
          },
          limit: {
            type: "number",
            minimum: 1,
            maximum: 10
          },
          products: {
            type: "array",
            description: "Optional product candidates already known to the user or client.",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                url: { type: "string" },
                image: { type: "string" },
                keywords: { type: "array", items: { type: "string" } }
              }
            }
          }
        }
      },
      annotations: {
        readOnlyHint: true
      }
    }
  ];
}

async function callMcpTool(params = {}) {
  const name = params.name || "";
  const args = params.arguments || {};

  switch (name) {
    case "alibaba_connection_status":
      return mcpToolResult({
        configured: isAlibabaConfigured(),
        hasAppKey: Boolean(config.alibabaAppKey),
        hasAppSecret: Boolean(config.alibabaAppSecret),
        hasAccessToken: Boolean(tokenState.accessToken),
        hasRefreshToken: Boolean(tokenState.refreshToken),
        accessTokenExpiresAt: toIsoOrNull(tokenState.accessTokenExpiresAt),
        refreshTokenExpiresAt: toIsoOrNull(tokenState.refreshTokenExpiresAt),
        lastRefreshAt: toIsoOrNull(tokenState.lastRefreshAt),
        canAutoRefresh: canRefreshAlibabaToken(),
        hasSelfAccountId: Boolean(config.alibabaSelfAccountId),
        gateway: config.alibabaGateway,
        restGateway: config.alibabaRestGateway,
        openaiConfigured: Boolean(config.openaiApiKey)
      }, "Alibaba 연결 상태를 확인했습니다.");

    case "search_alibaba_products":
      return mcpToolResult(await searchProducts(args), "Alibaba 상품 검색 결과입니다.");

    case "summarize_buyer_conversation":
      return mcpToolResult(await summarizeBuyer(args), "바이어 대화 요약입니다.");

    case "list_alibaba_im_conversations":
      return mcpToolResult(await listImConversations(args), "Alibaba IM 대화 목록입니다.");

    case "fetch_alibaba_conversation_history":
      return mcpToolResult(await fetchConversationHistory(args), "Alibaba IM 대화 히스토리입니다.");

    case "recommend_products_for_buyer":
      return mcpToolResult(await recommendProducts(args), "바이어에게 제안할 상품과 메시지 초안입니다.");

    default: {
      const error = new Error(`Unknown tool: ${name}`);
      error.code = "UNKNOWN_MCP_TOOL";
      throw error;
    }
  }
}

function mcpToolResult(structuredContent, heading) {
  return {
    content: [
      {
        type: "text",
        text: `${heading}\n\n${summarizeForMcpText(structuredContent)}`
      }
    ],
    structuredContent
  };
}

function summarizeForMcpText(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return JSON.stringify(value);

  if (Array.isArray(value.cards) || value.table_markdown || value.copy_block) {
    const cards = Array.isArray(value.cards) ? value.cards : buildProductCards(value.products || []);
    if (!cards.length) {
      return value.note ? `검색된 상품이 없습니다.\n\n${value.note}` : "검색된 상품이 없습니다.";
    }
    const totalLine = Number.isFinite(Number(value.total))
      ? `총 ${value.total}개 중 ${cards.length}개를 표시합니다.`
      : `${cards.length}개 상품을 표시합니다.`;
    const table = value.table_markdown || buildProductTableMarkdown(cards);
    const copyBlock = value.copy_block || buildProductUrlCopyBlock(cards);
    return [
      totalLine,
      "",
      table,
      "",
      "[복사용 URL 목록]",
      copyBlock
    ].filter(Boolean).join("\n");
  }
  if (Array.isArray(value.conversations)) {
    if (!value.conversations.length) return value.note || "조회된 IM 대화가 없습니다.";
    const rows = value.conversations.slice(0, 20).map((conversation, index) => {
      const latest = conversation.latest_message_time_text || conversation.latest_message_time || "";
      return `| ${index + 1} | ${escapeMarkdownTable(conversation.conversation_id)} | ${escapeMarkdownTable(latest)} |`;
    });
    return [
      `총 ${value.conversations.length}개 대화를 표시합니다.`,
      "",
      "| 순서 | conversation_id | 최근 메시지 시간 |",
      "| -: | --- | --- |",
      ...rows,
      value.has_more ? `\n다음 조회 기준 timestamp: ${value.next_time_stamp || ""}` : ""
    ].filter(Boolean).join("\n");
  }
  if (Array.isArray(value.messages)) {
    if (!value.messages.length) return value.note || "조회된 메시지가 없습니다.";
    const lines = value.messages.slice(0, 80).map((message, index) => {
      const time = message.time || message.send_time_text || message.send_time || "no time";
      const sender = message.sender || message.sender_account_id || "unknown";
      return `${index + 1}. [${time}] ${sender}: ${message.text || message.content || ""}`;
    });
    const pageNote = value.has_more ? `\n다음 조회 기준 timestamp: ${value.next_time_stamp || ""}` : "";
    return [
      `conversation_id: ${value.conversation_id || ""}`,
      `총 ${value.messages.length}개 메시지를 표시합니다.`,
      "",
      ...lines,
      pageNote
    ].filter(Boolean).join("\n");
  }
  if (Array.isArray(value.products)) {
    if (!value.products.length) return "검색된 상품이 없습니다.";
    return value.products.slice(0, 10).map((product, index) => {
      const title = product.title || product.subject || product.id || "Untitled product";
      const url = product.url ? ` - ${product.url}` : "";
      return `${index + 1}. ${title}${url}`;
    }).join("\n");
  }
  if (Array.isArray(value.recommendations)) {
    if (!value.recommendations.length) return "추천할 상품 후보가 없습니다.";
    const productLines = value.recommendations.slice(0, 10).map((product, index) => {
      const title = product.title || product.subject || product.product_id || product.id || "Untitled product";
      const reason = product.reason_ko ? ` (${product.reason_ko})` : "";
      const url = product.url ? ` - ${product.url}` : "";
      return `${index + 1}. ${title}${reason}${url}`;
    });
    const draft = value.share_message || value.reply_draft || {};
    const buyerMessage = draft.buyer_language ? `\n\n[바이어 답변]\n${draft.buyer_language}` : "";
    const korean = draft.korean_translation ? `\n\n[한국어 번역]\n${draft.korean_translation}` : "";
    const nextActions = Array.isArray(value.next_actions) && value.next_actions.length
      ? `\n\n[다음 확인]\n${value.next_actions.map((action) => `- ${action}`).join("\n")}`
      : "";
    return [
      "[추천 상품]",
      ...productLines,
      buyerMessage,
      korean,
      nextActions
    ].filter(Boolean).join("\n");
  }
  if (value.summary) return String(value.summary);

  return JSON.stringify(value, null, 2);
}

function jsonRpcResult(id, result) {
  return {
    jsonrpc: "2.0",
    id,
    result
  };
}

function jsonRpcError(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id,
    error: removeUndefined({
      code,
      message,
      data
    })
  };
}

async function searchProducts(input = {}) {
  const pageSize = clamp(Number(input.page_size || input.pageSize || 20), 1, 30);
  const currentPage = clamp(Number(input.current_page || input.currentPage || 1), 1, 100);
  const subject = input.subject || input.query || "";

  if (Array.isArray(input.products)) {
    const products = normalizeProducts(input.products).slice(0, pageSize);
    return buildProductSearchResult({
      ok: true,
      source: "provided",
      products,
      total: input.products.length,
      currentPage,
      pageSize,
      query: { subject }
    });
  }

  if (!isAlibabaConfigured()) {
    return buildProductSearchResult({
      ok: true,
      source: "not_configured",
      products: [],
      total: 0,
      currentPage,
      pageSize,
      query: { subject },
      note: "Alibaba credentials are not configured. Add ALIBABA_APP_KEY, ALIBABA_APP_SECRET, and ALIBABA_ACCESS_TOKEN or ALIBABA_REFRESH_TOKEN."
    });
  }

  const params = {
    subject,
    current_page: currentPage,
    page_size: pageSize,
    category_id: input.category_id || input.categoryId || undefined,
    group_id1: input.group_id1 || input.groupId1 || undefined,
    group_id2: input.group_id2 || input.groupId2 || undefined,
    group_id3: input.group_id3 || input.groupId3 || undefined,
    gmt_modified_from: input.gmt_modified_from || input.gmtModifiedFrom || undefined,
    gmt_modified_to: input.gmt_modified_to || input.gmtModifiedTo || undefined,
    id: input.id || input.product_id || input.productId || undefined
  };

  const response = await callAlibabaRestWithAccessToken("/alibaba/icbu/product/list", params);

  const products = normalizeProducts(findDeepArray(response, "products"));
  return buildProductSearchResult({
    ok: true,
    source: "/alibaba/icbu/product/list",
    products,
    total: findDeepValue(response, "total_item") || findDeepValue(response, "total") || findDeepValue(response, "total_count") || products.length,
    currentPage,
    pageSize,
    query: {
      subject,
      category_id: params.category_id,
      group_id1: params.group_id1,
      group_id2: params.group_id2,
      group_id3: params.group_id3,
      gmt_modified_from: params.gmt_modified_from,
      gmt_modified_to: params.gmt_modified_to,
      id: params.id
    }
  });
}

async function exchangeAlibabaCode(input = {}) {
  const code = input.code || input.authorization_code || input.authorizationCode || "";
  if (!code) {
    const error = new Error("Authorization code is required.");
    error.statusCode = 400;
    error.code = "MISSING_AUTHORIZATION_CODE";
    throw error;
  }

  const response = await callAlibabaRest("/auth/token/create", {
    code
  });

  const token = findDeepValue(response, "access_token");
  const refreshToken = findDeepValue(response, "refresh_token");
  const userId = findDeepValue(response, "user_id");
  const userNick = findDeepValue(response, "user_nick");
  const expiresIn = findDeepValue(response, "expires_in");
  const refreshExpiresIn = findDeepValue(response, "refresh_expires_in");
  const expireTime = findDeepValue(response, "expire_time");

  if (token) {
    updateAlibabaTokenState(response);
  }

  return {
    ok: true,
    source: "/auth/token/create",
    access_token: token,
    refresh_token: refreshToken,
    user_id: userId,
    user_nick: userNick,
    expires_in: expiresIn,
    refresh_expires_in: refreshExpiresIn,
    access_token_expires_at: toIsoOrNull(tokenState.accessTokenExpiresAt),
    refresh_token_expires_at: toIsoOrNull(tokenState.refreshTokenExpiresAt),
    expire_time: expireTime,
    raw: response,
    next_step: token
      ? "Add access_token and refresh_token to Render. The server can automatically refresh the access token when ALIBABA_REFRESH_TOKEN is configured."
      : "Token fields were not found in the response. Check raw response."
  };
}

async function refreshAlibabaAccessToken(options = {}) {
  const refreshToken = options.refreshToken || tokenState.refreshToken;
  if (!refreshToken) {
    const error = new Error("Alibaba refresh token is not configured.");
    error.statusCode = 503;
    error.code = "ALIBABA_REFRESH_TOKEN_MISSING";
    throw error;
  }

  if (!options.force && tokenState.accessToken && !isTokenExpiringSoon(tokenState.accessTokenExpiresAt)) {
    return safeAlibabaTokenStatus(false);
  }

  const response = await callAlibabaRest("/auth/token/refresh", {
    refresh_token: refreshToken
  });

  updateAlibabaTokenState(response, refreshToken);
  return safeAlibabaTokenStatus(true);
}

async function getAlibabaAccessToken() {
  if (tokenState.accessToken && !isTokenExpiringSoon(tokenState.accessTokenExpiresAt)) {
    return tokenState.accessToken;
  }

  if (tokenState.refreshToken) {
    await refreshAlibabaAccessToken({ force: !tokenState.accessToken || isTokenExpiringSoon(tokenState.accessTokenExpiresAt) });
  }

  return tokenState.accessToken;
}

async function callAlibabaRestWithAccessToken(apiPath, params = {}) {
  const token = await getAlibabaAccessToken();
  if (!token) {
    const error = new Error("Alibaba access token is not configured.");
    error.statusCode = 503;
    error.code = "ALIBABA_ACCESS_TOKEN_MISSING";
    throw error;
  }

  try {
    return await callAlibabaRest(apiPath, {
      ...params,
      access_token: token
    });
  } catch (error) {
    if (!canRefreshAlibabaToken() || !isAlibabaTokenError(error)) {
      throw error;
    }

    await refreshAlibabaAccessToken({ force: true });
    return callAlibabaRest(apiPath, {
      ...params,
      access_token: tokenState.accessToken
    });
  }
}

function updateAlibabaTokenState(response, fallbackRefreshToken = tokenState.refreshToken) {
  const token = findDeepValue(response, "access_token");
  const refreshToken = findDeepValue(response, "refresh_token") || fallbackRefreshToken;
  const expiresIn = Number(findDeepValue(response, "expires_in") || 0);
  const refreshExpiresIn = Number(findDeepValue(response, "refresh_expires_in") || 0);

  if (token) {
    tokenState.accessToken = token;
    config.alibabaAccessToken = token;
  }
  if (refreshToken) {
    tokenState.refreshToken = refreshToken;
    config.alibabaRefreshToken = refreshToken;
  }
  if (expiresIn > 0) {
    tokenState.accessTokenExpiresAt = Date.now() + expiresIn * 1000;
  }
  if (refreshExpiresIn > 0) {
    tokenState.refreshTokenExpiresAt = Date.now() + refreshExpiresIn * 1000;
  }
  tokenState.lastRefreshAt = Date.now();
}

function safeAlibabaTokenStatus(refreshed) {
  return {
    ok: true,
    refreshed,
    hasAccessToken: Boolean(tokenState.accessToken),
    hasRefreshToken: Boolean(tokenState.refreshToken),
    accessTokenExpiresAt: toIsoOrNull(tokenState.accessTokenExpiresAt),
    refreshTokenExpiresAt: toIsoOrNull(tokenState.refreshTokenExpiresAt),
    lastRefreshAt: toIsoOrNull(tokenState.lastRefreshAt),
    note: refreshed
      ? "Alibaba access token was refreshed in server memory. Update Render environment variables with the newest tokens if you need persistence across restarts."
      : "Alibaba access token is still valid or no refresh was needed."
  };
}

async function summarizeBuyer(input = {}) {
  const conversation = await buildConversationContext(input);
  const prompt = `다음 Alibaba 바이어 대화를 한국어로 보기 좋게 요약하세요.

바이어: ${input.buyer_name || input.buyerName || "Unknown buyer"}

대화:
${conversation || "(대화 없음)"}

아래 섹션을 반드시 사용하세요.
[현재 상태]
[대화 흐름]
[바이어 관심/조건]
[결정/약속]
[미해결]
[다음 액션]`;

  if (!config.openaiApiKey) {
    return {
      ok: true,
      source: "fallback",
      summary: fallbackSummary(conversation),
      note: "OpenAI API key is not configured, so a simple local summary was returned."
    };
  }

  const data = await callOpenAiJson([
    {
      role: "system",
      content: "You summarize B2B Alibaba buyer conversations for a Korean seller. Use only known facts."
    },
    { role: "user", content: prompt }
  ], {
    summary: "Korean structured summary",
    open_items: ["Follow-up item"],
    next_actions: ["Recommended seller action"]
  });

  return {
    ok: true,
    source: "openai",
    ...data
  };
}

async function recommendProducts(input = {}) {
  const limit = clamp(Number(input.limit || 5), 1, 10);
  const buyerName = input.buyer_name || input.buyerName || "Unknown buyer";
  const language = input.language || "English";
  const conversation = await buildConversationContext(input);
  const needs = extractNeedsLocally(conversation || input.buyer_message || input.buyerMessage || "");

  const productSearch = await searchProducts({
    subject: input.product_query || input.productQuery || needs.keywords[0] || "",
    page_size: input.product_page_size || input.productPageSize || 30,
    products: input.products,
    language: "ENGLISH"
  });

  const scoredProducts = scoreProducts(productSearch.products || [], needs).slice(0, Math.max(limit, 5));

  if (!config.openaiApiKey) {
    const recommendations = scoredProducts.slice(0, limit);
    const replyDraft = buildFallbackShareMessage(recommendations, language, needs);
    return {
      ok: true,
      source: "fallback",
      buyer_name: buyerName,
      product_source: productSearch.source,
      needs,
      recommendations,
      next_actions: buildNextActions(needs),
      share_message: replyDraft,
      seller_note_ko: buildSellerNoteKo(needs, recommendations),
      note: "OpenAI API key is not configured, so recommendations were ranked with local keyword matching. ChatGPT can refine the returned draft in the buyer language."
    };
  }

  const data = await callOpenAiJson([
    {
      role: "system",
      content: [
        "You are a B2B Alibaba sales assistant.",
        "Recommend seller products only from the provided product list.",
        "Never invent product URLs, prices, MOQ, or specs.",
        "Return concise JSON for a Korean seller.",
        `Write buyer-facing share message in ${language}, and include Korean translation.`
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        buyer_name: buyerName,
        conversation,
        extracted_needs: needs,
        candidate_products: scoredProducts
      }, null, 2)
    }
  ], {
    needs: {
      product_interest: ["..."],
      quantity: "...",
      country: "...",
      budget_or_price: "...",
      constraints: ["..."]
    },
    recommendations: [
      {
        product_id: "...",
        title: "...",
        url: "...",
        reason_ko: "...",
        match_score: 0
      }
    ],
    share_message: {
      buyer_language: "...",
      korean_translation: "..."
    },
    seller_note_ko: "..."
  });

  return {
    ok: true,
    source: "openai",
    product_source: productSearch.source,
    ...data
  };
}

async function getOrdersBrief(input = {}) {
  if (!isAlibabaConfigured()) {
    return {
      ok: true,
      source: "not_configured",
      orders: [],
      note: "Alibaba credentials are not configured. Add credentials before querying orders."
    };
  }

  const response = await callAlibaba("alibaba.seller.order.list", {
    current_page: clamp(Number(input.current_page || input.currentPage || 1), 1, 100),
    page_size: clamp(Number(input.page_size || input.pageSize || 20), 1, 50),
    create_start_time: input.create_start_time || input.createStartTime || undefined,
    create_end_time: input.create_end_time || input.createEndTime || undefined,
    order_status: input.order_status || input.orderStatus || undefined
  });

  return {
    ok: true,
    source: "alibaba.seller.order.list",
    raw: response
  };
}

async function buildConversationContext(input = {}) {
  const manualMessages = normalizeMessages(input.messages || []);
  const manualText = input.conversation || input.buyer_message || input.buyerMessage || "";
  const conversationId = input.conversation_id || input.conversationId || "";

  if (!conversationId) {
    return [
      manualText,
      manualMessages.map(formatMessage).join("\n")
    ].filter(Boolean).join("\n");
  }

  const history = await fetchConversationHistory({
    conversation_id: conversationId,
    self_account_id: input.self_account_id || input.selfAccountId,
    count: input.message_count || input.messageCount || 50,
    max_pages: input.max_pages || input.maxPages || 1,
    forward: input.forward,
    limit_time_stamp: input.limit_time_stamp || input.limitTimeStamp,
    include_session: input.include_session || input.includeSession
  });

  return [
    manualText,
    manualMessages.map(formatMessage).join("\n"),
    (history.messages || []).map(formatMessage).join("\n")
  ].filter(Boolean).join("\n");
}

async function listImConversations(input = {}) {
  const count = clamp(Number(input.count || 20), 1, 50);
  const sellerAccountId = input.seller_account_id || input.sellerAccountId || config.alibabaSelfAccountId;
  const limitTimeStamp = normalizeTimestamp(input.limit_time_stamp || input.limitTimeStamp || Date.now());

  if (Array.isArray(input.conversations)) {
    return {
      ok: true,
      source: "provided",
      request: { seller_account_id: sellerAccountId, count, limit_time_stamp: limitTimeStamp },
      conversations: normalizeConversations(input.conversations),
      has_more: Boolean(input.has_more || input.hasMore),
      next_time_stamp: input.next_time_stamp || input.nextTimeStamp || ""
    };
  }

  if (!isAlibabaConfigured()) {
    return {
      ok: true,
      source: "not_configured",
      conversations: [],
      note: "Alibaba credentials are not configured."
    };
  }

  if (!sellerAccountId) {
    return {
      ok: true,
      source: "missing_seller_account_id",
      conversations: [],
      note: "ALIBABA_SELF_ACCOUNT_ID or seller_account_id is required for IM conversation lookup."
    };
  }

  const paramsDto = removeUndefined({
    seller_account_id: sellerAccountId,
    limit_time_stamp: limitTimeStamp,
    count
  });

  const response = await callAlibaba(config.alibabaImConversationListMethod, {
    params: JSON.stringify(paramsDto)
  }, {
    includeSession: parseBoolean(input.include_session ?? input.includeSession, false),
    signMethod: input.sign_method || input.signMethod || config.alibabaTopSignMethod
  });

  return {
    ok: true,
    source: config.alibabaImConversationListMethod,
    request: paramsDto,
    conversations: normalizeConversations(findDeepArrayForKeys(response, ["conversation_d_t_o", "conversation_list", "conversations"])),
    has_more: parseBoolean(findDeepValue(response, "has_more"), false),
    next_time_stamp: findDeepValue(response, "next_time_stamp") || "",
    raw: input.include_raw || input.includeRaw ? response : undefined
  };
}

async function fetchConversationHistory(input = {}) {
  const conversationId = input.conversation_id || input.conversationId || "";
  const selfAccountId = input.self_account_id || input.selfAccountId || config.alibabaSelfAccountId;
  const count = clamp(Number(input.count || input.message_count || input.messageCount || 50), 1, 100);
  const maxPages = clamp(Number(input.max_pages || input.maxPages || 1), 1, 10);
  const forward = parseBoolean(input.forward, false);
  const includeSession = parseBoolean(input.include_session ?? input.includeSession, false);

  if (Array.isArray(input.messages)) {
    return buildConversationHistoryResult({
      source: "provided",
      conversationId,
      request: { conversation_id: conversationId, count, max_pages: maxPages, forward },
      messages: normalizeMessages(input.messages),
      hasMore: Boolean(input.has_more || input.hasMore),
      nextTimeStamp: input.next_time_stamp || input.nextTimeStamp || ""
    });
  }

  if (!isAlibabaConfigured()) {
    return buildConversationHistoryResult({
      source: "not_configured",
      conversationId,
      request: { conversation_id: conversationId, count, max_pages: maxPages, forward },
      messages: [],
      note: "Alibaba credentials are not configured."
    });
  }

  if (!conversationId) {
    return buildConversationHistoryResult({
      source: "missing_conversation_id",
      conversationId,
      request: { count, max_pages: maxPages, forward },
      messages: [],
      note: "conversation_id is required. First call list_alibaba_im_conversations to find it."
    });
  }

  if (!selfAccountId) {
    return buildConversationHistoryResult({
      source: "missing_self_account_id",
      conversationId,
      request: { conversation_id: conversationId, count, max_pages: maxPages, forward },
      messages: [],
      note: "ALIBABA_SELF_ACCOUNT_ID or self_account_id is required for IM message lookup."
    });
  }

  let limitTimeStamp = normalizeTimestamp(input.limit_time_stamp || input.limitTimeStamp || Date.now());
  const allMessages = [];
  const pages = [];
  let hasMore = false;
  let nextTimeStamp = "";

  for (let page = 1; page <= maxPages; page += 1) {
    const pageResult = await getImMessagesPage({
      conversationId,
      selfAccountId,
      count,
      forward,
      limitTimeStamp,
      includeSession,
      signMethod: input.sign_method || input.signMethod || config.alibabaTopSignMethod,
      includeRaw: input.include_raw || input.includeRaw
    });

    allMessages.push(...pageResult.messages);
    pages.push({
      page,
      count: pageResult.messages.length,
      has_more: pageResult.has_more,
      next_time_stamp: pageResult.next_time_stamp
    });

    hasMore = pageResult.has_more;
    nextTimeStamp = pageResult.next_time_stamp || "";

    if (!hasMore || !nextTimeStamp || String(nextTimeStamp) === String(limitTimeStamp)) break;
    limitTimeStamp = nextTimeStamp;
  }

  return buildConversationHistoryResult({
    source: config.alibabaImMessageListMethod,
    conversationId,
    request: {
      conversation_id: conversationId,
      self_account_id: selfAccountId,
      count,
      max_pages: maxPages,
      forward,
      initial_limit_time_stamp: normalizeTimestamp(input.limit_time_stamp || input.limitTimeStamp || Date.now()),
      include_session: includeSession
    },
    messages: sortMessagesByTime(dedupeMessages(allMessages)),
    hasMore,
    nextTimeStamp,
    pages
  });
}

async function getImMessagesPage(input = {}) {
  const paramsDto = removeUndefined({
    conversation_id: input.conversationId,
    count: input.count,
    forward: input.forward,
    limit_time_stamp: input.limitTimeStamp,
    self_account_id: input.selfAccountId
  });

  const response = await callAlibaba(config.alibabaImMessageListMethod, {
    params: JSON.stringify(paramsDto)
  }, {
    includeSession: input.includeSession,
    signMethod: input.signMethod
  });

  return {
    messages: normalizeMessages(findDeepArrayForKeys(response, ["message_d_t_o", "message_list", "messages"])),
    has_more: parseBoolean(findDeepValue(response, "has_more"), false),
    next_time_stamp: findDeepValue(response, "next_time_stamp") || "",
    raw: input.includeRaw ? response : undefined
  };
}

async function callOpenAiJson(messages, schemaExample) {
  const response = await fetch(config.openaiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.openaiApiKey}`
    },
    body: JSON.stringify({
      model: config.openaiModel,
      messages: [
        ...messages,
        {
          role: "user",
          content: `Return JSON only. Shape example:\n${JSON.stringify(schemaExample, null, 2)}`
        }
      ],
      temperature: 0.2,
      response_format: { type: "json_object" }
    })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.error?.message || `OpenAI request failed with HTTP ${response.status}`);
    error.statusCode = 502;
    error.code = "OPENAI_REQUEST_FAILED";
    throw error;
  }

  const content = body?.choices?.[0]?.message?.content;
  if (!content) {
    const error = new Error("OpenAI response did not include JSON content.");
    error.statusCode = 502;
    error.code = "OPENAI_EMPTY_RESPONSE";
    throw error;
  }
  return JSON.parse(content);
}

async function callAlibaba(method, params = {}, options = {}) {
  if (!config.alibabaAppKey || !config.alibabaAppSecret) {
    const error = new Error("Alibaba app key/secret are not configured.");
    error.statusCode = 503;
    error.code = "ALIBABA_NOT_CONFIGURED";
    throw error;
  }

  const sessionToken = options.includeSession === false ? undefined : await getAlibabaAccessToken();
  const signMethod = options.signMethod || config.alibabaTopSignMethod || "md5";
  const allParams = removeUndefined({
    method,
    app_key: config.alibabaAppKey,
    sign_method: signMethod,
    timestamp: formatGmt8(new Date()),
    format: "json",
    v: "2.0",
    simplify: "true",
    session: sessionToken || undefined,
    ...params
  });

  allParams.sign = signTopParams(allParams, config.alibabaAppSecret, signMethod);

  const response = await fetch(config.alibabaGateway, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
    },
    body: new URLSearchParams(allParams)
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.error_response) {
    const apiError = body?.error_response;
    const error = new Error(apiError?.sub_msg || apiError?.msg || `Alibaba request failed with HTTP ${response.status}`);
    error.statusCode = 502;
    error.code = apiError?.code || "ALIBABA_REQUEST_FAILED";
    throw error;
  }

  return body;
}

async function callAlibabaRest(apiPath, params = {}) {
  if (!config.alibabaAppKey || !config.alibabaAppSecret) {
    const error = new Error("Alibaba app key/secret are not configured.");
    error.statusCode = 503;
    error.code = "ALIBABA_NOT_CONFIGURED";
    throw error;
  }

  const cleanPath = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  const allParams = removeUndefined({
    ...params,
    app_key: config.alibabaAppKey,
    sign_method: "sha256",
    timestamp: String(Date.now())
  });

  allParams.sign = signIopParams(cleanPath, allParams, config.alibabaAppSecret);

  const response = await fetch(`${config.alibabaRestGateway}${cleanPath}?${new URLSearchParams(allParams)}`, {
    method: "GET",
    headers: {
      "Accept": "application/json"
    }
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.code && body.code !== "0") {
    const error = new Error(body?.message || body?.msg || `Alibaba REST request failed with HTTP ${response.status}`);
    error.statusCode = 502;
    error.code = body?.code || "ALIBABA_REST_REQUEST_FAILED";
    error.details = body;
    throw error;
  }

  return body;
}

function signTopParams(params, secret, signMethod = "md5") {
  const base = secret + Object.keys(params)
    .filter((key) => key !== "sign" && params[key] !== undefined && params[key] !== null)
    .sort()
    .map((key) => `${key}${String(params[key])}`)
    .join("") + secret;

  if (String(signMethod).toLowerCase() === "hmac") {
    const hmacBase = Object.keys(params)
      .filter((key) => key !== "sign" && params[key] !== undefined && params[key] !== null)
      .sort()
      .map((key) => `${key}${String(params[key])}`)
      .join("");
    return crypto.createHmac("md5", secret).update(hmacBase, "utf8").digest("hex").toUpperCase();
  }

  return crypto.createHash("md5").update(base, "utf8").digest("hex").toUpperCase();
}

function signIopParams(apiPath, params, secret) {
  const signSource = apiPath + Object.keys(params)
    .filter((key) => key !== "sign" && params[key] !== undefined && params[key] !== null)
    .sort()
    .map((key) => `${key}${String(params[key])}`)
    .join("");

  return crypto.createHmac("sha256", secret).update(signSource, "utf8").digest("hex").toUpperCase();
}

function buildOpenApiSpec(baseUrl = config.baseUrl) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Alibaba Account Assistant API",
      version: APP_VERSION,
      description: "ChatGPT Actions API for Alibaba buyer summaries, product recommendations, product search, and order briefs."
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer"
        }
      },
      schemas: {
        Product: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            url: { type: "string" },
            image: { type: "string" },
            keywords: { type: "array", items: { type: "string" } },
            status: { type: "string" }
          }
        }
      }
    },
    security: config.sharedSecret ? [{ bearerAuth: [] }] : [],
    paths: {
      "/api/alibaba/status": {
        get: {
          operationId: "getAlibabaConnectionStatus",
          summary: "Check Alibaba API credential status",
          responses: {
            "200": { description: "Credential status" }
          }
        }
      },
      "/api/alibaba/oauth/token": {
        post: {
          operationId: "exchangeAlibabaAuthorizationCode",
          summary: "Exchange an Alibaba authorization code for an access token",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["code"],
                  properties: {
                    code: { type: "string" }
                  }
                }
              }
            }
          },
          responses: {
            "200": { description: "Alibaba access token response" }
          }
        }
      },
      "/api/alibaba/oauth/refresh": {
        post: {
          operationId: "refreshAlibabaAccessToken",
          summary: "Refresh the Alibaba access token in server memory using the configured refresh token",
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    force: {
                      type: "boolean",
                      description: "When true, refresh even if the current token is not known to be expiring."
                    }
                  }
                }
              }
            }
          },
          responses: {
            "200": { description: "Safe token refresh status without raw token values" }
          }
        }
      },
      "/api/products/search": {
        post: {
          operationId: "searchAlibabaProducts",
          summary: "Search seller products from Alibaba",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    subject: { type: "string" },
                    category_id: { type: "number" },
                    page_size: { type: "number" },
                    current_page: { type: "number" }
                  }
                }
              }
            }
          },
          responses: {
            "200": { description: "Product search results" }
          }
        }
      },
      "/api/buyer/summary": {
        post: {
          operationId: "summarizeAlibabaBuyer",
          summary: "Summarize an Alibaba buyer conversation",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    buyer_name: { type: "string" },
                    conversation_id: { type: "string" },
                    conversation: { type: "string" },
                    messages: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          sender: { type: "string" },
                          text: { type: "string" },
                          time: { type: "string" }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          responses: {
            "200": { description: "Structured buyer summary" }
          }
        }
      },
      "/api/buyer/conversations": {
        post: {
          operationId: "listAlibabaImConversations",
          summary: "List Alibaba IM conversations for the configured seller account",
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    seller_account_id: { type: "string" },
                    count: { type: "number" },
                    limit_time_stamp: { type: "number" },
                    include_session: { type: "boolean" }
                  }
                }
              }
            }
          },
          responses: {
            "200": { description: "Alibaba IM conversation list" }
          }
        }
      },
      "/api/buyer/history": {
        post: {
          operationId: "fetchAlibabaConversationHistory",
          summary: "Fetch Alibaba IM messages by conversation id",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    conversation_id: { type: "string" },
                    self_account_id: { type: "string" },
                    count: { type: "number" },
                    max_pages: { type: "number" },
                    forward: { type: "boolean" },
                    limit_time_stamp: { type: "number" },
                    include_session: { type: "boolean" }
                  }
                }
              }
            }
          },
          responses: {
            "200": { description: "Alibaba IM message history" }
          }
        }
      },
      "/api/buyer/recommend-products": {
        post: {
          operationId: "recommendProductsForAlibabaBuyer",
          summary: "Recommend seller products for an Alibaba buyer based on conversation context",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    buyer_name: { type: "string" },
                    conversation_id: { type: "string" },
                    conversation: { type: "string" },
                    product_query: { type: "string" },
                    language: { type: "string" },
                    limit: { type: "number" },
                    products: {
                      type: "array",
                      items: { "$ref": "#/components/schemas/Product" }
                    }
                  }
                }
              }
            }
          },
          responses: {
            "200": { description: "Recommended products and share message" }
          }
        }
      },
      "/api/orders/brief": {
        post: {
          operationId: "getAlibabaOrdersBrief",
          summary: "Get a brief list of Alibaba seller orders",
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    current_page: { type: "number" },
                    page_size: { type: "number" },
                    order_status: { type: "string" },
                    create_start_time: { type: "string" },
                    create_end_time: { type: "string" }
                  }
                }
              }
            }
          },
          responses: {
            "200": { description: "Order brief" }
          }
        }
      }
    }
  };
}

function extractNeedsLocally(text) {
  const lower = String(text || "").toLowerCase();
  const stopWords = new Set([
    "hello", "please", "thanks", "thank", "price", "want", "need", "order", "product",
    "products", "looking", "recommend", "initial", "quantity", "buyer", "seller", "with",
    "for", "and", "the", "your", "our", "you", "are", "can", "would", "could", "send",
    "about", "this", "that", "first", "item", "items", "interested"
  ]);
  const keywords = Array.from(new Set(
    lower
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[^a-z0-9가-힣\s-]/gi, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 3)
      .filter((word) => !stopWords.has(word))
  )).slice(0, 12);

  const quantityMatch = lower.match(/\b\d{1,7}\s?(?:pcs|pieces|units|sets|개|ea)\b/i);
  const countryMatch = lower.match(/\b(?:usa|united states|korea|japan|china|germany|canada|australia|uk|india|vietnam|uae|saudi)\b/i);
  const interestTerms = [
    "blemish", "brightening", "whitening", "sensitive", "moisturizer", "cream", "serum",
    "cleanser", "cleansing", "foam", "ampoule", "snail", "niacinamide", "aloe", "vegan",
    "oem", "odm", "private label", "anti-aging", "wrinkle", "hydration", "acne"
  ].filter((term) => lower.includes(term));

  return {
    keywords,
    product_interest: interestTerms,
    quantity: quantityMatch?.[0] || "",
    country: countryMatch?.[0] || "",
    constraints: [
      lower.includes("sample") ? "sample requested" : "",
      lower.includes("moq") ? "MOQ mentioned" : "",
      lower.includes("shipping") || lower.includes("delivery") ? "shipping/delivery mentioned" : "",
      lower.includes("sensitive") ? "sensitive skin mentioned" : "",
      lower.includes("private label") || lower.includes("oem") || lower.includes("odm") ? "OEM/ODM or private label mentioned" : ""
    ].filter(Boolean)
  };
}

function scoreProducts(products, needs) {
  const keywords = new Set([
    ...(needs.keywords || []),
    ...(needs.product_interest || [])
  ].map((word) => word.toLowerCase()));
  return products.map((product) => {
    const haystack = [
      product.title,
      product.subject,
      product.id,
      ...(product.keywords || [])
    ].join(" ").toLowerCase();
    const keywordHits = Array.from(keywords).filter((word) => haystack.includes(word));
    const score = keywordHits.length * 20
      + (product.url ? 10 : 0)
      + (product.image ? 5 : 0)
      + (String(product.status || "").toLowerCase() === "approved" ? 5 : 0);

    return {
      ...product,
      match_score: score,
      matched_keywords: keywordHits,
      reason_ko: keywordHits.length
        ? `대화 키워드(${keywordHits.join(", ")})와 상품 정보가 일치합니다.`
        : "상품 URL과 기본 정보가 있어 후보로 검토할 수 있습니다."
    };
  }).sort((a, b) => b.match_score - a.match_score);
}

function buildFallbackShareMessage(products, language, needs = {}) {
  const lines = products.map((product, index) => {
    const url = product.url ? ` ${product.url}` : "";
    return `${index + 1}. ${product.title || product.id}${url}`;
  });
  const interest = (needs.product_interest || needs.keywords || []).slice(0, 5).join(", ") || "your requested skincare requirements";
  const quantity = needs.quantity ? ` Your initial quantity of ${needs.quantity} is noted.` : "";
  const country = needs.country ? ` We can also check shipping options for ${needs.country}.` : "";
  const followUp = "Could you please confirm your preferred formula type, target price range, and whether you need OEM/ODM or private label service?";

  const englishDraft = [
    `Hello, thank you for your inquiry. Based on your interest in ${interest}, I recommend the following products:`,
    lines.join("\n"),
    `${quantity}${country}`.trim(),
    followUp
  ].filter(Boolean).join("\n\n");

  const koreanDraft = [
    `안녕하세요. 문의 주셔서 감사합니다. 바이어가 언급한 조건(${interest})을 기준으로 아래 상품을 추천드립니다:`,
    lines.join("\n"),
    needs.quantity ? `초도 수량 ${needs.quantity}도 함께 확인했습니다.` : "",
    needs.country ? `${needs.country} 배송 가능 여부도 확인해볼 수 있습니다.` : "",
    "희망 제형, 목표 가격대, OEM/ODM 또는 프라이빗 라벨 필요 여부를 확인해 달라는 답변입니다."
  ].filter(Boolean).join("\n\n");

  return {
    buyer_language: language.toLowerCase().startsWith("ko")
      ? koreanDraft
      : englishDraft,
    korean_translation: koreanDraft,
    buyer_language_note: language.toLowerCase().startsWith("ko")
      ? "Buyer language is Korean."
      : `Draft is in English. If the buyer language is ${language} and not English, ChatGPT should translate this draft before sending.`
  };
}

function buildNextActions(needs = {}) {
  return [
    needs.quantity ? "" : "초도 수량 또는 예상 월 주문 수량 확인",
    needs.country ? "" : "배송 국가와 희망 납기 확인",
    "목표 가격대와 MOQ 수용 가능 범위 확인",
    "OEM/ODM 또는 프라이빗 라벨 필요 여부 확인",
    "관심 상품 URL을 공유하고 샘플 필요 여부 확인"
  ].filter(Boolean);
}

function buildSellerNoteKo(needs = {}, products = []) {
  const interests = (needs.product_interest || needs.keywords || []).slice(0, 6).join(", ") || "명확한 키워드 없음";
  const productCount = products.length;
  return [
    `감지된 관심 키워드: ${interests}`,
    needs.quantity ? `수량: ${needs.quantity}` : "수량: 추가 확인 필요",
    needs.country ? `국가: ${needs.country}` : "국가/배송지: 추가 확인 필요",
    `추천 상품 수: ${productCount}`,
    "가격, MOQ, 납기, 인증/성분 자료는 실제 판매 조건 확인 후 안내하세요."
  ].join("\n");
}

function fallbackSummary(conversation) {
  const lines = String(conversation || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-5);

  return [
    "[현재 상태]",
    "- OpenAI API 키가 없어 간단 요약만 생성했습니다.",
    "",
    "[대화 흐름]",
    ...lines.map((line) => `- ${line}`),
    "",
    "[미해결]",
    "- 수량, 가격, 배송 조건 등 핵심 조건을 확인하세요.",
    "",
    "[다음 액션]",
    "- 바이어의 제품 조건을 확인하고 적합한 상품 URL을 공유하세요."
  ].join("\n");
}

function buildProductSearchResult(input = {}) {
  const products = Array.isArray(input.products) ? input.products : [];
  const cards = buildProductCards(products);
  return removeUndefined({
    ok: input.ok !== false,
    source: input.source,
    query: removeUndefined(input.query || {}),
    total: input.total,
    currentPage: input.currentPage,
    pageSize: input.pageSize,
    products,
    cards,
    share_urls: cards.map((card) => card.url).filter(Boolean),
    table_markdown: buildProductTableMarkdown(cards),
    copy_block: buildProductUrlCopyBlock(cards),
    note: input.note
  });
}

function buildProductCards(products = []) {
  return products.map((product, index) => removeUndefined({
    rank: index + 1,
    product_id: product.product_id || product.id,
    title: product.title || product.subject || product.product_id || product.id || "Untitled product",
    url: product.url,
    image: product.image,
    status: product.status,
    display: product.display,
    status_label: formatProductStatus(product),
    group_name: product.group_name,
    category_id: product.category_id,
    group_id: product.group_id,
    product_type: product.product_type,
    rts: product.rts,
    specific: product.specific,
    gmt_modified: product.gmt_modified,
    badges: buildProductBadges(product),
    keywords: Array.isArray(product.keywords) ? product.keywords.slice(0, 3) : []
  }));
}

function buildProductBadges(product = {}) {
  return [
    product.status ? `Status: ${product.status}` : "",
    product.display ? `Display: ${product.display}` : "",
    product.group_name ? `Group: ${product.group_name}` : "",
    product.product_type ? `Type: ${product.product_type}` : "",
    product.rts === true ? "RTS" : "",
    product.specific === true ? "Specific" : ""
  ].filter(Boolean);
}

function buildProductTableMarkdown(products = []) {
  const rows = products.slice(0, 10);
  if (!rows.length) return "";
  return [
    "| 순서 | 상품명 | 상태 | 상품 ID | URL |",
    "| -: | --- | --- | --- | --- |",
    ...rows.map((product, index) => {
      const title = escapeMarkdownTable(truncateText(product.title || product.subject || "Untitled product", 90));
      const status = escapeMarkdownTable(product.status_label || formatProductStatus(product));
      const productId = escapeMarkdownTable(product.product_id || product.id || "");
      const url = escapeMarkdownTable(product.url || "");
      return `| ${index + 1} | ${title} | ${status} | ${productId} | ${url} |`;
    })
  ].join("\n");
}

function buildProductUrlCopyBlock(products = []) {
  return products
    .filter((product) => product.url)
    .slice(0, 10)
    .map((product, index) => `${index + 1}. ${product.title || product.product_id || product.id}\n${product.url}`)
    .join("\n\n");
}

function formatProductStatus(product = {}) {
  const status = product.status ? capitalizeFirst(product.status) : "";
  const display = product.display ? `Display ${product.display}` : "";
  return [status, display].filter(Boolean).join(" / ") || "상태 없음";
}

function truncateText(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function escapeMarkdownTable(value) {
  return String(value || "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function capitalizeFirst(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function normalizeProducts(products = []) {
  return products.map((product) => {
    const images = product?.main_image?.images || product?.mainImage?.images || product?.images || [];
    return {
      id: String(product.id || product.product_id || product.productId || ""),
      product_id: String(product.product_id || product.productId || product.id || ""),
      title: product.subject || product.title || product.name || "",
      subject: product.subject || product.title || product.name || "",
      keywords: Array.isArray(product.keywords) ? product.keywords : [],
      image: Array.isArray(images) ? images[0] || "" : String(images || ""),
      url: product.pc_detail_url || product.pcDetailUrl || product.url || "",
      status: product.status || "",
      display: product.display || "",
      language: product.language || "",
      category_id: product.category_id || product.categoryId || "",
      group_id: product.group_id || product.groupId || "",
      group_name: product.group_name || product.groupName || "",
      owner_member: product.owner_member || product.ownerMember || "",
      owner_member_display_name: product.owner_member_display_name || product.ownerMemberDisplayName || "",
      gmt_create: product.gmt_create || product.gmtCreate || "",
      gmt_modified: product.gmt_modified || product.gmtModified || "",
      specific: product.specific,
      rts: product.rts,
      smart_edit: product.smart_edit || product.smartEdit,
      product_type: product.product_type || product.productType || "",
      raw: product
    };
  }).filter((product) => product.title || product.id || product.url);
}

function normalizeConversations(conversations = []) {
  return conversations.map((conversation) => {
    const latest = conversation.latest_message_time || conversation.latestMessageTime || conversation.gmt_modified || "";
    return removeUndefined({
      conversation_id: String(conversation.conversation_id || conversation.conversationId || conversation.id || ""),
      latest_message_time: latest,
      latest_message_time_text: formatMaybeTimestamp(latest),
      buyer_account_id: conversation.buyer_account_id || conversation.buyerAccountId || conversation.receiver_account_id || "",
      seller_account_id: conversation.seller_account_id || conversation.sellerAccountId || conversation.sender_account_id || "",
      raw: conversation
    });
  }).filter((conversation) => conversation.conversation_id);
}

function normalizeMessages(messages = []) {
  return messages.map((message) => ({
    message_id: String(message.message_id || message.messageId || message.id || ""),
    conversation_id: String(message.conversation_id || message.conversationId || ""),
    message_type: message.message_type || message.messageType || "",
    sender: message.sender || message.sender_account_id || message.senderAccountId || "unknown",
    sender_account_id: String(message.sender_account_id || message.senderAccountId || message.sender || ""),
    receiver_account_id: String(message.receiver_account_id || message.receiverAccountId || message.receiver || ""),
    text: extractMessageText(message),
    content: message.content || message.text || message.message || "",
    send_time: message.send_time || message.sendTime || message.time || "",
    send_time_text: formatMaybeTimestamp(message.send_time || message.sendTime || message.time || ""),
    time: message.time || formatMaybeTimestamp(message.send_time || message.sendTime || "")
  })).filter((message) => message.text);
}

function formatMessage(message) {
  return `[${message.time || message.send_time_text || "no time"}] ${message.sender || message.sender_account_id || "unknown"}: ${message.text}`;
}

function extractMessageText(message = {}) {
  const direct = message.text || message.message || message.content_text || message.contentText;
  if (direct) return String(direct);

  const content = message.content;
  if (!content) return "";
  if (typeof content !== "string") return JSON.stringify(content);

  const trimmed = content.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return trimmed;

  try {
    const parsed = JSON.parse(trimmed);
    const candidate = parsed.text || parsed.message || parsed.content || parsed.params || trimmed;
    return typeof candidate === "string" ? candidate : JSON.stringify(candidate);
  } catch {
    return trimmed;
  }
}

function buildConversationHistoryResult(input = {}) {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  return removeUndefined({
    ok: true,
    source: input.source,
    conversation_id: input.conversationId,
    request: removeUndefined(input.request || {}),
    messages,
    message_count: messages.length,
    has_more: Boolean(input.hasMore),
    next_time_stamp: input.nextTimeStamp || "",
    pages: input.pages,
    note: input.note
  });
}

function dedupeMessages(messages = []) {
  const seen = new Set();
  return messages.filter((message) => {
    const key = message.message_id || `${message.send_time}:${message.sender_account_id}:${message.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortMessagesByTime(messages = []) {
  return messages.slice().sort((a, b) => Number(a.send_time || 0) - Number(b.send_time || 0));
}

function normalizeTimestamp(value) {
  if (value === undefined || value === null || value === "") return Date.now();
  const number = Number(value);
  if (Number.isFinite(number)) return number;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? Date.now() : date.getTime();
}

function formatMaybeTimestamp(value) {
  if (value === undefined || value === null || value === "") return "";
  const number = Number(value);
  if (Number.isFinite(number) && number > 100000000000) {
    return new Date(number).toISOString();
  }
  return String(value);
}

function findDeepArray(value, targetKey) {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value;
  if (Array.isArray(value[targetKey])) return value[targetKey];
  for (const child of Object.values(value)) {
    const result = findDeepArray(child, targetKey);
    if (result.length) return result;
  }
  return [];
}

function findDeepArrayForKeys(value, targetKeys = []) {
  for (const key of targetKeys) {
    const found = findDeepArrayExact(value, key);
    if (found.length) return found;
  }
  return [];
}

function findDeepArrayExact(value, targetKey) {
  if (!value || typeof value !== "object") return [];
  if (!Array.isArray(value) && Array.isArray(value[targetKey])) return value[targetKey];
  if (!Array.isArray(value) && value[targetKey] && typeof value[targetKey] === "object") {
    return Object.values(value[targetKey]).find(Array.isArray) || [];
  }
  for (const child of Object.values(value)) {
    const result = findDeepArrayExact(child, targetKey);
    if (result.length) return result;
  }
  return [];
}

function findDeepValue(value, targetKey) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(value, targetKey)) return value[targetKey];
  for (const child of Object.values(value)) {
    const result = findDeepValue(child, targetKey);
    if (result !== undefined) return result;
  }
  return undefined;
}

function formatGmt8(date) {
  const gmt8 = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return `${gmt8.getUTCFullYear()}-${pad(gmt8.getUTCMonth() + 1)}-${pad(gmt8.getUTCDate())} ${pad(gmt8.getUTCHours())}:${pad(gmt8.getUTCMinutes())}:${pad(gmt8.getUTCSeconds())}`;
}

function isAlibabaConfigured() {
  return Boolean(config.alibabaAppKey && config.alibabaAppSecret && (tokenState.accessToken || tokenState.refreshToken));
}

function canRefreshAlibabaToken() {
  return Boolean(config.alibabaAppKey && config.alibabaAppSecret && tokenState.refreshToken);
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(text)) return true;
  if (["false", "0", "no", "n"].includes(text)) return false;
  return fallback;
}

function isTokenExpiringSoon(expiresAt) {
  if (!expiresAt) return false;
  return Date.now() + TOKEN_REFRESH_SAFETY_MS >= expiresAt;
}

function isAlibabaTokenError(error) {
  const details = error?.details || {};
  const haystack = [
    error?.code,
    error?.message,
    details.code,
    details.message,
    details.msg,
    details.error_msg
  ].filter(Boolean).join(" ").toLowerCase();

  return haystack.includes("token")
    || haystack.includes("session")
    || haystack.includes("expired")
    || haystack.includes("invalid authorization")
    || haystack.includes("access_token");
}

function parseDateMs(value) {
  if (!value) return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toIsoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function assertAuthorized(req) {
  if (!config.sharedSecret) return;
  const authorization = req.headers.authorization || "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  const apiKey = req.headers["x-api-key"] || "";
  if (bearer === config.sharedSecret || apiKey === config.sharedSecret) return;

  const error = new Error("Unauthorized");
  error.statusCode = 401;
  error.code = "UNAUTHORIZED";
  throw error;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(Object.assign(new Error("Request body is too large."), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(Object.assign(new Error("Invalid JSON body."), { statusCode: 400 }));
      }
    });
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  if (statusCode === 204) return res.end();
  res.end(JSON.stringify(payload, null, 2));
}

function sendOAuthCallback(res, url) {
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const error = url.searchParams.get("error") || "";
  const errorDescription = url.searchParams.get("error_description") || "";

  const content = error
    ? `<h1>Alibaba authorization failed</h1><p>${escapeHtml(error)}</p><p>${escapeHtml(errorDescription)}</p>`
    : `<h1>Alibaba authorization received</h1>
       <p>Copy this authorization code and exchange it for an access token in your backend setup flow.</p>
       <pre>${escapeHtml(code || "No code parameter was returned.")}</pre>
       ${state ? `<p>State: ${escapeHtml(state)}</p>` : ""}`;

  res.writeHead(error ? 400 : 200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Alibaba OAuth Callback</title></head><body>${content}</body></html>`);
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,x-api-key,mcp-session-id,mcp-protocol-version");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

function setMcpHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  res.setHeader("MCP-Protocol-Version", MCP_PROTOCOL_VERSION);
}

function getExternalBaseUrl(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL;

  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  if (!host) return config.baseUrl;

  return `${proto}://${host}`;
}

function removeUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ""));
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

module.exports = {
  server,
  startServer,
  handleMcpMessage,
  getMcpTools,
  callMcpTool,
  buildOpenApiSpec
};

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
