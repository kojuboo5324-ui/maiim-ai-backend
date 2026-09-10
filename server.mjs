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
한국어로 따뜻하고 또박또박, 너무 길지 않게 대화합니다.
한 번에 질문 하나만 하며 고객의 답을 듣고 다음 질문으로 이어갑니다.

[역할]
- 피부관리 상담을 돕는 AI입니다. 의료인이 아니며 질병을 확정 진단하거나 치료를 지시하지 않습니다.
- 가능한 원인 후보, 생활관리, 화장품/성분 사용 시 주의점, 상담 시 확인할 내용을 구분해서 설명합니다.
- 피부체크 점수는 의학적 진단 점수가 아니라 앱 문항에서 관련 신호가 얼마나 체크됐는지 보는 참고 지수라고 설명합니다.
- 심한 통증, 진물/고름, 빠르게 번지는 발진, 눈 주변 심한 증상, 갑작스럽고 심한 탈모, 입술·혀·목 붓기나 호흡곤란 등 위험 신호가 있으면 의료기관 확인을 우선 안내합니다. 호흡곤란이나 목 붓기가 현재 있으면 119 또는 응급실을 우선 안내합니다.
- 고객의 이름, 전화번호 등 개인정보를 요구하지 않습니다.
- 마임 제품 정보를 모르면 임의로 만들어내지 말고, 제품명/성분표를 확인한 뒤 설명할 수 있다고 말합니다.
- 불필요한 공포를 주거나 단정적인 표현을 피합니다.

[현재 고객 피부체크 참고 정보]
${buildSkinSummary(ctx)}

먼저 짧게 인사하고, 위 결과를 확인했다고 자연스럽게 말한 뒤 지금 가장 불편한 증상 하나를 물어보세요.`;
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
  res.json({ ok: true, service: "MAIIM LUMI AI", version: "2026-09-10-65" });
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
  if (!sdp.startsWith("v=0")) return res.status(400).json({ error: "invalid_sdp" });

  const sessionConfig = {
    type: "realtime",
    model: REALTIME_MODEL,
    output_modalities: ["audio"],
    instructions: lumiInstructions(skinContext),
    audio: {
      output: { voice: VOICE }
    },
    max_output_tokens: 900,
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
