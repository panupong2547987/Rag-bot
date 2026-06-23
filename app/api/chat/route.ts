import { GoogleGenerativeAI } from "@google/generative-ai"
import { createHash } from "crypto"
import { docToText } from "@/app/lib/document-text"
import { getEmbedding } from "@/app/lib/embedding"
import { checkProhibitedKeyword, isOutOfScopeQuestion, parseProhibitedKeywords } from "@/app/lib/guardrails"
import { ResponseCache } from "@/app/lib/response-cache"
import { getSupabaseClient } from "@/app/lib/supabase"

type MatchedDoc = {
  id?: number
  question?: string
  answer?: string
  content?: string
  similarity?: number
}

type ChatTurn = {
  role: "user" | "bot"
  text: string
}
type AnswerMode = "strict" | "balanced" | "chat"

type ChatApiSuccessPayload = {
  answer: string
  contextMatches: number
  fallbackUsed: boolean
  fallbackReason: string
  model: string
  cacheHit?: boolean
}

const chatResponseCache = new ResponseCache<ChatApiSuccessPayload>()

function buildCacheKey(question: string, history: ChatTurn[]) {
  const compactHistory = history.slice(-4).map((turn) => `${turn.role}:${turn.text}`).join("|")
  return createHash("sha1").update(`${question.trim().toLowerCase()}::${compactHistory}`).digest("hex")
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs)
    promise
      .then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch((error) => {
        clearTimeout(timer)
        reject(error)
      })
  })
}

async function generateWithModel(apiKey: string, modelName: string, prompt: string) {
  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({ model: modelName, generationConfig: { temperature: 0.2 } })
  const result = await model.generateContent(prompt)
  return result.response.text()
}

async function generateWithZai(apiKey: string, modelName: string, prompt: string, timeoutOverrideMs?: number) {
  const baseTimeoutMs = Number(process.env.MODEL_TIMEOUT_MS ?? 6000)
  const timeoutMs = timeoutOverrideMs ?? Math.max(baseTimeoutMs * 2, 10_000)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  const res = await fetch("https://api.z.ai/api/paas/v4/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: modelName,
      stream: false,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }]
    }),
    signal: controller.signal
  })
    .catch((error) => {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`zai/${modelName} timeout after ${timeoutMs}ms`)
      }
      throw error
    })
    .finally(() => {
      clearTimeout(timer)
    })

  if (!res.ok) {
    const errBody = await res.text().catch(() => "")
    throw new Error(`Z.AI request failed: ${res.status} ${errBody}`.trim())
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }

  const answer = data.choices?.[0]?.message?.content?.trim()
  if (!answer) {
    throw new Error("Z.AI response missing content")
  }

  return answer
}

function isRateLimitError(error: unknown) {
  const status =
    typeof error === "object" && error !== null && "status" in error ? (error as { status?: unknown }).status : undefined

  if (status === 429) {
    return true
  }

  const message = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase()
  return (
    message.includes("429") ||
    message.includes("rate limit") ||
    message.includes("quota") ||
    message.includes("resource exhausted") ||
    message.includes("too many requests")
  )
}

function extractAnswerFromContent(content: string | undefined) {
  if (!content) return ""
  const marker = "คำตอบ:"
  const idx = content.indexOf(marker)
  if (idx === -1) return ""
  return content.slice(idx + marker.length).trim()
}

function makeDirectAnswerNatural(question: string, answer: string) {
  const clean = answer.trim()
  if (!clean) return clean

  const academicCalendarLike =
    clean.includes("/") && /ภาคการศึกษาต้น|ภาคการศึกษาปลาย|ภาคฤดูร้อน/.test(clean)

  if (academicCalendarLike) {
    const parts = clean
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const normalized = part.replace(/\s+/g, " ").trim()
        return normalized.includes(":") ? normalized : normalized.replace(/ภาคการศึกษา/g, "ภาค")
      })
    return `ได้เลยครับ ผมสรุปวันสำคัญให้แบบอ่านง่ายนะ\nเผื่อวางแผนส่งเอกสารได้ทันเวลา:\n- ${parts.join("\n- ")}`
  }

  if (question.includes("วันไหน") || question.includes("เมื่อไหร่") || question.includes("เดดไลน์")) {
    return `ได้เลย: ${clean}`
  }

  return clean
}

function enforceMaleTone(text: string) {
  if (!text) return text
  return text
    .replace(/นะค่ะ/g, "นะครับ")
    .replace(/นะคะ/g, "นะครับ")
    .replace(/ค่ะ/g, "ครับ")
    .replace(/คะ(?=[\s!?.,]|$)/g, "ครับ")
}

function extractQuestionFromContent(content: string | undefined) {
  if (!content) return ""
  const q = content.split("คำตอบ:")[0] ?? ""
  return q.replace("คำถาม:", "").trim()
}

function uniqueTokens(text: string) {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}\-]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2)
    )
  )
}

function lexicalOverlapScore(a: string, b: string) {
  const aTokens = uniqueTokens(a)
  const bSet = new Set(uniqueTokens(b))
  if (!aTokens.length || !bSet.size) return 0
  let hit = 0
  for (const token of aTokens) {
    if (bSet.has(token)) hit += 1
  }
  return hit / aTokens.length
}

type QueryConstraints = {
  upCode?: string
  grade?: string
  programHint?: string
}

function extractQueryConstraints(question: string): QueryConstraints {
  const text = question.toLowerCase()
  const upMatch = question.match(/\bup\s*\.?\s*(\d+(?:\.\d+)?)\b/i)
  const gradeMatch = question.match(/ชั้นปี\s*\d(?:\s*-\s*\d)?/i)

  const programHints = [
    "ปริญญาตรีควบ",
    "แพทย์แผนจีน",
    "ปริญญาตรี ปกติ",
    "โครงการพิเศษ",
    "บัณฑิตศึกษา",
    "แพทยศาสตรบัณฑิต",
    "ชั้นปี 3",
    "ชั้นปี 4-6"
  ]
  const programHint = programHints.find((hint) => text.includes(hint.toLowerCase()))

  return {
    upCode: upMatch ? upMatch[1] : undefined,
    grade: gradeMatch ? gradeMatch[0].replace(/\s+/g, " ").trim() : undefined,
    programHint
  }
}

function matchesConstraints(content: string | undefined, constraints: QueryConstraints) {
  const source = (content ?? "").toLowerCase()
  if (!source) return false

  if (constraints.upCode) {
    const normalized = source.replace(/\s+/g, "")
    const upNeedle = `up${constraints.upCode.replace(/\s+/g, "").toLowerCase()}`
    if (!normalized.includes(upNeedle)) {
      return false
    }
  }

  if (constraints.grade && !source.includes(constraints.grade.toLowerCase())) {
    return false
  }

  if (constraints.programHint && !source.includes(constraints.programHint.toLowerCase())) {
    return false
  }

  return true
}

function parseGeminiModelChain() {
  const raw = process.env.GEMINI_MODEL_CHAIN?.trim()
  if (!raw) {
    return ["gemini-2.5-flash", "gemma-3-27b-it"] as const
  }

  const chain = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)

  return (chain.length ? chain : ["gemini-2.5-flash", "gemma-3-27b-it"]) as readonly string[]
}

function isFollowUpQuestion(text: string) {
  const q = text.trim().toLowerCase()
  if (!q) return false
  if (q.length <= 40) return true
  return /^(แล้ว|งั้น|อันนี้|เรื่องนี้|มัน|แล้วเรื่อง|แล้วถ้า)/.test(q)
}

function isCautionIntent(text: string) {
  const q = text.trim().toLowerCase()
  return /ต้องระวัง|ควรระวัง|ข้อควรระวัง|เตือน|พลาดอะไร|มีอะไรต้องรู้/.test(q)
}

function getLatestBotAnswer(history: ChatTurn[]) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.role === "bot" && history[i]?.text?.trim()) {
      return history[i].text.trim()
    }
  }
  return ""
}

function buildRetrievalQuery(userQuestion: string, history: ChatTurn[]) {
  const latestUserTurns = history
    .filter((turn) => turn.role === "user")
    .slice(-2)
    .map((turn) => turn.text.trim())
    .filter(Boolean)

  if (latestUserTurns.length === 0 || !isFollowUpQuestion(userQuestion)) {
    return userQuestion
  }

  const base = latestUserTurns.join("\n")
  return `${base}\n${userQuestion}`.trim()
}

// ------------------------------------------------------------
// โค้ดดึงข้อมูล Facebook (เวอร์ชันไม่ติด Cache)
function isPageUpdateIntent(text: string) {
  const q = text.trim().toLowerCase()
  return /เพจ|โพสต์|ประกาศล่าสุด|อัปเดตหน้าเพจ|เฟสบุ๊ค|facebook|ข่าวล่าสุด/.test(q)
}

async function fetchFacebookPagePosts() {
  const pageToken = process.env.FB_PAGE_TOKEN?.trim().replace(/\s+/g, '')
  if (!pageToken) return "\n[ระบบส่วนตัวบอท: ดึงข้อมูลไม่ได้ เพราะหา Token ใน Vercel ไม่เจอครับ]"
  
  try {
    const res = await fetch(`https://graph.facebook.com/v19.0/me/posts?limit=3&access_token=${pageToken}`, { cache: 'no-store' })
    if (!res.ok) {
      const errText = await res.text()
      return `\n[ระบบส่วนตัวบอท: ดึงข้อมูลไม่ได้ เฟสบุ๊คฟ้อง Error -> ${res.status} ${errText}]`
    }
    const data = await res.json()
    if (data && data.data && data.data.length > 0) {
      const posts = data.data
        .filter((p: { message?: string }) => p.message)
        .map((p: { message: string; created_time: string }) => `- ${p.message} (วันที่: ${new Date(p.created_time).toLocaleDateString("th-TH")})`)
        .join("\n\n")
      return `\n[ข้อมูลอัปเดตเรียลไทม์จากหน้าเพจ Facebook]\n${posts}`
    }
    return "\n[ระบบส่วนตัวบอท: ดึงสำเร็จแล้ว แต่หน้าเพจยังไม่มีโพสต์อะไรเลย]"
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return `\n[ระบบส่วนตัวบอท: โค้ดพังตอนดึงข้อมูล -> ${msg}]`
  }
}
// ------------------------------------------------------------

export async function POST(req: Request) {
  const { question, history, mode } = (await req.json()) as { question?: string; history?: ChatTurn[]; mode?: AnswerMode }
  
  // จุดแก้ที่ 1: ดักแปลงคำย่อ "ปี 69" ให้เป็น "ปี 2569" เพื่อให้ระบบ Vector Search และ Keyword ค้นหาเจอ
  let userQuestion = (question ?? "").trim()
  userQuestion = userQuestion.replace(/ปี\s?68/g, "ปี 2568").replace(/ปี\s?69/g, "ปี 2569").replace(/ปี\s?70/g, "ปี 2570")

  const safeHistory = history ?? []
  const retrievalQuery = buildRetrievalQuery(userQuestion, safeHistory)
  const chatScope = req.headers.get("x-chat-scope") === "user" ? "user" : "guest"
  const answerMode: AnswerMode = mode === "chat" ? "chat" : mode === "strict" ? "strict" : "balanced"
  
  // เช็คว่าถามเรื่องเพจไหม
  const isPageIntent = isPageUpdateIntent(userQuestion)

  if (!userQuestion) {
    return Response.json({ error: "Missing question", fallbackReason: "invalid-request" }, { status: 400 })
  }

  const cacheTtlMs = Number(process.env.CHAT_RESPONSE_CACHE_TTL_MS ?? 60_000)
  const cacheKey = buildCacheKey(userQuestion, safeHistory)
  const cacheEnabled = chatScope === "guest" && process.env.ENABLE_CHAT_RESPONSE_CACHE === "true"
  
  // ปิดแคชถ้าถามเรื่องเพจ
  if (cacheEnabled && !isPageIntent) {
    const cached = chatResponseCache.get(cacheKey)
    if (cached) {
      return Response.json({ ...cached, cacheHit: true })
    }
  }

  const prohibitedKeywords = parseProhibitedKeywords(process.env.PROHIBITED_KEYWORDS)
  const prohibitedCheck = checkProhibitedKeyword(userQuestion, prohibitedKeywords)
  if (prohibitedCheck.blocked) {
    return Response.json(
      { error: `Message blocked by policy (${prohibitedCheck.keyword})`, fallbackReason: "prohibited-keyword" },
      { status: 400 }
    )
  }

  const geminiApiKey = process.env.GEMINI_API_KEY
  const zaiApiKey = process.env.ZAI_API_KEY
  const enableOutOfScopeGuardrail = process.env.ENABLE_OUT_OF_SCOPE_GUARDRAIL === "true"

  if (!geminiApiKey && !zaiApiKey) {
    return Response.json({ error: "Missing GEMINI_API_KEY and ZAI_API_KEY", fallbackReason: "missing-model-keys" }, { status: 500 })
  }

  let supabase
  try {
    supabase = getSupabaseClient()
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    return Response.json({ error: message, fallbackReason: "supabase-init-failed" }, { status: 500 })
  }

  const embedding = await getEmbedding(retrievalQuery)

  // จุดแก้ที่ 2: ปรับ Threshold ลงเพื่อให้ Vector Search ยืดหยุ่นขึ้นนิดนึง
  const retrievalPlans = [
    { threshold: 0.65, count: 3 },
    { threshold: 0.55, count: 5 },
    { threshold: 0.40, count: 8 }
  ]

  let docs: MatchedDoc[] = []
  for (const plan of retrievalPlans) {
    const attempt = await supabase.rpc("match_documents", {
      query_embedding: embedding,
      match_threshold: plan.threshold,
      match_count: plan.count
    })

    if (attempt.error) {
      console.error("search error:", attempt.error)
      continue
    }

    const rows = (attempt.data ?? []) as MatchedDoc[]
    if (rows.length > 0) {
      docs = rows
      break
    }
  }

  // Keyword fallback
  if (docs.length === 0) {
    const terms = uniqueTokens(retrievalQuery).filter((term) => term.length >= 2).slice(0, 6)
    if (terms.length > 0) {
      const orFilter = terms.map((term) => `content.ilike.%${term}%`).join(",")
      const keywordSearch = await supabase.from("documents").select("id,content").or(orFilter).limit(6)
      if (keywordSearch.error) {
        console.error("keyword search error:", keywordSearch.error)
      } else {
        docs = ((keywordSearch.data ?? []) as Array<{ id: number; content: string }>).map((row) => ({
          id: row.id,
          content: row.content,
          similarity: 0.5
        }))
      }
    }
  }

  // Guardrail 1: ถ้าไม่เจอข้อมูลเลย
  if (docs.length === 0 && answerMode === "strict" && !isPageIntent) {
    return Response.json({
      answer:
        "ผมหาข้อมูลที่ตรงเป๊ะในคลังความรู้ยังไม่เจอครับ แต่ช่วยต่อได้แน่นอน\nลองพิมพ์เพิ่มอีกนิดแบบนี้ได้เลย: ประเภทผู้กู้ (รายใหม่/รายเก่า), ภาคเรียน, หรือชื่อแบบฟอร์ม แล้วผมจะสรุปให้ตรงประเด็นทันที",
      contextMatches: 0,
      fallbackUsed: true,
      fallbackReason: "no-context-match",
      model: "context-fallback",
      cacheHit: false
    })
  }

  const constraints = extractQueryConstraints(userQuestion)
  const constrainedDocs = docs.filter((doc) => matchesConstraints(doc.content, constraints))
  const docsForRanking = constrainedDocs.length > 0 ? constrainedDocs : docs
  const sortedDocs = [...docsForRanking].sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
  const topDoc = sortedDocs[0]
  const secondDoc = sortedDocs[1]
  const topSimilarity = topDoc?.similarity ?? 0
  const directAnswerThreshold = Number(process.env.RAG_DIRECT_ANSWER_SIMILARITY ?? 0.75)
  const directAnswer = extractAnswerFromContent(topDoc?.content)
  const lockedAnswerThreshold = Number(process.env.RAG_LOCK_ANSWER_SIMILARITY ?? 0.65)
  const strictMinSimilarity = Number(process.env.RAG_STRICT_MIN_SIMILARITY ?? 0.62)
  const lexicalMin = Number(process.env.RAG_LOCK_LEXICAL_MIN ?? 0.25)
  const similarityGapMin = Number(process.env.RAG_LOCK_GAP_MIN ?? 0.04)
  const topQuestionText = extractQuestionFromContent(topDoc?.content)
  const lexicalScore = lexicalOverlapScore(userQuestion, topQuestionText)
  const similarityGap = (topDoc?.similarity ?? 0) - (secondDoc?.similarity ?? 0)
  const softOutOfScopeSimilarity = Number(process.env.RAG_SOFT_OUT_OF_SCOPE_SIMILARITY ?? 0.56)
  const canLockAnswer = Boolean(
    directAnswer &&
      topSimilarity >= lockedAnswerThreshold &&
      lexicalScore >= lexicalMin &&
      (sortedDocs.length === 1 || similarityGap >= similarityGapMin)
  )

  // Guardrail 2: ความมั่นใจต่ำ
  if (answerMode === "strict" && topSimilarity < strictMinSimilarity && !isPageIntent) {
    const lastBotAnswer = getLatestBotAnswer(safeHistory)
    const followUpLike = isFollowUpQuestion(userQuestion)
    const cautionLike = isCautionIntent(userQuestion)
    if (followUpLike && cautionLike) {
      const base = directAnswer || lastBotAnswer
      if (base) {
        return Response.json({
          answer: `จากข้อมูลที่คุยกันเมื่อกี้ สิ่งที่ควรระวังคืออย่าให้เกินกำหนดเวลา และตรวจรายละเอียดเอกสารให้ครบก่อนส่ง\nข้อมูลอ้างอิงที่เกี่ยวข้อง: ${base}`,
          contextMatches: docs.length,
          fallbackUsed: true,
          fallbackReason: "follow-up-caution-guidance",
          model: "context-fallback",
          cacheHit: false
        })
      }
    }

    const suggestions = sortedDocs
      .slice(0, 3)
      .map((doc) => extractQuestionFromContent(doc.content))
      .filter(Boolean)
    const tentative = directAnswer || extractAnswerFromContent(sortedDocs[0]?.content)
    const tentativeText = tentative ? `พอมีข้อมูลที่น่าจะใกล้สุดคือ: ${tentative}` : ""
    const suggestionText = suggestions.length
      ? `\nหัวข้อที่ใกล้เคียงที่ผมเจอ:\n- ${suggestions.join("\n- ")}`
      : ""

    return Response.json({
      answer: `ผมพอเจอข้อมูลที่ใกล้เคียงครับ แต่ยังอยากเช็กให้แม่นก่อนตอบฟันธง\n${tentativeText}\nถ้าบอกเพิ่มอีกนิด (ภาคเรียน/ประเภทผู้กู้/ชื่อแบบฟอร์ม) ผมจะตอบให้ชัดขึ้นทันที${suggestionText}`,
      contextMatches: docs.length,
      fallbackUsed: true,
      fallbackReason: "low-confidence-context",
      model: "context-fallback",
      cacheHit: false
    })
  }

  // ล็อกคำตอบ
  if (answerMode === "strict" && topDoc && topSimilarity >= directAnswerThreshold && directAnswer && canLockAnswer && !isPageIntent) {
    const naturalDirectAnswer = makeDirectAnswerNatural(userQuestion, directAnswer)
    const payload: ChatApiSuccessPayload = {
      answer: naturalDirectAnswer,
      contextMatches: docs.length,
      fallbackUsed: false,
      fallbackReason: "direct-rag-answer",
      model: "retrieval-direct"
    }
    if (cacheEnabled) {
      chatResponseCache.set(cacheKey, payload, cacheTtlMs)
    }
    return Response.json({ ...payload, cacheHit: false })
  }

  const maxSimilarity = Math.max(0, ...docs.map((doc) => doc.similarity ?? 0))
  
  // Guardrail 3: นอกขอบเขตแบบซอฟต์
  if (answerMode !== "strict" && maxSimilarity < softOutOfScopeSimilarity && !isPageIntent) {
    const suggestions = sortedDocs
      .slice(0, 3)
      .map((doc) => extractQuestionFromContent(doc.content))
      .filter(Boolean)
    const suggestionsText = suggestions.length
      ? `\nลองถามแนวนี้ได้ เช่น:\n- ${suggestions.join("\n- ")}`
      : ""

    return Response.json({
      answer: `คำถามนี้อาจยังไม่อยู่ในขอบเขตข้อมูลที่ผมมีตอนนี้ครับ\nผมตอบได้แม่นที่สุดในเรื่อง กยศ / การกู้ยืม / ระเบียบนิสิต / ปฏิทินการศึกษา${suggestionsText}\nอยากให้ผมช่วยแปลงคำถามให้ตรงกับฐานข้อมูลที่มีไหมครับ?`,
      contextMatches: docs.length,
      fallbackUsed: true,
      fallbackReason: "soft-out-of-scope",
      model: "context-fallback",
      cacheHit: false
    })
  }

  // Guardrail 4: นอกขอบเขต
  if (answerMode === "strict" && enableOutOfScopeGuardrail && isOutOfScopeQuestion(userQuestion, maxSimilarity) && !isPageIntent) {
    return Response.json({
      answer:
        "คำถามนี้อาจเลยขอบเขตที่ระบบนี้ดูแลอยู่ครับ แต่ผมยังช่วยปรับคำถามให้ใกล้กับข้อมูลที่มีได้\nระบบนี้ถนัดเรื่อง กยศ / การกู้ยืม / ระเบียบนิสิต / ข้อมูลภายในมหาวิทยาลัย",
      contextMatches: docs.length,
      fallbackUsed: true,
      fallbackReason: "out-of-scope",
      model: "guardrail-out-of-scope"
    })
  }

  const outOfScopeRule = (!isPageIntent && enableOutOfScopeGuardrail)
    ? "- ถ้าคำถามอยู่นอกขอบเขต กยศ/การกู้ยืม/งานนิสิต/ข้อมูลในคลังความรู้ ให้ตอบปฏิเสธสุภาพว่าอยู่นอกขอบเขต"
    : ""

  const context = docsForRanking.map(docToText).filter(Boolean).join("\n")

  // นำข้อมูลหน้าเพจมารวม (ถ้ามี)
  let fbPostsContext = ""
  if (isPageIntent) {
    fbPostsContext = await fetchFacebookPagePosts()
  }
  const finalContext = [context, fbPostsContext].filter(Boolean).join("\n\n")

  const recentHistory = safeHistory
    .slice(-6)
    .map((turn) => `${turn.role === "user" ? "ผู้ใช้" : "ผู้ช่วย"}: ${turn.text}`)
    .join("\n")

  const fbInstruction = isPageIntent 
    ? "- สำคัญมาก: ผู้ใช้กำลังถามถึงหน้าเพจ ให้คุณนำ [ข้อมูลอัปเดตเรียลไทม์จากหน้าเพจ Facebook] มาสรุปตอบให้ครบถ้วนที่สุด ถ้ามีระบบแจ้ง Error ให้พิมพ์บอก Error นั้นตรงๆ เลย" 
    : ""

  // --- เพิ่มส่วนคำนวณวันที่ปัจจุบัน (พ.ศ. ไทย) สำหรับข้อ 3 ---
  const today = new Date()
  const currentDateTH = today.toLocaleDateString("th-TH", {
    year: "numeric",
    month: "long",
    day: "numeric"
  })
  // -----------------------------------------------------

  const prompt = `
คุณคือผู้ช่วย AI ที่คุยเหมือนแชทธรรมชาติ

กฎการตอบ
- [สำคัญมาก] วันนี้คือวันที่ ${currentDateTH} เมื่อผู้ใช้ถามถึงข้อมูลปัจจุบันหรือปีการศึกษาปัจจุบัน ให้คุณอ้างอิงและตอบโดยยึดตามวันที่ปัจจุบันนี้เท่านั้น หากพบข้อมูลในคลังความรู้ที่เป็นปีการศึกษาในอนาคต (เช่น ปี 2570) ให้พิจารณาว่าเป็นข้อมูลล่วงหน้า/อนาคต ห้ามนำมาตอบปนว่าเป็นข้อมูลของปีปัจจุบันเด็ดขาด
- ถ้าผู้ใช้ทักทาย ให้ตอบทักทาย
${outOfScopeRule}
${fbInstruction}
- โทนการตอบต้องเป็นมิตร สุภาพ และช่วยผู้ใช้ไปต่อได้เสมอ
- ใช้สรรพนามผู้ช่วยเพศชาย และลงท้ายด้วย "ครับ" อย่างสม่ำเสมอ
- หลีกเลี่ยงประโยคปัดสั้นๆ เช่น "ไม่มีข้อมูลที่ match ได้เลย"
- ถ้าข้อมูลไม่พอ ให้บอกว่าขาดอะไร และยกตัวอย่างสิ่งที่ผู้ใช้ควรระบุเพิ่ม
- ถ้าไม่มั่นใจ ให้เริ่มจากสิ่งที่ "น่าจะใช่ที่สุด" แบบระบุว่าเป็นข้อมูลเบื้องต้น แล้วค่อยชวนผู้ใช้ระบุเพิ่มเพื่อยืนยัน
- ถ้าถามเกี่ยวกับ กยศ ให้ใช้ข้อมูลด้านล่างเป็นหลัก และตอบให้ตรงข้อเท็จจริงที่สุด
- ถ้าในข้อมูลอ้างอิงมีคำตอบตรง ให้ตอบจากข้อมูลอ้างอิงก่อนเสมอ และห้ามแต่งข้อมูลเพิ่ม
- ถ้ามีคำตอบอยู่ในข้อมูลอ้างอิง ให้ตอบเฉพาะเนื้อคำตอบสั้นๆ โดยไม่ต้องทักทาย/ไม่ต้องเกริ่น
- ถ้าข้อมูลอ้างอิงมีหลายกรณี (เช่น หลายภาค/หลายประเภท) ให้สรุปทุกกรณีแบบเป็นรายการในคำตอบเดียว ห้ามถามกลับก่อน
- โหมดคำตอบตอนนี้คือ: ${answerMode} (strict = เข้มที่สุด, balanced = ตรงข้อมูลแต่เป็นธรรมชาติ, chat = อธิบายเพิ่มได้)

ข้อมูลอ้างอิง:
${finalContext || "ไม่มีข้อมูลอ้างอิงที่ match ได้"}

บริบทบทสนทนาก่อนหน้า:
${recentHistory || "ไม่มี"}

คำถามผู้ใช้:
${userQuestion}

ตอบให้เหมือนกำลังคุยแชทกับเพื่อน
`

  const errors: unknown[] = []
  let geminiFailed = false
  let geminiSawRateLimit = false
  const geminiTimeoutMs = Number(process.env.MODEL_TIMEOUT_MS ?? 6000)

  if (geminiApiKey) {
    const geminiModels = parseGeminiModelChain()

    for (const model of geminiModels) {
      try {
        const answer = await withTimeout(generateWithModel(geminiApiKey, model, prompt), geminiTimeoutMs, `gemini/${model}`)
        const finalAnswerRaw = answerMode === "strict" && canLockAnswer && !isPageIntent ? makeDirectAnswerNatural(userQuestion, directAnswer) : answer
        const finalAnswer = enforceMaleTone(finalAnswerRaw)
        const payload: ChatApiSuccessPayload = {
          answer: finalAnswer,
          contextMatches: docs.length,
          fallbackUsed: false,
          fallbackReason: answerMode === "strict" && canLockAnswer && !isPageIntent ? "locked-rag-answer" : "none",
          model
        }
        if (cacheEnabled && !isPageIntent) {
          chatResponseCache.set(cacheKey, payload, cacheTtlMs)
        }
        return Response.json({ ...payload, cacheHit: false })
      } catch (err) {
        geminiFailed = true
        geminiSawRateLimit = geminiSawRateLimit || isRateLimitError(err)
        errors.push(err)
        console.error(`model attempt failed: gemini/${model}`, err)
      }
    }
  }

  const shouldUseZaiFallback = Boolean(zaiApiKey && geminiApiKey && geminiFailed)
  const shouldUseZaiPrimary = Boolean(zaiApiKey && !geminiApiKey)

  if ((shouldUseZaiFallback || shouldUseZaiPrimary) && zaiApiKey) {
    try {
      const answer = await generateWithZai(zaiApiKey, "glm-4.7-flash", prompt)
      const finalAnswerRaw = answerMode === "strict" && canLockAnswer && !isPageIntent ? makeDirectAnswerNatural(userQuestion, directAnswer) : answer
      const finalAnswer = enforceMaleTone(finalAnswerRaw)
      const fallbackReason = shouldUseZaiPrimary ? "zai-primary" : "gemini-failed"
      const payload: ChatApiSuccessPayload = {
        answer: finalAnswer,
        contextMatches: docs.length,
        fallbackUsed: Boolean(geminiApiKey),
        fallbackReason: answerMode === "strict" && canLockAnswer && !isPageIntent ? "locked-rag-answer" : fallbackReason,
        model: "glm-4.7-flash"
      }
      if (cacheEnabled && !isPageIntent) {
        chatResponseCache.set(cacheKey, payload, cacheTtlMs)
      }
      return Response.json({ ...payload, cacheHit: false })
    } catch (err) {
      errors.push(err)
      console.error("model attempt failed: zai/glm-4.7-flash", err)
    }
  }

  const fallbackItems = docs.map((doc) => docToText(doc)).filter(Boolean).slice(0, 3)
  const quotaLikeFailure = geminiApiKey ? geminiFailed && geminiSawRateLimit : false
  const fallbackPrefix = quotaLikeFailure ? "ตอนนี้โควต้า AI เต็มชั่วคราว" : "ตอนนี้ระบบ AI หลักขัดข้องชั่วคราว"
  const fallbackAnswer = fallbackItems.length
    ? `${fallbackPrefix} แต่เจอข้อมูลอ้างอิงที่เกี่ยวข้อง:\n- ${fallbackItems.join("\n- ")}`
    : `${fallbackPrefix} และยังไม่พบข้อมูลอ้างอิงที่ตรงคำถาม`

  if (errors.length > 0) {
    console.error("all model attempts failed", errors)
  }

  const finalFallbackReason = quotaLikeFailure ? "all-models-failed-after-rate-limit" : "all-models-failed"
  const fallbackPayload: ChatApiSuccessPayload = {
    answer: fallbackAnswer,
    contextMatches: docs.length,
    fallbackUsed: true,
    fallbackReason: finalFallbackReason,
    model: "context-fallback"
  }
  return Response.json({ ...fallbackPayload, cacheHit: false })
}