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
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiModel: process.env.OPENAI_MODEL || "gpt-4.1-mini",
  openaiUrl: process.env.OPENAI_CHAT_COMPLETIONS_URL || "https://api.openai.com/v1/chat/completions",
  alibabaAppKey: process.env.ALIBABA_APP_KEY || "",
  alibabaAppSecret: process.env.ALIBABA_APP_SECRET || "",
  alibabaAccessToken: process.env.ALIBABA_ACCESS_TOKEN || "",
  alibabaGateway: process.env.ALIBABA_GATEWAY || "https://api.taobao.com/router/rest",
  alibabaSelfAccountId: process.env.ALIBABA_SELF_ACCOUNT_ID || ""
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

    if (url.pathname.startsWith("/api/")) {
      assertAuthorized(req);
    }

    if (routeKey === "GET /api/alibaba/status") {
      return sendJson(res, 200, {
        configured: isAlibabaConfigured(),
        hasAppKey: Boolean(config.alibabaAppKey),
        hasAppSecret: Boolean(config.alibabaAppSecret),
        hasAccessToken: Boolean(config.alibabaAccessToken),
        hasSelfAccountId: Boolean(config.alibabaSelfAccountId),
        gateway: config.alibabaGateway
      });
    }

    if (routeKey === "POST /api/alibaba/oauth/token") {
      const input = await readJson(req);
      const result = await exchangeAlibabaCode(input);
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

server.listen(config.port, () => {
  console.log(`ChatGPT Alibaba app backend running at ${config.baseUrl}`);
  console.log(`OpenAPI schema: ${config.baseUrl}/openapi.json`);
});

async function searchProducts(input = {}) {
  const pageSize = clamp(Number(input.page_size || input.pageSize || 20), 1, 30);
  const currentPage = clamp(Number(input.current_page || input.currentPage || 1), 1, 100);
  const language = input.language || "ENGLISH";
  const subject = input.subject || input.query || "";

  if (Array.isArray(input.products)) {
    return {
      ok: true,
      source: "provided",
      products: normalizeProducts(input.products).slice(0, pageSize)
    };
  }

  if (!isAlibabaConfigured()) {
    return {
      ok: true,
      source: "not_configured",
      products: [],
      note: "Alibaba credentials are not configured. Add ALIBABA_APP_KEY, ALIBABA_APP_SECRET, and ALIBABA_ACCESS_TOKEN."
    };
  }

  const response = await callAlibaba("alibaba.icbu.product.list", {
    language,
    subject,
    current_page: currentPage,
    page_size: pageSize,
    category_id: input.category_id || input.categoryId || undefined,
    group_id1: input.group_id1 || input.groupId1 || undefined,
    group_id2: input.group_id2 || input.groupId2 || undefined,
    group_id3: input.group_id3 || input.groupId3 || undefined
  });

  const products = normalizeProducts(findDeepArray(response, "products"));
  return {
    ok: true,
    source: "alibaba.icbu.product.list",
    products,
    total: findDeepValue(response, "total_item") || products.length,
    currentPage,
    pageSize
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

  const response = await callAlibaba("taobao.top.auth.token.create", {
    code
  }, { includeSession: false });

  const token = findDeepValue(response, "access_token");
  const refreshToken = findDeepValue(response, "refresh_token");
  const userId = findDeepValue(response, "user_id");
  const userNick = findDeepValue(response, "user_nick");
  const expireTime = findDeepValue(response, "expire_time");

  return {
    ok: true,
    source: "taobao.top.auth.token.create",
    access_token: token,
    refresh_token: refreshToken,
    user_id: userId,
    user_nick: userNick,
    expire_time: expireTime,
    raw: response,
    next_step: token
      ? "Add access_token to Render as ALIBABA_ACCESS_TOKEN. Use user_id or user_nick to help identify the seller account."
      : "Token fields were not found in the response. Check raw response."
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
    return {
      ok: true,
      source: "fallback",
      buyer_name: buyerName,
      needs,
      recommendations: scoredProducts.slice(0, limit),
      share_message: buildFallbackShareMessage(scoredProducts.slice(0, limit), language),
      note: "OpenAI API key is not configured, so recommendations were ranked with local keyword matching."
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

  const apiMessages = await getImMessages({
    conversationId,
    count: input.message_count || input.messageCount || 50,
    forward: input.forward,
    limitTimeStamp: input.limit_time_stamp || input.limitTimeStamp
  });

  return [
    manualText,
    manualMessages.map(formatMessage).join("\n"),
    apiMessages.map(formatMessage).join("\n")
  ].filter(Boolean).join("\n");
}

async function getImMessages(input = {}) {
  if (!isAlibabaConfigured()) return [];
  if (!config.alibabaSelfAccountId && !input.selfAccountId) return [];

  const response = await callAlibaba("alibaba.interaction.im.message.list.query", {
    conversation_id: input.conversationId,
    count: clamp(Number(input.count || 50), 1, 100),
    forward: input.forward === undefined ? false : Boolean(input.forward),
    limit_time_stamp: input.limitTimeStamp || undefined,
    self_account_id: input.selfAccountId || config.alibabaSelfAccountId
  }, { includeSession: Boolean(config.alibabaAccessToken) });

  return normalizeMessages(findDeepArray(response, "message_list") || findDeepArray(response, "messages"));
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

  const allParams = removeUndefined({
    method,
    app_key: config.alibabaAppKey,
    sign_method: "md5",
    timestamp: formatGmt8(new Date()),
    format: "json",
    v: "2.0",
    simplify: "true",
    session: options.includeSession === false ? undefined : config.alibabaAccessToken || undefined,
    ...params
  });

  allParams.sign = signTopParams(allParams, config.alibabaAppSecret);

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

function signTopParams(params, secret) {
  const base = secret + Object.keys(params)
    .filter((key) => key !== "sign" && params[key] !== undefined && params[key] !== null)
    .sort()
    .map((key) => `${key}${String(params[key])}`)
    .join("") + secret;

  return crypto.createHash("md5").update(base, "utf8").digest("hex").toUpperCase();
}

function buildOpenApiSpec(baseUrl = config.baseUrl) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Alibaba Account Assistant API",
      version: "0.1.0",
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
  const keywords = Array.from(new Set(
    lower
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[^a-z0-9가-힣\s-]/gi, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 3)
      .filter((word) => !["hello", "please", "thanks", "price", "want", "need", "order", "product"].includes(word))
  )).slice(0, 12);

  const quantityMatch = lower.match(/\b\d{1,7}\s?(?:pcs|pieces|units|sets|개|ea)\b/i);
  const countryMatch = lower.match(/\b(?:usa|united states|korea|japan|china|germany|canada|australia|uk|india|vietnam|uae|saudi)\b/i);

  return {
    keywords,
    quantity: quantityMatch?.[0] || "",
    country: countryMatch?.[0] || "",
    constraints: [
      lower.includes("sample") ? "sample requested" : "",
      lower.includes("moq") ? "MOQ mentioned" : "",
      lower.includes("shipping") || lower.includes("delivery") ? "shipping/delivery mentioned" : ""
    ].filter(Boolean)
  };
}

function scoreProducts(products, needs) {
  const keywords = new Set((needs.keywords || []).map((word) => word.toLowerCase()));
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

function buildFallbackShareMessage(products, language) {
  const lines = products.map((product, index) => {
    const url = product.url ? ` ${product.url}` : "";
    return `${index + 1}. ${product.title || product.id}${url}`;
  });

  return {
    buyer_language: language.toLowerCase().startsWith("ko")
      ? `문의하신 내용에 맞춰 아래 제품을 추천드립니다.\n${lines.join("\n")}`
      : `Based on your inquiry, I recommend these products:\n${lines.join("\n")}`,
    korean_translation: `문의 내용에 맞춰 아래 제품을 추천한다는 메시지입니다.\n${lines.join("\n")}`
  };
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
      raw: product
    };
  }).filter((product) => product.title || product.id || product.url);
}

function normalizeMessages(messages = []) {
  return messages.map((message) => ({
    sender: message.sender || message.sender_account_id || message.senderAccountId || "unknown",
    text: message.text || message.content || message.message || "",
    time: message.time || message.send_time || message.sendTime || ""
  })).filter((message) => message.text);
}

function formatMessage(message) {
  return `[${message.time || "no time"}] ${message.sender || "unknown"}: ${message.text}`;
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
  return Boolean(config.alibabaAppKey && config.alibabaAppSecret && config.alibabaAccessToken);
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
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,x-api-key");
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
