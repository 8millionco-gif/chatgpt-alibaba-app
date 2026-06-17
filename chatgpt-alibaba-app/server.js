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
  alibabaTopAppKey: process.env.ALIBABA_TOP_APP_KEY || process.env.ALIBABA_APP_KEY || "",
  alibabaTopAppSecret: process.env.ALIBABA_TOP_APP_SECRET || process.env.ALIBABA_APP_SECRET || "",
  alibabaAccessToken: process.env.ALIBABA_ACCESS_TOKEN || "",
  alibabaRefreshToken: process.env.ALIBABA_REFRESH_TOKEN || "",
  alibabaAuthUrl: process.env.ALIBABA_AUTH_URL || "https://openapi-auth.alibaba.com/oauth/authorize",
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
const TOKEN_UNKNOWN_EXPIRY_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const ALIBABA_PRODUCT_LISTING_API = "/alibaba/icbu/product/listing/v2";
const PRODUCT_PUBLISH_CONFIRMATION_PHRASE = "등록 실행";

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
      return sendJson(res, 200, buildAlibabaConnectionStatus(getExternalBaseUrl(req)));
    }

    if (routeKey === "GET /api/alibaba/oauth/authorize-url") {
      return sendJson(res, 200, buildAlibabaAuthorizeUrlResult(getExternalBaseUrl(req), url.searchParams.get("state") || ""));
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

    if (routeKey === "POST /api/products/clone-draft") {
      const input = await readJson(req);
      const result = await draftOptimizedProductClone(input);
      return sendJson(res, 200, result);
    }

    if (routeKey === "POST /api/products/listing/prepare") {
      const input = await readJson(req);
      const result = await prepareProductListingPayload(input);
      return sendJson(res, 200, result);
    }

    if (routeKey === "POST /api/products/listing/publish") {
      const input = await readJson(req);
      const result = await publishProductListing(input);
      return sendJson(res, 200, result);
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
    sendJson(res, status, formatErrorPayload(error, req));
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
    const structuredError = formatErrorPayload(error, req);
    const nextStep = structuredError.next_step_ko ? `\n\n다음 조치: ${structuredError.next_step_ko}` : "";
    return jsonRpcResult(id, {
      isError: true,
      content: [
        {
          type: "text",
          text: `요청 처리 중 오류가 발생했습니다: ${structuredError.error}${nextStep}`
        }
      ],
      structuredContent: structuredError
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
      name: "refresh_alibaba_access_token",
      title: "Refresh Alibaba access token",
      description: "Manually refresh the Alibaba access token using the configured refresh token. This updates server memory and returns expiry status without exposing raw token values.",
      inputSchema: {
        type: "object",
        properties: {
          force: {
            type: "boolean",
            description: "When true, refresh even if the current token is not known to be expiring. Defaults to true."
          }
        }
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
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
      name: "draft_optimized_product_clone",
      title: "Draft optimized product clone",
      description: "Fetch or accept an existing Alibaba product, then create a safe optimized draft for a new listing with duplicate-listing risk checks. This tool does not publish or update products.",
      inputSchema: {
        type: "object",
        properties: {
          product_id: {
            type: "string",
            description: "Existing Alibaba product id to copy as the source product."
          },
          id: {
            type: "string",
            description: "Alias for product_id."
          },
          source_product: {
            type: "object",
            description: "Optional product object already fetched from Alibaba. When provided, the server does not call product/get."
          },
          target_market: {
            type: "string",
            description: "Target buyer market or region, for example USA, EU, GCC, Southeast Asia, or global."
          },
          positioning: {
            type: "string",
            description: "How the new listing should be different, for example OEM/ODM, private label, retail-ready set, sensitive skin, or vegan."
          },
          differentiation_points: {
            type: "array",
            items: { type: "string" },
            description: "Concrete differences from the source product. Required before publishing a new listing safely."
          },
          buyer_keywords: {
            type: "array",
            items: { type: "string" },
            description: "SEO or buyer-intent keywords to emphasize."
          },
          language: {
            type: "string",
            description: "Draft language. Defaults to English."
          },
          include_raw: {
            type: "boolean",
            description: "Include the raw fetched product response for debugging. Defaults to false."
          }
        }
      },
      annotations: {
        readOnlyHint: true
      }
    },
    {
      name: "prepare_product_listing_payload",
      title: "Prepare product listing payload",
      description: "Convert a reviewed product clone draft into a publish-ready payload preview for Alibaba product listing. This tool does not call Alibaba publish APIs.",
      inputSchema: {
        type: "object",
        properties: {
          clone_draft: {
            type: "object",
            description: "clone_draft returned by draft_optimized_product_clone."
          },
          source_product: {
            type: "object",
            description: "Source product returned by draft_optimized_product_clone."
          },
          listing_payload: {
            type: "object",
            description: "Optional exact Alibaba API payload if already mapped manually."
          },
          final_fields: {
            type: "object",
            description: "Human-reviewed final listing fields such as title, category_id, images, price, moq, shipping_template_id, attributes, details."
          },
          notes: {
            type: "string",
            description: "Review notes or constraints to include in the preparation result."
          }
        }
      },
      annotations: {
        readOnlyHint: true
      }
    },
    {
      name: "publish_product_listing",
      title: "Publish product listing",
      description: "Actually call Alibaba product listing API after explicit user confirmation. Requires confirmation_phrase exactly '등록 실행' and execute=true.",
      inputSchema: {
        type: "object",
        required: ["listing_payload", "confirmation_phrase", "execute"],
        properties: {
          listing_payload: {
            type: "object",
            description: "Final Alibaba listing API payload. This must already be reviewed and schema-mapped."
          },
          confirmation_phrase: {
            type: "string",
            description: "Must be exactly '등록 실행'."
          },
          execute: {
            type: "boolean",
            description: "Must be true to call Alibaba."
          },
          idempotency_key: {
            type: "string",
            description: "Optional user-provided key for audit/reference."
          },
          dry_run: {
            type: "boolean",
            description: "When true, returns the payload without calling Alibaba. Defaults to false only when execute=true and confirmation_phrase is valid."
          }
        }
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
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
      return mcpToolResult(buildAlibabaConnectionStatus(config.baseUrl), "Alibaba 연결 상태를 확인했습니다.");

    case "refresh_alibaba_access_token":
      return mcpToolResult(await refreshAlibabaAccessToken({ force: args.force !== false }), "Alibaba access token을 수동 갱신했습니다.");

    case "search_alibaba_products":
      return mcpToolResult(await searchProducts(args), "Alibaba 상품 검색 결과입니다.");

    case "summarize_buyer_conversation":
      return mcpToolResult(await summarizeBuyer(args), "바이어 대화 요약입니다.");

    case "list_alibaba_im_conversations":
      return mcpToolResult(await listImConversations(args), "Alibaba IM 대화 목록입니다.");

    case "fetch_alibaba_conversation_history":
      return mcpToolResult(await fetchConversationHistory(args), "Alibaba IM 대화 히스토리입니다.");

    case "draft_optimized_product_clone":
      return mcpToolResult(await draftOptimizedProductClone(args), "기존 상품 복사 기반 신규 등록 초안입니다.");

    case "prepare_product_listing_payload":
      return mcpToolResult(await prepareProductListingPayload(args), "Alibaba 신규 상품 등록 전 검토용 payload입니다.");

    case "publish_product_listing":
      return mcpToolResult(await publishProductListing(args), "Alibaba 신규 상품 등록 실행 결과입니다.");

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
  if (value.clone_draft) {
    return formatProductCloneDraftText(value);
  }
  if (value.listing_preparation) {
    return formatListingPreparationText(value);
  }
  if (value.publish_result) {
    return formatProductPublishResultText(value);
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

async function getProductDetail(input = {}) {
  const provided = input.source_product || input.sourceProduct || input.product;
  if (provided && typeof provided === "object") {
    return {
      ok: true,
      source: "provided",
      product: normalizeProductDetail(provided),
      raw: provided
    };
  }

  const productId = String(input.product_id || input.productId || input.id || "").trim();
  if (!productId) {
    const error = new Error("product_id or source_product is required.");
    error.statusCode = 400;
    error.code = "PRODUCT_SOURCE_REQUIRED";
    throw error;
  }

  if (!isAlibabaConfigured()) {
    return {
      ok: true,
      source: "not_configured",
      product: normalizeProductDetail({ id: productId, product_id: productId }),
      note: "Alibaba credentials are not configured, so only a minimal draft can be created."
    };
  }

  let response;
  try {
    response = await callAlibabaRestWithAccessToken("/alibaba/icbu/product/get/v2", {
      product_id: productId
    });
  } catch (error) {
    response = await callAlibabaRestWithAccessToken("/alibaba/icbu/product/get/v2", {
      id: productId
    });
  }
  const product = normalizeProductDetail(extractProductDetail(response) || { id: productId, product_id: productId });

  return {
    ok: true,
    source: "/alibaba/icbu/product/get/v2",
    product,
    raw: response
  };
}

async function draftOptimizedProductClone(input = {}) {
  const detail = await getProductDetail(input);
  const sourceProduct = detail.product || {};
  const context = {
    target_market: input.target_market || input.targetMarket || "global",
    positioning: input.positioning || input.new_positioning || input.newPositioning || "",
    differentiation_points: normalizeStringList(input.differentiation_points || input.differentiationPoints),
    buyer_keywords: normalizeStringList(input.buyer_keywords || input.buyerKeywords || input.keywords),
    language: input.language || "English"
  };

  let draft;
  let draftSource = "fallback";
  if (config.openaiApiKey && (sourceProduct.title || sourceProduct.subject || sourceProduct.product_id)) {
    try {
      draft = await buildOpenAiProductCloneDraft(sourceProduct, context);
      draftSource = "openai";
    } catch (error) {
      draft = buildFallbackProductCloneDraft(sourceProduct, context);
      draft.openai_error = removeUndefined({
        code: error.code,
        message: error.message
      });
    }
  } else {
    draft = buildFallbackProductCloneDraft(sourceProduct, context);
  }

  return buildProductCloneDraftResult({
    detail,
    sourceProduct,
    context,
    draft,
    draftSource,
    includeRaw: Boolean(input.include_raw || input.includeRaw)
  });
}

async function buildOpenAiProductCloneDraft(sourceProduct, context) {
  const schema = {
    draft_status: "draft_only",
    seo_title_candidates: ["Optimized Alibaba product title"],
    short_description: "Buyer-facing product summary without unsupported claims.",
    detail_sections: [
      { heading: "Why buyers choose it", bullets: ["Specific buyer benefit"] }
    ],
    keywords: ["keyword"],
    attributes_to_review: ["category attributes that must be checked manually"],
    images_to_review: ["image changes needed before publish"],
    duplicate_risk: {
      level: "medium",
      score: 60,
      reasons: ["why this may be similar to the source listing"],
      required_changes_before_publish: ["what must change before creating a new listing"]
    },
    compliance_warnings: ["claims or fields to verify"],
    listing_payload_preview: {
      title: "Selected optimized title",
      category_id: "",
      group_id: "",
      keywords: ["keyword"],
      requires_manual_mapping: true
    }
  };

  return callOpenAiJson([
    {
      role: "system",
      content: [
        "You optimize Alibaba seller product listings.",
        "Create a draft for a new listing based on an existing source product.",
        "Do not invent prices, MOQ, certifications, medical claims, delivery promises, stock, or unsupported product facts.",
        "Flag duplicate-listing risk clearly. The output must be draft-only and must not imply the product was published."
      ].join(" ")
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "Create an optimized new-listing draft from the source product.",
        source_product: sourceProduct,
        target_market: context.target_market,
        positioning: context.positioning,
        differentiation_points: context.differentiation_points,
        buyer_keywords: context.buyer_keywords,
        language: context.language
      }, null, 2)
    }
  ], schema);
}

async function prepareProductListingPayload(input = {}) {
  const sourceProduct = input.source_product || input.sourceProduct || input.source_product_snapshot || {};
  const cloneDraft = input.clone_draft || input.cloneDraft || input.draft?.clone_draft || {};
  const finalFields = normalizeFinalListingFields(input.final_fields || input.finalFields || {});
  const providedPayload = input.listing_payload || input.listingPayload || input.api_payload || input.apiPayload;
  const listingPayload = providedPayload && typeof providedPayload === "object"
    ? normalizeAlibabaListingPayload(providedPayload)
    : buildAlibabaListingPayloadCandidate(cloneDraft, sourceProduct, finalFields);
  const readiness = validateListingPayloadReadiness(listingPayload, cloneDraft, finalFields);

  return removeUndefined({
    ok: true,
    listing_preparation: {
      api_path: ALIBABA_PRODUCT_LISTING_API,
      api_not_called: true,
      ready_to_publish: readiness.ready,
      missing_fields: readiness.missing,
      warnings: readiness.warnings,
      duplicate_risk: cloneDraft.duplicate_risk,
      listing_payload: listingPayload,
      publish_requires: {
        execute: true,
        confirmation_phrase: PRODUCT_PUBLISH_CONFIRMATION_PHRASE,
        endpoint: "/api/products/listing/publish",
        mcp_tool: "publish_product_listing"
      },
      human_review_checklist: buildListingHumanReviewChecklist(readiness)
    },
    source_product: sourceProduct,
    note: "등록 전 검토용입니다. Alibaba 신규 등록 API는 호출하지 않았습니다.",
    next_actions: readiness.ready
      ? [`최종 확인 후 '${PRODUCT_PUBLISH_CONFIRMATION_PHRASE}' 문구와 execute=true로 실제 등록을 실행할 수 있습니다.`]
      : ["missing_fields를 보완한 뒤 다시 prepare_product_listing_payload를 실행하세요."]
  });
}

async function publishProductListing(input = {}) {
  const listingPayload = input.listing_payload || input.listingPayload || input.api_payload || input.apiPayload;
  const confirmationPhrase = String(input.confirmation_phrase || input.confirmationPhrase || "").trim();
  const execute = input.execute === true;
  const dryRun = input.dry_run === true || input.dryRun === true;

  if (!listingPayload || typeof listingPayload !== "object" || Array.isArray(listingPayload)) {
    const error = new Error("Final listing_payload object is required.");
    error.statusCode = 400;
    error.code = "LISTING_PAYLOAD_REQUIRED";
    throw error;
  }

  const normalizedPayload = stripInternalListingPayload(listingPayload);
  const readiness = validateListingPayloadReadiness(normalizedPayload, {}, {});

  if (!execute || confirmationPhrase !== PRODUCT_PUBLISH_CONFIRMATION_PHRASE) {
    return {
      ok: false,
      publish_result: {
        executed: false,
        api_not_called: true,
        reason: "Explicit confirmation is required before creating an Alibaba product.",
        required_execute: true,
        required_confirmation_phrase: PRODUCT_PUBLISH_CONFIRMATION_PHRASE,
        received_confirmation_phrase: confirmationPhrase || "",
        readiness
      },
      listing_payload: normalizedPayload
    };
  }

  if (dryRun) {
    return {
      ok: true,
      publish_result: {
        executed: false,
        api_not_called: true,
        dry_run: true,
        api_path: ALIBABA_PRODUCT_LISTING_API,
        readiness
      },
      listing_payload: normalizedPayload
    };
  }

  const response = await callAlibabaRestWithAccessToken(ALIBABA_PRODUCT_LISTING_API, normalizedPayload, {
    method: "POST"
  });

  return {
    ok: true,
    publish_result: {
      executed: true,
      api_path: ALIBABA_PRODUCT_LISTING_API,
      idempotency_key: input.idempotency_key || input.idempotencyKey || "",
      product_id: findDeepValue(response, "product_id") || findDeepValue(response, "productId") || findDeepValue(response, "id") || "",
      task_id: findDeepValue(response, "task_id") || findDeepValue(response, "taskId") || "",
      status: findDeepValue(response, "status") || findDeepValue(response, "code") || "submitted",
      readiness,
      raw: response
    },
    next_actions: [
      "Alibaba 콘솔 또는 상품 상태 조회 API에서 등록 상태를 확인하세요.",
      "필요하면 /alibaba/icbu/product/status/get/v2 또는 /alibaba/icbu/product/get/v2로 결과를 재확인하세요."
    ]
  };
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

function buildAlibabaConnectionStatus(baseUrl = config.baseUrl) {
  return {
    configured: isAlibabaConfigured(),
    hasAppKey: Boolean(config.alibabaAppKey),
    hasAppSecret: Boolean(config.alibabaAppSecret),
    hasTopAppKey: Boolean(config.alibabaTopAppKey),
    hasTopAppSecret: Boolean(config.alibabaTopAppSecret),
    topAppKeyUsesRestAppKey: config.alibabaTopAppKey === config.alibabaAppKey,
    hasAccessToken: Boolean(tokenState.accessToken),
    hasRefreshToken: Boolean(tokenState.refreshToken),
    accessTokenFingerprint: tokenFingerprint(tokenState.accessToken),
    refreshTokenFingerprint: tokenFingerprint(tokenState.refreshToken),
    accessTokenExpiresAt: toIsoOrNull(tokenState.accessTokenExpiresAt),
    refreshTokenExpiresAt: toIsoOrNull(tokenState.refreshTokenExpiresAt),
    lastRefreshAt: toIsoOrNull(tokenState.lastRefreshAt),
    canAutoRefresh: canRefreshAlibabaToken(),
    hasSelfAccountId: Boolean(config.alibabaSelfAccountId),
    gateway: config.alibabaGateway,
    restGateway: config.alibabaRestGateway,
    openaiConfigured: Boolean(config.openaiApiKey),
    tokenHealth: buildAlibabaTokenHealth(baseUrl)
  };
}

function buildAlibabaTokenHealth(baseUrl = config.baseUrl) {
  const hasAccessToken = Boolean(tokenState.accessToken);
  const hasRefreshToken = Boolean(tokenState.refreshToken);
  const accessExpired = Boolean(tokenState.accessTokenExpiresAt && Date.now() >= tokenState.accessTokenExpiresAt);
  const refreshExpired = Boolean(tokenState.refreshTokenExpiresAt && Date.now() >= tokenState.refreshTokenExpiresAt);

  if (!hasAccessToken && !hasRefreshToken) {
    return {
      status: "missing_tokens",
      can_auto_refresh: false,
      reauthorization_required: true,
      authorize_url: buildAlibabaAuthorizeUrl(baseUrl),
      next_step_ko: "Alibaba OAuth 재인증으로 새 access_token과 refresh_token을 발급받아 Render 환경변수에 저장하세요."
    };
  }

  if (refreshExpired) {
    return {
      status: "refresh_token_expired",
      can_auto_refresh: false,
      reauthorization_required: true,
      authorize_url: buildAlibabaAuthorizeUrl(baseUrl),
      next_step_ko: "Refresh token이 만료되었습니다. Alibaba OAuth 재인증이 필요합니다."
    };
  }

  if (accessExpired && hasRefreshToken) {
    return {
      status: "access_token_expired_refresh_available",
      can_auto_refresh: true,
      reauthorization_required: false,
      next_step_ko: "Access token은 만료되었지만 refresh token으로 자동 갱신을 시도할 수 있습니다."
    };
  }

  if (hasAccessToken && !tokenState.accessTokenExpiresAt) {
    return {
      status: "access_token_expiry_unknown",
      can_auto_refresh: canRefreshAlibabaToken(),
      reauthorization_required: false,
      next_step_ko: "Access token 만료 시각이 저장되어 있지 않습니다. IllegalAccessToken이 발생하면 자동 갱신 또는 재인증이 필요합니다."
    };
  }

  return {
    status: "ready",
    can_auto_refresh: canRefreshAlibabaToken(),
    reauthorization_required: false,
    next_step_ko: "현재 설정으로 Alibaba API 호출을 시도할 수 있습니다."
  };
}

function buildAlibabaAuthorizeUrlResult(baseUrl = config.baseUrl, state = "") {
  return {
    ok: true,
    authorize_url: buildAlibabaAuthorizeUrl(baseUrl, state),
    callback_url: buildAlibabaCallbackUrl(baseUrl),
    next_step_ko: "authorize_url을 브라우저에서 열어 Alibaba 로그인/승인을 완료한 뒤 callback에 표시되는 code를 /api/alibaba/oauth/token에 전달하세요."
  };
}

function buildAlibabaAuthorizeUrl(baseUrl = config.baseUrl, state = "") {
  const url = new URL(config.alibabaAuthUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.alibabaAppKey || "");
  url.searchParams.set("redirect_uri", buildAlibabaCallbackUrl(baseUrl));
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

function buildAlibabaCallbackUrl(baseUrl = config.baseUrl) {
  return `${String(baseUrl || config.baseUrl).replace(/\/+$/, "")}/api/alibaba/oauth/callback`;
}

async function refreshAlibabaAccessToken(options = {}) {
  const refreshToken = options.refreshToken || tokenState.refreshToken;
  if (!refreshToken) {
    const error = new Error("Alibaba refresh token is not configured.");
    error.statusCode = 503;
    error.code = "ALIBABA_REFRESH_TOKEN_MISSING";
    throw error;
  }

  if (!options.force && tokenState.accessToken && tokenState.accessTokenExpiresAt && !isTokenExpiringSoon(tokenState.accessTokenExpiresAt)) {
    return safeAlibabaTokenStatus(false);
  }

  const response = await callAlibabaRest("/auth/token/refresh", {
    refresh_token: refreshToken
  });

  const update = updateAlibabaTokenState(response, refreshToken);
  if (!update.accessTokenUpdated) {
    const error = new Error("Alibaba refresh succeeded but no access token was returned.");
    error.statusCode = 502;
    error.code = "ALIBABA_REFRESH_TOKEN_RESPONSE_MISSING_ACCESS_TOKEN";
    error.details = removeUndefined({
      response_code: findDeepValue(response, "code"),
      response_message: findDeepValue(response, "message") || findDeepValue(response, "msg"),
      has_refresh_token: Boolean(refreshToken)
    });
    throw error;
  }

  return safeAlibabaTokenStatus(true, update);
}

async function getAlibabaAccessToken() {
  if (tokenState.accessToken && !shouldRefreshAlibabaAccessTokenBeforeUse()) {
    return tokenState.accessToken;
  }

  if (tokenState.refreshToken) {
    await refreshAlibabaAccessToken({ force: true });
  }

  return tokenState.accessToken;
}

function shouldRefreshAlibabaAccessTokenBeforeUse() {
  if (!tokenState.accessToken) return true;
  if (isTokenExpiringSoon(tokenState.accessTokenExpiresAt)) return true;
  if (!tokenState.accessTokenExpiresAt) {
    return !tokenState.lastRefreshAt || Date.now() - tokenState.lastRefreshAt > TOKEN_UNKNOWN_EXPIRY_REFRESH_INTERVAL_MS;
  }
  return false;
}

async function callAlibabaRestWithAccessToken(apiPath, params = {}, options = {}) {
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
    }, options);
  } catch (error) {
    if (!isAlibabaTokenError(error)) {
      throw error;
    }

    if (!canRefreshAlibabaToken()) {
      throw createAlibabaReauthorizationError(error);
    }

    try {
      await refreshAlibabaAccessToken({ force: true });
    } catch (refreshError) {
      throw createAlibabaReauthorizationError(error, refreshError);
    }

    try {
      return await callAlibabaRest(apiPath, {
        ...params,
        access_token: tokenState.accessToken
      }, options);
    } catch (retryError) {
      if (isAlibabaTokenError(retryError)) {
        throw createAlibabaReauthorizationError(retryError);
      }
      throw retryError;
    }
  }
}

function createAlibabaReauthorizationError(originalError, refreshError) {
  const error = new Error("Alibaba token is invalid or expired. Reauthorization is required.");
  error.statusCode = 401;
  error.code = "ALIBABA_REAUTH_REQUIRED";
  error.details = removeUndefined({
    original_code: originalError?.code,
    original_message: originalError?.message,
    refresh_code: refreshError?.code,
    refresh_message: refreshError?.message,
    access_token_fingerprint: tokenFingerprint(tokenState.accessToken),
    last_refresh_at: toIsoOrNull(tokenState.lastRefreshAt)
  });
  return error;
}

function updateAlibabaTokenState(response, fallbackRefreshToken = tokenState.refreshToken) {
  const previousAccessTokenFingerprint = tokenFingerprint(tokenState.accessToken);
  const previousRefreshTokenFingerprint = tokenFingerprint(tokenState.refreshToken);
  const token = findDeepValueAny(response, ["access_token", "accessToken"]);
  const refreshToken = findDeepValueAny(response, ["refresh_token", "refreshToken"]) || fallbackRefreshToken;
  const expiresIn = Number(findDeepValueAny(response, ["expires_in", "expiresIn", "access_token_expires_in", "accessTokenExpiresIn"]) || 0);
  const refreshExpiresIn = Number(findDeepValueAny(response, ["refresh_expires_in", "refreshExpiresIn", "refresh_token_expires_in", "refreshTokenExpiresIn"]) || 0);

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

  return {
    accessTokenUpdated: Boolean(token),
    refreshTokenUpdated: Boolean(refreshToken),
    accessTokenChanged: previousAccessTokenFingerprint !== tokenFingerprint(tokenState.accessToken),
    refreshTokenChanged: previousRefreshTokenFingerprint !== tokenFingerprint(tokenState.refreshToken),
    expiresIn: expiresIn || undefined,
    refreshExpiresIn: refreshExpiresIn || undefined,
    accessTokenFingerprint: tokenFingerprint(tokenState.accessToken),
    refreshTokenFingerprint: tokenFingerprint(tokenState.refreshToken)
  };
}

function safeAlibabaTokenStatus(refreshed, update = {}) {
  return {
    ok: true,
    refreshed,
    hasAccessToken: Boolean(tokenState.accessToken),
    hasRefreshToken: Boolean(tokenState.refreshToken),
    accessTokenFingerprint: tokenFingerprint(tokenState.accessToken),
    refreshTokenFingerprint: tokenFingerprint(tokenState.refreshToken),
    accessTokenExpiresAt: toIsoOrNull(tokenState.accessTokenExpiresAt),
    refreshTokenExpiresAt: toIsoOrNull(tokenState.refreshTokenExpiresAt),
    lastRefreshAt: toIsoOrNull(tokenState.lastRefreshAt),
    tokenUpdate: removeUndefined({
      accessTokenUpdated: update.accessTokenUpdated,
      accessTokenChanged: update.accessTokenChanged,
      refreshTokenUpdated: update.refreshTokenUpdated,
      refreshTokenChanged: update.refreshTokenChanged,
      expiresIn: update.expiresIn,
      refreshExpiresIn: update.refreshExpiresIn
    }),
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
  if (!config.alibabaTopAppKey || !config.alibabaTopAppSecret) {
    const error = new Error("Alibaba TOP app key/secret are not configured.");
    error.statusCode = 503;
    error.code = "ALIBABA_TOP_NOT_CONFIGURED";
    throw error;
  }

  const sessionToken = options.includeSession === false ? undefined : await getAlibabaAccessToken();
  const signMethod = options.signMethod || config.alibabaTopSignMethod || "md5";
  const allParams = removeUndefined({
    method,
    app_key: config.alibabaTopAppKey,
    sign_method: signMethod,
    timestamp: formatGmt8(new Date()),
    format: "json",
    v: "2.0",
    simplify: "true",
    session: sessionToken || undefined,
    ...params
  });

  allParams.sign = signTopParams(allParams, config.alibabaTopAppSecret, signMethod);

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
    error.details = apiError || body;
    enrichAlibabaTopError(error);
    throw error;
  }

  return body;
}

async function callAlibabaRest(apiPath, params = {}, options = {}) {
  if (!config.alibabaAppKey || !config.alibabaAppSecret) {
    const error = new Error("Alibaba app key/secret are not configured.");
    error.statusCode = 503;
    error.code = "ALIBABA_NOT_CONFIGURED";
    throw error;
  }

  const cleanPath = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  const allParams = serializeAlibabaRestParams(removeUndefined({
    ...params,
    app_key: config.alibabaAppKey,
    sign_method: "sha256",
    timestamp: String(Date.now())
  }));

  allParams.sign = signIopParams(cleanPath, allParams, config.alibabaAppSecret);
  const requestBody = new URLSearchParams(allParams).toString();
  const method = String(options.method || (requestBody.length > 1800 ? "POST" : "GET")).toUpperCase();
  const url = method === "GET"
    ? `${config.alibabaRestGateway}${cleanPath}?${requestBody}`
    : `${config.alibabaRestGateway}${cleanPath}`;

  const response = await fetch(url, removeUndefined({
    method,
    headers: removeUndefined({
      "Accept": "application/json",
      "Content-Type": method === "POST" ? "application/x-www-form-urlencoded;charset=UTF-8" : undefined
    }),
    body: method === "POST" ? requestBody : undefined
  }));

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

function serializeAlibabaRestParams(params = {}) {
  return Object.fromEntries(Object.entries(params).map(([key, value]) => {
    if (value && typeof value === "object") {
      return [key, JSON.stringify(value)];
    }
    return [key, String(value)];
  }));
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
      description: "ChatGPT Actions API for Alibaba buyer summaries, product recommendations, product search, safe product clone drafts, and order briefs."
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
      "/api/alibaba/oauth/authorize-url": {
        get: {
          operationId: "getAlibabaAuthorizationUrl",
          summary: "Get an Alibaba OAuth authorization URL for reauthorization",
          responses: {
            "200": { description: "Alibaba OAuth authorization URL and callback URL" }
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
      "/api/products/clone-draft": {
        post: {
          operationId: "draftOptimizedAlibabaProductClone",
          summary: "Create a safe optimized draft for a new Alibaba listing based on an existing product",
          description: "Draft-only. This endpoint does not create, update, or publish an Alibaba product.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    product_id: {
                      type: "string",
                      description: "Existing Alibaba product id to use as the source product."
                    },
                    source_product: {
                      type: "object",
                      description: "Optional product object already fetched from Alibaba."
                    },
                    target_market: { type: "string" },
                    positioning: { type: "string" },
                    differentiation_points: {
                      type: "array",
                      items: { type: "string" }
                    },
                    buyer_keywords: {
                      type: "array",
                      items: { type: "string" }
                    },
                    language: { type: "string" },
                    include_raw: { type: "boolean" }
                  }
                }
              }
            }
          },
          responses: {
            "200": { description: "Draft-only optimized product clone plan with duplicate risk checks" }
          }
        }
      },
      "/api/products/listing/prepare": {
        post: {
          operationId: "prepareAlibabaProductListingPayload",
          summary: "Prepare a reviewed Alibaba product listing payload without publishing",
          description: "Review step only. This endpoint does not call Alibaba product create/update APIs.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    clone_draft: { type: "object" },
                    source_product: { type: "object" },
                    listing_payload: { type: "object" },
                    final_fields: {
                      type: "object",
                      properties: {
                        title: { type: "string" },
                        category_id: { type: "string" },
                        images: { type: "array", items: { type: "string" } },
                        detail_html: { type: "string" },
                        attributes: { type: "object" },
                        price: { type: "string" },
                        moq: { type: "string" },
                        shipping_template_id: { type: "string" }
                      }
                    }
                  }
                }
              }
            }
          },
          responses: {
            "200": { description: "Prepared listing payload and missing-field review" }
          }
        }
      },
      "/api/products/listing/publish": {
        post: {
          operationId: "publishAlibabaProductListing",
          summary: "Publish a reviewed Alibaba product listing after explicit confirmation",
          description: "Calls /alibaba/icbu/product/listing/v2 only when execute=true and confirmation_phrase is exactly '등록 실행'.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["listing_payload", "confirmation_phrase", "execute"],
                  properties: {
                    listing_payload: { type: "object" },
                    confirmation_phrase: { type: "string" },
                    execute: { type: "boolean" },
                    dry_run: { type: "boolean" },
                    idempotency_key: { type: "string" }
                  }
                }
              }
            }
          },
          responses: {
            "200": { description: "Alibaba listing publish result or confirmation-required refusal" }
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

function normalizeProductDetail(product = {}) {
  const source = Array.isArray(product) ? product[0] || {} : product || {};
  const images = normalizeImageList(source);
  const id = String(source.id || source.product_id || source.productId || source.productID || "");
  const productId = String(source.product_id || source.productId || source.productID || source.id || "");

  return removeUndefined({
    id,
    product_id: productId,
    title: source.subject || source.title || source.name || source.product_name || source.productName || "",
    subject: source.subject || source.title || source.name || source.product_name || source.productName || "",
    keywords: normalizeStringList(source.keywords || source.keyword || source.product_keywords || source.productKeywords),
    image: images[0] || "",
    images,
    url: source.pc_detail_url || source.pcDetailUrl || source.detail_url || source.detailUrl || source.url || "",
    status: source.status || source.product_status || source.productStatus || "",
    display: source.display || source.display_status || source.displayStatus || "",
    language: source.language || "",
    category_id: source.category_id || source.categoryId || source.categoryID || "",
    group_id: source.group_id || source.groupId || source.groupID || "",
    group_name: source.group_name || source.groupName || "",
    owner_member: source.owner_member || source.ownerMember || "",
    owner_member_display_name: source.owner_member_display_name || source.ownerMemberDisplayName || "",
    gmt_create: source.gmt_create || source.gmtCreate || "",
    gmt_modified: source.gmt_modified || source.gmtModified || "",
    product_type: source.product_type || source.productType || "",
    specific: source.specific,
    attributes: source.attributes || source.product_attributes || source.productAttributes,
    sku: source.sku || source.skus,
    rts: source.rts
  });
}

function extractProductDetail(response = {}) {
  const detailKeys = [
    "product",
    "product_info",
    "productInfo",
    "product_d_t_o",
    "productDTO",
    "product_detail",
    "productDetail"
  ];

  for (const key of detailKeys) {
    const value = findDeepValue(response, key);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  }

  const products = findDeepArrayForKeys(response, ["products", "product_list", "productList", "product_infos"]);
  if (products.length) return products[0];

  const result = findDeepValue(response, "result");
  if (result && typeof result === "object" && !Array.isArray(result)) return result;

  return response;
}

function buildProductCloneDraftResult(input = {}) {
  const sourceProduct = input.sourceProduct || {};
  const context = input.context || {};
  const sourceDraft = input.draft && typeof input.draft === "object"
    ? input.draft
    : buildFallbackProductCloneDraft(sourceProduct, context);
  const duplicateRisk = buildDuplicateRiskReport(sourceProduct, context, sourceDraft.duplicate_risk);
  const seoTitleCandidates = ensureArray(sourceDraft.seo_title_candidates).length
    ? ensureArray(sourceDraft.seo_title_candidates).map((title) => truncateText(title, 120))
    : generateCloneTitleCandidates(sourceProduct, context);
  const keywords = ensureUnique([
    ...ensureArray(sourceDraft.keywords),
    ...deriveCloneKeywords(sourceProduct, context)
  ]).slice(0, 20);
  const detailSections = ensureArray(sourceDraft.detail_sections).length
    ? ensureArray(sourceDraft.detail_sections).map(normalizeDetailSection).filter(Boolean)
    : buildCloneDetailSections(sourceProduct, context);
  const complianceWarnings = ensureUnique([
    ...ensureArray(sourceDraft.compliance_warnings),
    ...buildProductComplianceWarnings(sourceProduct)
  ]);

  const cloneDraft = removeUndefined({
    draft_status: "draft_only",
    source_product_id: sourceProduct.product_id || sourceProduct.id || "",
    target_market: context.target_market,
    positioning: context.positioning,
    seo_title_candidates: seoTitleCandidates,
    selected_title: seoTitleCandidates[0] || "",
    short_description: sourceDraft.short_description || buildFallbackShortDescription(sourceProduct, context),
    keywords,
    detail_sections: detailSections,
    attributes_to_review: ensureUnique([
      ...ensureArray(sourceDraft.attributes_to_review),
      "Alibaba category required attributes",
      "Material, function, volume, package, origin, certification fields",
      "Price, MOQ, sample, customization and shipping template"
    ]),
    images_to_review: ensureUnique([
      ...ensureArray(sourceDraft.images_to_review),
      sourceProduct.images?.length ? "Confirm whether source images can be reused or need new images." : "Add product images before listing."
    ]),
    duplicate_risk: duplicateRisk,
    compliance_warnings: complianceWarnings,
    required_next_inputs: buildCloneRequiredNextInputs(context),
    listing_payload_preview: buildListingPayloadPreview(sourceProduct, context, sourceDraft, seoTitleCandidates, keywords)
  });

  return removeUndefined({
    ok: true,
    source: input.draftSource || "fallback",
    detail_source: input.detail?.source,
    source_product: sourceProduct,
    clone_draft: cloneDraft,
    safety_note_ko: "초안 전용입니다. Alibaba 신규 등록 API는 호출하지 않았고, 실제 등록 전에는 차별화 포인트와 필수 속성을 사람이 확인해야 합니다.",
    next_actions: [
      "차별화 포인트, 가격, MOQ, 패키지 구성, 배송 템플릿을 확정합니다.",
      "중복 위험이 medium 이상이면 이미지, 제목, 구성 또는 타깃 시장을 명확히 바꿉니다.",
      "확정 후에만 /alibaba/icbu/product/listing/v2 등록 API 연결을 검토합니다."
    ],
    note: input.detail?.note,
    openai_error: sourceDraft.openai_error,
    raw_product: input.includeRaw ? input.detail?.raw : undefined
  });
}

function buildFallbackProductCloneDraft(sourceProduct = {}, context = {}) {
  const titleCandidates = generateCloneTitleCandidates(sourceProduct, context);
  const keywords = deriveCloneKeywords(sourceProduct, context);
  return {
    draft_status: "draft_only",
    seo_title_candidates: titleCandidates,
    short_description: buildFallbackShortDescription(sourceProduct, context),
    detail_sections: buildCloneDetailSections(sourceProduct, context),
    keywords,
    attributes_to_review: [
      "Category required attributes",
      "Product function and ingredient claims",
      "Price, MOQ, packaging and shipping template"
    ],
    images_to_review: [
      "Decide whether to reuse source images or upload new differentiated images."
    ],
    duplicate_risk: buildDuplicateRiskReport(sourceProduct, context),
    compliance_warnings: buildProductComplianceWarnings(sourceProduct),
    listing_payload_preview: buildListingPayloadPreview(sourceProduct, context, {}, titleCandidates, keywords)
  };
}

function buildDuplicateRiskReport(sourceProduct = {}, context = {}, upstreamRisk = {}) {
  const diffPoints = normalizeStringList(context.differentiation_points);
  const buyerKeywords = normalizeStringList(context.buyer_keywords);
  const imageCount = Array.isArray(sourceProduct.images) ? sourceProduct.images.length : 0;
  let score = 72;
  if (!diffPoints.length) score += 13;
  if (diffPoints.length >= 1) score -= 12;
  if (diffPoints.length >= 3) score -= 13;
  if (buyerKeywords.length) score -= 5;
  if (imageCount) score += 5;
  if (context.positioning) score -= 4;
  score = clamp(Number(upstreamRisk.score || score), 0, 100);

  const level = upstreamRisk.level || (score >= 70 ? "high" : score >= 40 ? "medium" : "low");
  const reasons = ensureUnique([
    ...ensureArray(upstreamRisk.reasons),
    !diffPoints.length ? "원본 상품과 명확한 차별화 포인트가 아직 입력되지 않았습니다." : "",
    imageCount ? "원본 이미지를 그대로 사용하면 중복 리스팅으로 보일 수 있습니다." : "",
    sourceProduct.category_id ? "원본과 동일한 카테고리를 사용할 가능성이 높습니다." : "",
    sourceProduct.title ? "상품명이 원본과 유사하면 검색 노출과 승인 측면에서 불리할 수 있습니다." : ""
  ].filter(Boolean));

  return {
    level,
    score,
    reasons,
    required_changes_before_publish: ensureUnique([
      ...ensureArray(upstreamRisk.required_changes_before_publish),
      "새 리스팅만의 타깃 바이어, 구성, 용량, 패키지, MOQ 또는 가격 전략을 확정합니다.",
      "원본과 다른 대표 이미지 또는 상세 이미지 구성을 준비합니다.",
      "제목과 키워드를 새 포지셔닝에 맞게 조정합니다.",
      "카테고리 필수 속성과 효능 표현을 실제 상품 근거에 맞게 검토합니다."
    ])
  };
}

function generateCloneTitleCandidates(sourceProduct = {}, context = {}) {
  const baseTitle = truncateText(sourceProduct.title || sourceProduct.subject || "Alibaba Product", 90);
  const keywords = deriveCloneKeywords(sourceProduct, context).slice(0, 4);
  const positioning = truncateText(context.positioning || "", 40);
  const market = context.target_market && context.target_market !== "global" ? `${context.target_market} ` : "";
  const brandOrGroup = sourceProduct.group_name || "";

  return ensureUnique([
    truncateText([market, baseTitle, keywords[0]].filter(Boolean).join(" "), 120),
    truncateText([brandOrGroup, positioning, keywords.slice(0, 3).join(" ")].filter(Boolean).join(" "), 120),
    truncateText([baseTitle, positioning || keywords.slice(0, 2).join(" ")].filter(Boolean).join(" - "), 120)
  ]).filter(Boolean).slice(0, 3);
}

function deriveCloneKeywords(sourceProduct = {}, context = {}) {
  const titleWords = String(sourceProduct.title || sourceProduct.subject || "")
    .split(/[^a-zA-Z0-9가-힣]+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3)
    .slice(0, 12);

  return ensureUnique([
    ...normalizeStringList(context.buyer_keywords),
    ...normalizeStringList(context.differentiation_points),
    ...normalizeStringList(sourceProduct.keywords),
    ...normalizeStringList(context.positioning),
    ...titleWords
  ]).slice(0, 20);
}

function buildFallbackShortDescription(sourceProduct = {}, context = {}) {
  const title = sourceProduct.title || sourceProduct.subject || "This product";
  const positioning = context.positioning ? ` positioned for ${context.positioning}` : "";
  const market = context.target_market && context.target_market !== "global" ? ` in ${context.target_market}` : "";
  return truncateText(`${title}${positioning}${market}. Review final claims, attributes, pricing, MOQ, and images before publishing.`, 260);
}

function buildCloneDetailSections(sourceProduct = {}, context = {}) {
  const diffPoints = normalizeStringList(context.differentiation_points);
  const keywords = deriveCloneKeywords(sourceProduct, context).slice(0, 6);
  return [
    {
      heading: "Buyer positioning",
      bullets: [
        context.target_market ? `Target market: ${context.target_market}` : "Target market: confirm before publishing",
        context.positioning ? `Positioning: ${context.positioning}` : "Positioning: add the new listing angle before publishing"
      ]
    },
    {
      heading: "Optimization focus",
      bullets: [
        keywords.length ? `SEO keywords: ${keywords.join(", ")}` : "Add buyer search keywords",
        diffPoints.length ? `Differentiation: ${diffPoints.join(", ")}` : "Add concrete differences from the source listing"
      ]
    },
    {
      heading: "Source product reference",
      bullets: [
        sourceProduct.product_id || sourceProduct.id ? `Source product ID: ${sourceProduct.product_id || sourceProduct.id}` : "Source product ID: not provided",
        sourceProduct.url ? `Source URL: ${sourceProduct.url}` : "Source URL: not provided"
      ]
    }
  ];
}

function buildProductComplianceWarnings(sourceProduct = {}) {
  const text = `${sourceProduct.title || ""} ${sourceProduct.subject || ""} ${normalizeStringList(sourceProduct.keywords).join(" ")}`.toLowerCase();
  const warnings = [
    "Do not invent certifications, clinical results, prices, MOQ, delivery time, stock, or origin.",
    "Confirm Alibaba category required attributes before creating the new listing.",
    "Use a human approval step before any product create/update API call."
  ];

  if (/whitening|blemish|acne|anti[-\s]?wrinkle|firming|medical|treatment|pigmentation/.test(text)) {
    warnings.push("Cosmetic efficacy claims such as whitening, blemish, acne, anti-wrinkle, firming, or pigmentation should be verified against actual product evidence and local advertising rules.");
  }

  return warnings;
}

function buildCloneRequiredNextInputs(context = {}) {
  const required = [
    "new listing differentiation points",
    "target buyer/market",
    "price and MOQ",
    "package, volume, set composition, and customization options",
    "shipping template and lead time",
    "image reuse/new image decision"
  ];

  if (!normalizeStringList(context.differentiation_points).length) {
    required.unshift("at least 2-3 concrete differences from the source product");
  }

  return ensureUnique(required);
}

function buildListingPayloadPreview(sourceProduct = {}, context = {}, draft = {}, titleCandidates = [], keywords = []) {
  return removeUndefined({
    mode: "preview_only",
    api_not_called: true,
    intended_api: "/alibaba/icbu/product/listing/v2",
    source_product_id: sourceProduct.product_id || sourceProduct.id || "",
    title: draft.selected_title || titleCandidates[0] || "",
    category_id: sourceProduct.category_id || "",
    group_id: sourceProduct.group_id || "",
    group_name: sourceProduct.group_name || "",
    language: context.language || sourceProduct.language || "English",
    keywords: keywords.slice(0, 10),
    images: Array.isArray(sourceProduct.images) ? sourceProduct.images.slice(0, 10) : [],
    product_type: sourceProduct.product_type || "",
    requires_manual_mapping: true,
    required_before_api_call: [
      "Map this preview into Alibaba listing schema.",
      "Fill every required category attribute.",
      "Confirm title, images, price, MOQ, logistics and compliance claims."
    ]
  });
}

function normalizeFinalListingFields(fields = {}) {
  const images = normalizeImageList(fields);
  return removeUndefined({
    title: fields.title || fields.subject || "",
    subject: fields.subject || fields.title || "",
    category_id: fields.category_id || fields.categoryId || "",
    group_id: fields.group_id || fields.groupId || "",
    group_name: fields.group_name || fields.groupName || "",
    language: fields.language || "",
    keywords: normalizeStringList(fields.keywords),
    images,
    detail_html: fields.detail_html || fields.detailHtml || fields.details || fields.description || "",
    attributes: fields.attributes || fields.product_attributes || fields.productAttributes,
    sku: fields.sku || fields.skus,
    price: fields.price || fields.fob_price || fields.fobPrice || "",
    price_range: fields.price_range || fields.priceRange,
    moq: fields.moq || fields.min_order_quantity || fields.minOrderQuantity || "",
    shipping_template_id: fields.shipping_template_id || fields.shippingTemplateId || "",
    package_info: fields.package_info || fields.packageInfo || "",
    lead_time: fields.lead_time || fields.leadTime || "",
    customization: fields.customization || "",
    duplicate_risk_acknowledged: fields.duplicate_risk_acknowledged === true || fields.duplicateRiskAcknowledged === true
  });
}

function normalizeAlibabaListingPayload(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const clean = removeUndefined(Object.fromEntries(Object.entries(payload)
    .filter(([key]) => !String(key).startsWith("_"))
    .map(([key, value]) => [key, value])));
  if (looksLikeStructuredDraftPayload(clean)) {
    return buildListingPayloadFromStructuredDraft(clean);
  }
  return clean;
}

function buildAlibabaListingPayloadCandidate(cloneDraft = {}, sourceProduct = {}, finalFields = {}) {
  const preview = cloneDraft.listing_payload_preview || {};
  const title = finalFields.title || finalFields.subject || cloneDraft.selected_title || preview.title || "";
  const keywords = ensureUnique([
    ...normalizeStringList(finalFields.keywords),
    ...normalizeStringList(cloneDraft.keywords),
    ...normalizeStringList(preview.keywords)
  ]).slice(0, 20);
  const images = ensureUnique([
    ...ensureArray(finalFields.images),
    ...ensureArray(preview.images),
    ...ensureArray(sourceProduct.images)
  ]).filter(Boolean);

  const product = removeUndefined({
    subject: title,
    title,
    category_id: finalFields.category_id || preview.category_id || sourceProduct.category_id || "",
    group_id: finalFields.group_id || preview.group_id || sourceProduct.group_id || "",
    group_name: finalFields.group_name || preview.group_name || sourceProduct.group_name || "",
    language: finalFields.language || preview.language || sourceProduct.language || "English",
    keywords,
    images,
    detail_html: finalFields.detail_html || buildDetailHtmlFromDraft(cloneDraft),
    attributes: finalFields.attributes,
    sku: finalFields.sku,
    price: finalFields.price,
    price_range: finalFields.price_range,
    moq: finalFields.moq,
    shipping_template_id: finalFields.shipping_template_id,
    package_info: finalFields.package_info,
    lead_time: finalFields.lead_time,
    customization: finalFields.customization,
    source_product_id: cloneDraft.source_product_id || sourceProduct.product_id || sourceProduct.id || "",
    duplicate_risk_acknowledged: finalFields.duplicate_risk_acknowledged
  });

  return {
    product,
    _client_note: "Review and map this product object to Alibaba's exact listing/v2 schema before publish if API Explorer requires different parameter names."
  };
}

function looksLikeStructuredDraftPayload(payload = {}) {
  return Boolean(
    payload.basic_info ||
    payload.seo ||
    payload.product_attributes ||
    payload.trade_info ||
    payload.description ||
    payload.images ||
    payload.action === "create_product_draft"
  );
}

function buildListingPayloadFromStructuredDraft(draft = {}) {
  const basic = draft.basic_info || {};
  const seo = draft.seo || {};
  const attributes = draft.product_attributes || {};
  const description = draft.description || {};
  const imagesBlock = draft.images || {};
  const trade = draft.trade_info || {};
  const compliance = draft.compliance || {};
  const sourceImages = ensureArray(imagesBlock.source_images || imagesBlock.images || imagesBlock.urls || draft.source_images);
  const keywords = ensureUnique([
    ...normalizeStringList(seo.main_keywords),
    ...normalizeStringList(seo.keyword_block),
    ...normalizeStringList(draft.keywords)
  ]).slice(0, 30);

  const product = removeUndefined({
    subject: basic.subject || draft.title || "",
    title: basic.subject || draft.title || "",
    category_id: basic.category_id || draft.category_id || "",
    group_id: basic.group_id || draft.group_id || "",
    group_name: basic.group_name || draft.group_name || "",
    language: draft.language || basic.language || "ENGLISH",
    product_type: draft.product_type || draft.productType || "wholesale",
    display: draft.display || "N",
    brand_name: basic.brand_name || draft.brand || draft.brand_name || "",
    origin: basic.origin || draft.origin || "",
    supply_type: basic.supply_type,
    keywords,
    images: sourceImages.map(String).filter(Boolean),
    detail_html: buildDetailHtmlFromStructuredDraft(description, draft.faq, compliance),
    attributes: removeUndefined({
      ...attributes,
      brand_name: basic.brand_name || draft.brand || "",
      origin: basic.origin || "",
      supply_type: basic.supply_type
    }),
    price_range: trade.price_ranges || draft.price_ranges,
    price: trade.price || trade.fob_price || draft.price || "",
    moq: trade.moq || draft.moq || "",
    sample_available: trade.sample_available,
    sample_price: trade.sample_price,
    currency: trade.currency,
    lead_time: trade.lead_time || draft.lead_time || "",
    shipping_method: trade.shipping_method || "",
    shipping_template_id: trade.shipping_template_id || trade.shippingTemplateId || draft.shipping_template_id || "",
    rts: trade.rts,
    source_product_id: draft.source_product_id || "",
    copy_from_product: draft.copy_from_product,
    compliance_notes: compliance,
    required_verification_fields: ensureUnique([
      ...normalizeStringList(draft.missing_required_fields),
      ...normalizeStringList(compliance.requires_verification)
    ])
  });

  return {
    product,
    _source_payload_format: "structured_draft",
    _client_note: "Structured draft payload was converted to a product object. Review exact Alibaba listing/v2 field names in API Explorer before publish."
  };
}

function buildDetailHtmlFromStructuredDraft(description = {}, faq = [], compliance = {}) {
  const blocks = [];
  if (description.short_description) {
    blocks.push(`<p>${escapeHtml(description.short_description)}</p>`);
  }
  if (description.detail_description) {
    for (const paragraph of String(description.detail_description).split(/\n{2,}/).map((item) => item.trim()).filter(Boolean)) {
      blocks.push(`<p>${escapeHtml(paragraph)}</p>`);
    }
  }
  const faqItems = ensureArray(faq).filter((item) => item && typeof item === "object");
  if (faqItems.length) {
    blocks.push("<h3>FAQ</h3>");
    for (const item of faqItems) {
      blocks.push(`<h4>${escapeHtml(item.question || "")}</h4><p>${escapeHtml(item.answer || "")}</p>`);
    }
  }
  const safeClaims = normalizeStringList(compliance.safe_claims);
  if (safeClaims.length) {
    blocks.push(`<h3>Safe Positioning Keywords</h3><ul>${safeClaims.map((claim) => `<li>${escapeHtml(claim)}</li>`).join("")}</ul>`);
  }
  return blocks.join("\n");
}

function stripInternalListingPayload(payload = {}) {
  const clean = normalizeAlibabaListingPayload(payload);
  if (clean.product && typeof clean.product === "object" && !Array.isArray(clean.product)) {
    clean.product = removeUndefined(Object.fromEntries(Object.entries(clean.product)
      .filter(([key]) => !["source_product_id", "duplicate_risk_acknowledged"].includes(key))));
  }
  return clean;
}

function validateListingPayloadReadiness(listingPayload = {}, cloneDraft = {}, finalFields = {}) {
  const product = getListingProductObject(listingPayload);
  const missing = [];
  const warnings = [];
  const duplicateRisk = cloneDraft.duplicate_risk || {};

  if (!hasFinalValue(product.subject || product.title)) missing.push("상품명/title");
  if (!hasFinalValue(product.category_id || product.categoryId)) missing.push("카테고리/category_id");
  if (!hasNonEmptyCollection(product.images) && !product.image && !product.image_urls) missing.push("대표 이미지/images");
  if (!hasFinalValue(product.detail_html || product.description || product.details)) missing.push("상세 설명/detail_html");
  if (!hasFinalObject(product.attributes)) missing.push("카테고리 필수 속성/attributes");
  if (!hasFinalValue(product.price || product.price_range || product.fob_price)) missing.push("가격/price");
  if (!hasFinalValue(product.moq || product.min_order_quantity || product.minOrderQuantity)) missing.push("MOQ");
  if (!hasFinalValue(product.shipping_template_id || product.shippingTemplateId)) missing.push("배송 템플릿/shipping_template_id");
  if (isCosmeticListing(product)) {
    if (!hasFinalValue(product.capacity || product.volume || product.attributes?.capacity || product.attributes?.volume)) {
      missing.push("정확한 용량/capacity");
    }
    if (!hasFinalValue(product.full_inci || product.inci || product.attributes?.full_inci || product.attributes?.inci || product.attributes?.full_inci_list)) {
      missing.push("전체 INCI/full_inci");
    }
    if (!hasFinalValue(product.shelf_life || product.expiration || product.attributes?.shelf_life || product.attributes?.expiration)) {
      missing.push("유통기한/shelf_life");
    }
    if (!hasFinalValue(product.lead_time || product.leadTime)) {
      missing.push("리드타임/lead_time");
    }
  }

  if (duplicateRisk.level === "high" && finalFields.duplicate_risk_acknowledged !== true) {
    warnings.push("중복 위험이 high입니다. 이미지/구성/타깃/제목 차별화 확인이 필요합니다.");
  }
  if (String(product.subject || product.title || "").length > 128) {
    warnings.push("상품명이 길 수 있습니다. Alibaba 제목 제한을 확인하세요.");
  }
  if (product._client_note || listingPayload._client_note) {
    warnings.push("현재 payload는 후보 구조입니다. API Explorer에서 요구하는 정확한 listing/v2 파라미터명으로 매핑해야 할 수 있습니다.");
  }
  if (hasNonEmptyCollection(product.required_verification_fields)) {
    warnings.push(`확인 필요 항목: ${ensureArray(product.required_verification_fields).slice(0, 12).join(", ")}`);
  }

  return {
    ready: missing.length === 0,
    missing,
    warnings,
    required_confirmation_phrase: PRODUCT_PUBLISH_CONFIRMATION_PHRASE
  };
}

function getListingProductObject(listingPayload = {}) {
  if (listingPayload.product && typeof listingPayload.product === "object") return listingPayload.product;
  if (typeof listingPayload.product === "string") {
    const text = listingPayload.product.trim();
    if (text.startsWith("{")) {
      try {
        return JSON.parse(text);
      } catch {
        return listingPayload;
      }
    }
  }
  return listingPayload;
}

function buildListingHumanReviewChecklist(readiness = {}) {
  return [
    "상품명과 키워드가 원본과 충분히 다르게 최적화되었는지 확인",
    "카테고리와 필수 속성이 Alibaba 요구사항에 맞는지 확인",
    "이미지 사용 권한과 중복 이미지 위험 확인",
    "가격, MOQ, 샘플, 패키지, 배송 템플릿 확인",
    "효능/인증/성분/원산지 표현이 실제 근거와 일치하는지 확인",
    readiness.ready ? `모든 항목 확인 후 '${PRODUCT_PUBLISH_CONFIRMATION_PHRASE}'로 등록 승인` : "누락 항목 보완 후 다시 payload 준비"
  ];
}

function buildDetailHtmlFromDraft(cloneDraft = {}) {
  const sections = ensureArray(cloneDraft.detail_sections);
  if (!sections.length && cloneDraft.short_description) {
    return `<p>${escapeHtml(cloneDraft.short_description)}</p>`;
  }
  return sections.map((section) => {
    const heading = escapeHtml(section.heading || "Product Details");
    const bullets = ensureArray(section.bullets)
      .map((item) => `<li>${escapeHtml(item)}</li>`)
      .join("");
    return `<h3>${heading}</h3>${bullets ? `<ul>${bullets}</ul>` : ""}`;
  }).join("\n");
}

function hasNonEmptyCollection(value) {
  if (Array.isArray(value)) return value.filter(Boolean).length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  return false;
}

function hasNonEmptyObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
}

function hasFinalValue(value) {
  if (Array.isArray(value)) return value.some((item) => hasFinalValue(item));
  if (value && typeof value === "object") return hasFinalObject(value);
  const text = String(value || "").trim();
  if (!text) return false;
  return !/(confirm|tbd|todo|pending|placeholder|sample|확인|미정|필요|샘플)/i.test(text);
}

function hasFinalObject(value) {
  if (!hasNonEmptyObject(value)) return false;
  return Object.values(value).some((item) => hasFinalValue(item));
}

function isCosmeticListing(product = {}) {
  const haystack = [
    product.subject,
    product.title,
    product.category_name,
    product.categoryName,
    product.attributes?.product_category,
    product.attributes?.form,
    product.attributes?.function,
    product.keywords
  ].flat(Infinity).join(" ").toLowerCase();
  return /cosmetic|skincare|skin care|cream|serum|ampoule|toner|cleanser|eye|blemish|wrinkle|moistur|brighten|whitening|k[-\s]?beauty|화장품/.test(haystack);
}

function normalizeDetailSection(section) {
  if (!section) return undefined;
  if (typeof section === "string") {
    return { heading: section, bullets: [] };
  }
  return removeUndefined({
    heading: section.heading || section.title || "",
    bullets: ensureArray(section.bullets || section.items).map(String).filter(Boolean)
  });
}

function normalizeImageList(product = {}) {
  const candidates = [
    product?.main_image?.images,
    product?.mainImage?.images,
    product?.product_image?.images,
    product?.productImage?.images,
    product?.images,
    product?.image,
    product?.image_url,
    product?.imageUrl,
    product?.main_image,
    product?.mainImage
  ];
  const images = [];

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        if (typeof item === "string") images.push(item);
        if (item && typeof item === "object") images.push(item.url || item.image_url || item.imageUrl || "");
      }
      continue;
    }
    if (typeof candidate === "string") {
      images.push(...candidate.split(/[,\n]/));
      continue;
    }
    if (typeof candidate === "object") {
      images.push(candidate.url || candidate.image_url || candidate.imageUrl || "");
    }
  }

  return ensureUnique(images.map((image) => String(image || "").trim()).filter(Boolean));
}

function normalizeStringList(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return ensureUnique(value.map((item) => String(item || "").trim()).filter(Boolean));
  }
  if (typeof value === "string") {
    return ensureUnique(value.split(/[,\n;]+/).map((item) => item.trim()).filter(Boolean));
  }
  return [String(value).trim()].filter(Boolean);
}

function ensureArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function ensureUnique(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = typeof value === "string" ? value.trim() : value;
    const key = typeof text === "string" ? text.toLowerCase() : JSON.stringify(text);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function formatProductCloneDraftText(value = {}) {
  const source = value.source_product || {};
  const draft = value.clone_draft || {};
  const risk = draft.duplicate_risk || {};
  const titleLines = ensureArray(draft.seo_title_candidates)
    .slice(0, 5)
    .map((title, index) => `${index + 1}. ${title}`);
  const sections = ensureArray(draft.detail_sections)
    .slice(0, 5)
    .map((section) => {
      const bullets = ensureArray(section.bullets).slice(0, 5).map((item) => `- ${item}`).join("\n");
      return `[${section.heading || "Section"}]\n${bullets}`;
    });

  return [
    "[소스 상품]",
    `- 상품 ID: ${source.product_id || source.id || "확인 필요"}`,
    `- 상품명: ${source.title || source.subject || "확인 필요"}`,
    source.url ? `- URL: ${source.url}` : "",
    "",
    "[신규 등록 최적화 초안]",
    titleLines.join("\n"),
    draft.short_description ? `\n요약: ${draft.short_description}` : "",
    draft.keywords?.length ? `\n키워드: ${draft.keywords.slice(0, 12).join(", ")}` : "",
    "",
    "[상세 구성]",
    sections.join("\n\n"),
    "",
    "[중복 위험]",
    `- 수준: ${risk.level || "unknown"} (${risk.score ?? "n/a"}/100)`,
    ...ensureArray(risk.reasons).slice(0, 5).map((reason) => `- ${reason}`),
    "",
    "[등록 전 확인]",
    ...ensureArray(draft.required_next_inputs).slice(0, 8).map((item) => `- ${item}`),
    "",
    value.safety_note_ko || ""
  ].filter(Boolean).join("\n");
}

function formatListingPreparationText(value = {}) {
  const prep = value.listing_preparation || {};
  const missing = ensureArray(prep.missing_fields);
  const warnings = ensureArray(prep.warnings);
  return [
    "[등록 준비 상태]",
    `- 실제 등록 호출: 하지 않음`,
    `- 등록 가능 상태: ${prep.ready_to_publish ? "가능" : "보완 필요"}`,
    `- API: ${prep.api_path || ALIBABA_PRODUCT_LISTING_API}`,
    "",
    missing.length ? "[부족한 항목]\n" + missing.map((item) => `- ${item}`).join("\n") : "[부족한 항목]\n- 없음",
    warnings.length ? "\n[주의]\n" + warnings.map((item) => `- ${item}`).join("\n") : "",
    "",
    "[실제 등록 조건]",
    `- execute: true`,
    `- confirmation_phrase: ${PRODUCT_PUBLISH_CONFIRMATION_PHRASE}`,
    "",
    "[다음 단계]",
    ...(ensureArray(value.next_actions).length ? ensureArray(value.next_actions).map((item) => `- ${item}`) : ["- 최종 정보를 확인한 뒤 실제 등록 도구를 호출하세요."])
  ].filter(Boolean).join("\n");
}

function formatProductPublishResultText(value = {}) {
  const result = value.publish_result || {};
  if (!result.executed) {
    return [
      "[등록 실행 안 됨]",
      `- 이유: ${result.reason || (result.dry_run ? "dry_run" : "승인 조건 미충족")}`,
      `- 필요한 승인 문구: ${result.required_confirmation_phrase || PRODUCT_PUBLISH_CONFIRMATION_PHRASE}`,
      `- execute: ${result.required_execute === true ? "true 필요" : "확인 필요"}`
    ].join("\n");
  }

  return [
    "[등록 실행 완료]",
    `- API: ${result.api_path || ALIBABA_PRODUCT_LISTING_API}`,
    result.product_id ? `- product_id: ${result.product_id}` : "",
    result.task_id ? `- task_id: ${result.task_id}` : "",
    `- 상태: ${result.status || "submitted"}`,
    "",
    "[다음 확인]",
    ...(ensureArray(value.next_actions).map((item) => `- ${item}`))
  ].filter(Boolean).join("\n");
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

function findDeepValueAny(value, targetKeys = []) {
  for (const key of targetKeys) {
    const result = findDeepValue(value, key);
    if (result !== undefined && result !== null && result !== "") return result;
  }
  return undefined;
}

function tokenFingerprint(token) {
  if (!token) return null;
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex").slice(0, 12);
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
  return Boolean(config.alibabaAppKey && config.alibabaAppSecret && tokenState.refreshToken && !isTimestampExpired(tokenState.refreshTokenExpiresAt));
}

function enrichAlibabaTopError(error) {
  const details = error.details || {};
  const text = [
    error.code,
    error.message,
    details.code,
    details.msg,
    details.sub_code,
    details.sub_msg
  ].filter(Boolean).join(" ").toLowerCase();

  if (text.includes("invalid app key") || text.includes("invalid appkey") || String(error.code) === "29") {
    error.code = "ALIBABA_TOP_INVALID_APP_KEY";
    error.message = [
      "Alibaba TOP gateway rejected the app key.",
      "The configured ALIBABA_APP_KEY works for Alibaba OpenAPI REST, but this IM API is a Taobao TOP API and may require a separate TOP/OKKI&TM app key.",
      "Set ALIBABA_TOP_APP_KEY and ALIBABA_TOP_APP_SECRET after Alibaba grants that app/API permission."
    ].join(" ");
  }
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

function isTimestampExpired(expiresAt) {
  return Boolean(expiresAt && Date.now() >= expiresAt);
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
    || haystack.includes("illegalaccesstoken")
    || haystack.includes("illegal access token")
    || haystack.includes("access_token");
}

function formatErrorPayload(error, req) {
  const baseUrl = req ? getExternalBaseUrl(req) : config.baseUrl;
  const payload = {
    ok: false,
    error: error.message,
    code: error.code || "SERVER_ERROR"
  };

  if (error.code === "ALIBABA_REAUTH_REQUIRED" || isAlibabaTokenError(error)) {
    return {
      ...payload,
      reauthorization_required: true,
      authorize_url: buildAlibabaAuthorizeUrl(baseUrl),
      callback_url: buildAlibabaCallbackUrl(baseUrl),
      next_step_ko: "Alibaba access token 또는 refresh token이 만료되었습니다. authorize_url에서 재인증한 뒤 새 access_token/refresh_token을 Render 환경변수에 저장하고 재배포하세요.",
      token_error: removeUndefined({
        original_code: error.details?.original_code || error.code,
        original_message: error.details?.original_message || error.message,
        refresh_code: error.details?.refresh_code,
        refresh_message: error.details?.refresh_message
      })
    };
  }

  return payload;
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
