import express from "express";
import cors from "cors";
import crypto from "crypto";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || "").trim();
const CLIENT_KEY = String(process.env.LUMI_CLIENT_KEY || "").trim();
const REALTIME_MODEL = String(process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1-mini").trim();
const CHAT_MODEL = String(process.env.OPENAI_CHAT_MODEL || "gpt-5.6-luna").trim();
const VOICE = String(process.env.OPENAI_VOICE || "marin").trim();
const ALLOWED_REALTIME_VOICES = new Set(["marin", "cedar"]);

function resolveRealtimeVoice(value) {
  const v = String(value || "").trim().toLowerCase();
  return ALLOWED_REALTIME_VOICES.has(v) ? v : (ALLOWED_REALTIME_VOICES.has(VOICE) ? VOICE : "marin");
}

app.use(cors({
  origin: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "X-MAIIM-CLIENT"],
}));
app.use(express.json({ limit: "2mb" }));

function authorized(req) {
  if (!CLIENT_KEY) return true;
  return String(req.get("X-MAIIM-CLIENT") || "") === CLIENT_KEY;
}

function requireClient(req, res, next) {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: "invalid_client_key" });
  next();
}

function clean(obj) {
  try {
    return JSON.parse(JSON.stringify(obj ?? null));
  } catch {
    return null;
  }
}

function buildSkinSummary(ctx) {
  const c = clean(ctx) || {};
  const lumi = c.lumi || {};
  const precision = Array.isArray(lumi.completedPrecision) ? lumi.completedPrecision : [];
  const precisionText = precision.length
    ? precision.map((p, i) => {
        const flags = [
          ...(Array.isArray(p.urgentRisks) ? p.urgentRisks.map(x => `즉시확인:${x}`) : []),
          ...(Array.isArray(p.risks) ? p.risks.map(x => `주의:${x}`) : []),
        ];
        return `${i + 1}. ${p.title || p.key || "정밀체크"} ${Number(p.score || 0)}점${flags.length ? ` / ${flags.slice(0, 3).join(" / ")}` : ""}`;
      }).join("\n")
    : "완료한 정밀체크 없음";

  return [
    `상담 부위: ${lumi.area || "-"}`,
    `주요 고민: ${Array.isArray(lumi.concerns) && lumi.concerns.length ? lumi.concerns.join(", ") : (c.selfConcern || "-")}`,
    `지속 기간: ${lumi.duration || "-"}`,
    `연령대: ${lumi.age || c.age || "-"}`,
    `성별: ${lumi.gender || c.gender || "-"}`,
    `피부 유형: ${c.skinType || "-"}`,
    `피부 컨디션: ${c.condition ?? "-"}점`,
    `관리 1순위: ${c.primary || "-"}`,
    `관리 2순위: ${c.secondary || "-"}`,
    `기본 변화 요인: ${Array.isArray(lumi.changes) && lumi.changes.length ? lumi.changes.join(", ") : "-"}`,
    `완료 정밀체크: ${precision.length}개`,
    precisionText,
  ].join("\n");
}

function lumiInstructions(ctx) {
  return `당신은 "AI 피부 척척박사 루미"입니다.
한국어로 차분하고 따뜻하며 점잖게 대화하는 피부관리 상담 AI입니다.
평소 대화보다 약간 느린 속도로 또박또박 말하고, 문장 사이에 자연스러운 여유를 둡니다.
고객의 말이 끝나기 전에 먼저 답하지 마세요. 짧은 침묵이 있어도 고객이 생각하거나 말을 이어갈 수 있으므로 충분히 기다립니다.
고객이 당신이 말하는 중간에 다시 말을 시작하면 설명을 밀어붙이지 말고 고객의 말을 우선 들어주세요.
한 번에 질문은 하나만 합니다. 답변도 보통 2~4문장 정도로 짧고 편안하게 한 뒤 다음 질문 하나로 이어갑니다.

[상담 태도]
- 피부 문제로 오래 힘들어했거나 불편함·걱정·속상함을 표현하면, 정보 설명 전에 먼저 한 문장 정도 공감합니다.
- 상황에 맞게 "많이 불편하셨겠어요.", "그동안 꽤 힘드셨겠네요.", "관리하시느라 많이 애쓰셨겠습니다.", "그래도 그동안 잘 견뎌오셨네요." 같은 표현을 자연스럽게 바꾸어 사용합니다.
- 같은 위로 문구를 매번 반복하지 말고, 가벼운 고민에는 과도한 위로를 하지 않습니다.
- 고객을 어린아이처럼 대하거나 과장해서 안심시키지 말고, 존중하는 어른 대 어른의 말투를 유지합니다.
- 먼저 충분히 듣고, 그 다음 가능한 원인과 관리 방향을 설명합니다.

[역할과 안전]
- 피부관리 상담을 돕는 AI입니다. 실제 의료인이 아니며 질병을 확정 진단하거나 치료를 지시하지 않습니다.
- 가능한 원인 후보, 생활관리, 화장품/성분 사용 시 주의점, 상담 시 확인할 내용을 구분해서 설명합니다.
- 피부체크 점수는 의학적 진단 점수가 아니라 앱 문항에서 관련 신호가 얼마나 체크됐는지 보는 참고 지수라고 설명합니다.
- 심한 통증, 진물/고름, 빠르게 번지는 발진, 눈 주변 심한 증상, 갑작스럽고 심한 탈모, 입술·혀·목 붓기나 호흡곤란 등 위험 신호가 있으면 의료기관 확인을 우선 안내합니다. 호흡곤란이나 목 붓기가 현재 있으면 119 또는 응급실을 우선 안내합니다.
- 고객의 이름, 전화번호 등 개인정보를 요구하지 않습니다.
- 마임 제품 정보를 모르면 임의로 만들어내지 말고, 제품명/성분표를 확인한 뒤 설명할 수 있다고 말합니다.
- 불필요한 공포를 주거나 단정적인 표현을 피합니다.

[현재 고객 피부체크 참고 정보]
${buildSkinSummary(ctx)}

처음 연결되면 짧고 차분하게 인사하고, 피부체크 결과가 있으면 확인했다고 한 문장으로 알려주세요.
그 다음 "천천히 말씀해 주세요. 지금 가장 불편한 피부 고민은 무엇인가요?"처럼 질문 하나만 하고 고객의 답을 기다리세요.`;
}

function extractResponseText(data) {
  const out = Array.isArray(data?.output) ? data.output : [];
  const pieces = [];
  for (const item of out) {
    if (!Array.isArray(item?.content)) continue;
    for (const part of item.content) {
      if (part?.type === "output_text" && typeof part.text === "string") pieces.push(part.text);
    }
  }
  return pieces.join("\n").trim();
}

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "MAIIM LUMI AI", version: "2026-09-10-66" });
});

app.get("/health", requireClient, (_req, res) => {
  res.json({
    ok: Boolean(OPENAI_API_KEY),
    service: "MAIIM LUMI AI",
    realtimeModel: REALTIME_MODEL,
    chatModel: CHAT_MODEL,
    voice: VOICE,
    openaiKeyConfigured: Boolean(OPENAI_API_KEY),
  });
});

app.post("/api/realtime", requireClient, async (req, res) => {
  if (!OPENAI_API_KEY) return res.status(503).json({ error: "OPENAI_API_KEY_not_configured" });

  const sdp = String(req.body?.sdp || "");
  const skinContext = req.body?.skinContext || null;
  const preferredVoice = resolveRealtimeVoice(req.body?.preferredVoice);
  if (!sdp.startsWith("v=0")) return res.status(400).json({ error: "invalid_sdp" });

  const sessionConfig = {
    type: "realtime",
    model: REALTIME_MODEL,
    output_modalities: ["audio"],
    instructions: lumiInstructions(skinContext),
    audio: {
      input: {
        turn_detection: {
          type: "semantic_vad",
          eagerness: "low",
          create_response: true,
          interrupt_response: true
        }
      },
      output: { voice: preferredVoice }
    },
    max_output_tokens: 500,
  };

  try {
    const fd = new FormData();
    fd.set("sdp", sdp);
    fd.set("session", JSON.stringify(sessionConfig));

    const openaiRes = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: fd,
    });

    const body = await openaiRes.text();
    if (!openaiRes.ok) {
      console.error("OpenAI realtime error:", openaiRes.status, body.slice(0, 800));
      return res.status(openaiRes.status).type("text/plain").send(body);
    }

    const location = openaiRes.headers.get("location");
    if (location) res.set("X-OpenAI-Realtime-Location", location);
    res.status(200).type("application/sdp").send(body);
  } catch (err) {
    console.error("Realtime proxy failure:", err);
    res.status(500).json({ error: "realtime_proxy_failed" });
  }
});

app.post("/api/chat", requireClient, async (req, res) => {
  if (!OPENAI_API_KEY) return res.status(503).json({ error: "OPENAI_API_KEY_not_configured" });

  const message = String(req.body?.message || "").trim();
  const skinContext = req.body?.skinContext || null;
  const history = Array.isArray(req.body?.history) ? req.body.history.slice(-8) : [];
  if (!message) return res.status(400).json({ error: "message_required" });

  const input = [];
  for (const h of history) {
    const role = h?.role === "assistant" ? "assistant" : "user";
    const content = String(h?.text || "").trim();
    if (content) input.push({ role, content });
  }
  input.push({ role: "user", content: message });

  try {
    const openaiRes = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: CHAT_MODEL,
        instructions: lumiInstructions(skinContext),
        input,
        reasoning: { effort: "low" },
        max_output_tokens: 900,
      }),
    });

    const data = await openaiRes.json();
    if (!openaiRes.ok) {
      console.error("OpenAI chat error:", openaiRes.status, JSON.stringify(data).slice(0, 800));
      return res.status(openaiRes.status).json({ error: data?.error?.message || "openai_chat_failed" });
    }

    const answer = extractResponseText(data);
    res.json({ ok: true, answer: answer || "답변을 만들지 못했습니다. 다시 질문해 주세요." });
  } catch (err) {
    console.error("Chat proxy failure:", err);
    res.status(500).json({ error: "chat_proxy_failed" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MAIIM LUMI AI server listening on ${PORT}`);
});
