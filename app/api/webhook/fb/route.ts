import { NextResponse } from "next/server"
import { getEmbedding } from "@/app/lib/embedding"
import { getSupabaseClient } from "@/app/lib/supabase"

// ตั้งค่า Token ของ Facebook
const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN ?? "my_custom_verify_token" // ตั้งให้ตรงกับช่อง Token การยืนยัน
const FB_ACCESS_TOKEN = process.env.FB_ACCESS_TOKEN // โทเค็นเพจสำหรับส่งข้อความกลับ

// ==========================================
// 1. GET: สำหรับ Facebook ยิงมายืนยันตัวตนตอนผูก Webhook
// ==========================================
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const mode = searchParams.get("hub.mode")
  const token = searchParams.get("hub.verify_token")
  const challenge = searchParams.get("hub.challenge")

  if (mode === "subscribe" && token === FB_VERIFY_TOKEN) {
    console.log("✅ ยืนยัน Webhook สำเร็จ!")
    return new NextResponse(challenge, { status: 200 })
  }

  return new NextResponse("Forbidden", { status: 403 })
}

// ==========================================
// 2. POST: รับข้อมูลจาก Facebook (แชท และ โพสต์หน้าเพจ)
// ==========================================
export async function POST(req: Request) {
  try {
    const body = await req.json()

    if (body.object === "page") {
      for (const entry of body.entry) {
        
        // --------------------------------------------------
        // กรณีที่ 1: มีคนทักแชทเข้ามา (Messaging)
        // --------------------------------------------------
        if (entry.messaging) {
          const webhookEvent = entry.messaging[0]
          const senderPsid = webhookEvent.sender.id

          if (webhookEvent.message && webhookEvent.message.text) {
            const incomingText = webhookEvent.message.text
            console.log(`💬 ได้รับข้อความจาก ${senderPsid}: ${incomingText}`)

            // 💡 ตรงนี้คือจุดที่คุณต้องเอา incomingText ไปถาม AI ของคุณ (จำลองการดึงคำตอบเบื้องต้น)
            // ตัวอย่าง: โยงไปหา API ตัวเดิมที่คุณมีอยู่ (หรือจะดึงฟังก์ชันมาเขียนตรงนี้ก็ได้)
            const aiAnswer = await getAnswerFromYourAI(incomingText)
            
            // ส่งคำตอบกลับไปหาผู้ใช้ใน Facebook
            await sendFacebookReply(senderPsid, aiAnswer)
          }
        }

        // --------------------------------------------------
        // กรณีที่ 2: เพจมีการเคลื่อนไหว (เช่น โพสต์ใหม่) (Feed)
        // --------------------------------------------------
        if (entry.changes) {
          for (const change of entry.changes) {
            if (change.field === "feed") {
              const feedData = change.value
              
              // ตรวจสอบว่าเป็นโพสต์ใหม่ (add) และเป็นข้อความ/รูปภาพที่มีแคปชั่น
              if (feedData.verb === "add" && feedData.message) {
                const postText = feedData.message
                console.log("🔔 อัปเดตโพสต์ใหม่หน้าเพจ:", postText)

                // บันทึกโพสต์ลง Supabase เพื่ออัปเดตความรู้ให้ AI
                await savePostToSupabase(postText)
              }
            }
          }
        }
      }

      // ⚠️ กฎของ FB: ต้องตอบ 200 เสมอ ไม่ว่าประมวลผลเสร็จหรือ error ไม่งั้น FB จะยิงซ้ำ
      return NextResponse.json({ status: "EVENT_RECEIVED" }, { status: 200 })
    }

    return new NextResponse("Not Found", { status: 404 })
  } catch (error) {
    console.error("❌ Webhook POST Error:", error)
    return new NextResponse("Internal Server Error", { status: 500 })
  }
}

// ==========================================
// Helper 1: ส่งข้อความตอบกลับผู้ใช้ผ่าน Facebook API
// ==========================================
async function sendFacebookReply(senderPsid: string, text: string) {
  if (!FB_ACCESS_TOKEN) {
    console.error("⚠️ ขาดตัวแปร FB_ACCESS_TOKEN")
    return
  }

  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${FB_ACCESS_TOKEN}`
  const payload = {
    recipient: { id: senderPsid },
    message: { text: text }
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
    if (!res.ok) {
      const err = await res.text()
      console.error("❌ ส่งข้อความกลับ FB พลาด:", err)
    }
  } catch (error) {
    console.error("❌ Network Error ตอนส่งกลับ FB:", error)
  }
}

// ==========================================
// Helper 2: บันทึกโพสต์ใหม่ลง Supabase
// ==========================================
async function savePostToSupabase(text: string) {
  try {
    const supabase = getSupabaseClient()
    const embedding = await getEmbedding(text)
    const formattedContent = `[ประกาศหน้าเพจล่าสุด] ${text}`

    // Insert ลงตาราง documents (แก้ไขชื่อตารางตามที่คุณตั้งไว้ใน Supabase)
    const { error } = await supabase.from("documents").insert({
      content: formattedContent,
      embedding: embedding
    })

    if (error) {
      console.error("❌ บันทึกลง Supabase ไม่สำเร็จ:", error.message)
    } else {
      console.log("✅ อัปเดตประกาศใหม่ลง RAG สำเร็จ!")
    }
  } catch (error) {
    console.error("❌ เกิดข้อผิดพลาดตอนอัปเดต Supabase:", error)
  }
}

// ==========================================
// Helper 3: ฟังก์ชันจำลองการเรียก AI ของคุณ
// ==========================================
async function getAnswerFromYourAI(question: string) {
  // 💡 วิธีที่ง่ายที่สุดคือ ยิง API ไปหา Route ไฟล์แรกของคุณเองครับ (เปลี่ยน URL ตามจริง)
  // หรือถ้าระบบผูกกันยาก ให้เขียนโค้ดดึงข้อมูล Supabase และเรียก Gemini คล้ายๆ ไฟล์แรกมาใส่ตรงนี้ได้เลยครับ
  try {
    /* const res = await fetch("https://โดเมนของคุณ.com/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, mode: "balanced" })
    })
    const data = await res.json()
    return data.answer || "ระบบกำลังประมวลผล โปรดลองอีกครั้งครับ"
    */
    return "ได้รับคำถามแล้ว: " + question + " (ระบบ AI กำลังเชื่อมต่อ...)"
  } catch (err) {
    return "ขออภัยครับ ระบบไม่สามารถตอบกลับได้ในขณะนี้"
  }
}