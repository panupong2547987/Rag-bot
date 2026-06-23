"use client"

import { useEffect, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from "react"
import Link from "next/link"
import Image from "next/image"
import {
  Plus, Search, Pin, PinOff, Edit2, Trash2, ArrowUp, ArrowDown,
  Settings, LogOut, RotateCcw, Eraser, PanelLeft, PanelLeftClose, X
} from "lucide-react"
import AppToast from "@/app/components/app-toast"
import ChatComposer from "@/app/components/chat-composer"
import ChatShell from "@/app/components/chat-shell"
import ChatStatus from "@/app/components/chat-status"
import MessageList from "@/app/components/message-list"
import {
  appendConversationMessage,
  clearConversation,
  createConversation,
  deleteConversation,
  getCurrentUser,
  listConversations,
  loadConversationMessages,
  loadGuestMessages,
  loadPinnedConversationIds,
  renameConversation,
  savePinnedConversationIds,
  saveGuestMessages,
  signOut,
  type ConversationSummary
} from "@/app/lib/chat-memory"
import type { ChatMessage } from "@/app/lib/chat-types"
import { deriveConversationTitle, isAutoTitleCandidate } from "@/app/lib/conversation-title"

const ERROR_MESSAGE = "ไม่สามารถเชื่อมต่อระบบได้ กรุณาลองใหม่อีกครั้ง"

type ToastState = {
  kind: "info" | "success" | "error"
  text: string
}

type ReplyMeta = {
  model?: string
  fallbackReason?: string
  contextMatches?: number
  cacheHit?: boolean
}

function makeMessage(role: ChatMessage["role"], text: string): ChatMessage {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role,
    text,
    createdAt: new Date().toISOString()
  }
}

// --- ชุดคำถามตายตัวที่เรากำหนดเอง (อัปเดตปุ่มที่ 3 เป็นปฏิทินการศึกษา) ---
const CUSTOM_STATIC_QUESTIONS = [
  "เอกสารที่ต้องใช้สำหรับผู้กู้รายใหม่มีอะไรบ้าง / รายใหม่ใช้เอกสารอะไรบ้าง",
  "เอกสารที่ต้องใช้สำหรับผู้กู้รายเก่า / รายเก่าใช้เอกสารอะไรบ้าง",
  "ปฏิทินการศึกษาล่าสุด / กำหนดการลงทะเบียนเรียน"
]
// ------------------------------

export default function Page() {
  const [question, setQuestion] = useState("")
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastQuestion, setLastQuestion] = useState("")
  const [lastReplyMeta, setLastReplyMeta] = useState<ReplyMeta | null>(null)

  const [userId, setUserId] = useState<string | null>(null)
  const [userEmail, setUserEmail] = useState<string | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [loadingConversations, setLoadingConversations] = useState(false)
  const [sidebarQuery, setSidebarQuery] = useState("")
  const [renamingConversationId, setRenamingConversationId] = useState<string | null>(null)
  const [renamingTitle, setRenamingTitle] = useState("")
  const [pinnedConversationIds, setPinnedConversationIds] = useState<string[]>([])
  const [sidebarVisible, setSidebarVisible] = useState(false)
  const [hasBrandLogo, setHasBrandLogo] = useState(true)
  const [pendingDeleteConversation, setPendingDeleteConversation] = useState<ConversationSummary | null>(null)
  const [isDeletingConversation, setIsDeletingConversation] = useState(false)
  const sidebarSearchRef = useRef<HTMLInputElement | null>(null)

  const [booting, setBooting] = useState(true)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [quickQuestionsVisible, setQuickQuestionsVisible] = useState(true)
  const [isQuickDragging, setIsQuickDragging] = useState(false)
  const quickQuestionsRef = useRef<HTMLElement | null>(null)
  const quickDragRef = useRef({
    active: false,
    startX: 0,
    scrollLeft: 0,
    pointerId: -1
  })

  // --- กำหนดให้โชว์ปุ่มเฉพาะตอนเริ่มแชทใหม่เท่านั้น ---
  const quickQuestions = useMemo(
    () => (messages.length === 0 ? CUSTOM_STATIC_QUESTIONS : []),
    [messages.length]
  )
  // ------------------------------------------

  const filteredConversations = useMemo(() => {
    const query = sidebarQuery.trim().toLowerCase()
    if (!query) return conversations
    return conversations.filter((item) => item.title.toLowerCase().includes(query))
  }, [conversations, sidebarQuery])
  const orderedConversations = useMemo(() => {
    if (pinnedConversationIds.length === 0) return filteredConversations
    const pinnedSet = new Set(pinnedConversationIds)
    const pinnedOrder = new Map(pinnedConversationIds.map((id, index) => [id, index]))
    return [...filteredConversations].sort((a, b) => {
      const aPinned = pinnedSet.has(a.id)
      const bPinned = pinnedSet.has(b.id)
      if (aPinned && bPinned) {
        return (pinnedOrder.get(a.id) ?? 0) - (pinnedOrder.get(b.id) ?? 0)
      }
      if (aPinned) return -1
      if (bPinned) return 1
      return 0
    })
  }, [filteredConversations, pinnedConversationIds])
  const pinnedConversationSet = useMemo(() => new Set(pinnedConversationIds), [pinnedConversationIds])

  function showToast(kind: ToastState["kind"], text: string) {
    setToast({ kind, text })
    setTimeout(() => setToast(null), 3000)
  }

  async function reloadConversations(nextUserId: string) {
    setLoadingConversations(true)
    try {
      const rows = await listConversations(nextUserId)
      setConversations(rows)
      return rows
    } finally {
      setLoadingConversations(false)
    }
  }

  async function openConversation(nextConversationId: string) {
    setConversationId(nextConversationId)
    const loaded = await loadConversationMessages(nextConversationId)
    setMessages(loaded)
    if (typeof window !== "undefined" && window.innerWidth <= 980) {
      setSidebarVisible(false)
    }
  }

  useEffect(() => {
    setMessages(loadGuestMessages())

    getCurrentUser()
      .then(async (user) => {
        if (!user) {
          return
        }

        setUserId(user.id)
        setUserEmail(user.email ?? null)

        let rows = await reloadConversations(user.id)
        if (!rows.length) {
          const first = await createConversation(user.id, "การสนทนาใหม่")
          rows = [first]
          setConversations(rows)
        }

        await openConversation(rows[0].id)
        showToast("info", "โหลดประวัติการสนทนาจากคลาวด์สำเร็จ")
      })
      .catch((initError) => {
        const message = initError instanceof Error ? initError.message : "การตรวจสอบสิทธิ์ล้มเหลว"
        showToast("error", message)
      })
      .finally(() => {
        setBooting(false)
      })
  }, [])

  useEffect(() => {
    if (userId) {
      return
    }

    saveGuestMessages(messages)
  }, [messages, userId])

  useEffect(() => {
    if (!userId) {
      setPinnedConversationIds([])
      return
    }

    setPinnedConversationIds(loadPinnedConversationIds(userId))
  }, [userId])

  useEffect(() => {
    if (!userId) {
      return
    }

    savePinnedConversationIds(userId, pinnedConversationIds)
  }, [pinnedConversationIds, userId])

  useEffect(() => {
    if (conversations.length === 0) {
      return
    }

    const validIds = new Set(conversations.map((item) => item.id))
    setPinnedConversationIds((prev) => prev.filter((id) => validIds.has(id)))
  }, [conversations])

  useEffect(() => {
    if (!pendingDeleteConversation) return
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !isDeletingConversation) {
        setPendingDeleteConversation(null)
      }
    }
    window.addEventListener("keydown", handleEscape)
    return () => window.removeEventListener("keydown", handleEscape)
  }, [pendingDeleteConversation, isDeletingConversation])

  async function saveCloudMessage(message: ChatMessage) {
    if (!conversationId || !userId) {
      return
    }

    await appendConversationMessage(conversationId, userId, message)
  }

  async function ask(nextQuestion?: string, options?: { retry?: boolean }) {
    const prompt = (nextQuestion ?? question).trim()

    if (!prompt || isLoading) {
      return
    }

    const fromRetry = Boolean(options?.retry)
    setError(null)
    setIsLoading(true)
    setLastQuestion(prompt)

    const userMsg = makeMessage("user", prompt)

    if (!fromRetry) {
      setQuestion("")
      setMessages((prev) => [...prev, userMsg])
      saveCloudMessage(userMsg).catch(() => {
        showToast("error", "บันทึกเฉพาะในอุปกรณ์ (ซิงค์คลาวด์ล้มเหลว)")
      })

      if (userId && conversationId) {
        const active = conversations.find((row) => row.id === conversationId)
        if (active && isAutoTitleCandidate(active.title)) {
          const nextTitle = deriveConversationTitle(prompt)
          setConversations((prev) => prev.map((row) => (row.id === conversationId ? { ...row, title: nextTitle } : row)))
          renameConversation(conversationId, nextTitle).catch(() => {
            showToast("error", "ไม่สามารถอัปเดตชื่อการสนทนาได้")
          })
        }
      }
    }

    try {
      const history = fromRetry
        ? messages.map((m) => ({ role: m.role, text: m.text }))
        : [...messages, userMsg].map((m) => ({ role: m.role, text: m.text }))
      const compactHistory = history.slice(-8)

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Chat-Scope": userId ? "user" : "guest"
        },
        body: JSON.stringify({ question: prompt, history: compactHistory, mode: "strict" })
      })

      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string; retryAfterSec?: number }
        const retrySuffix = payload.retryAfterSec ? ` (ลองใหม่ใน ${payload.retryAfterSec}s)` : ""
        throw new Error(payload.error ? `${payload.error}${retrySuffix}` : `คำขอขัดข้อง: ${res.status}`)
      }

      const data = (await res.json()) as {
        answer?: string
        model?: string
        fallbackReason?: string
        contextMatches?: number
        cacheHit?: boolean
      }
      const answer = data.answer

      if (!answer) {
        throw new Error("ไม่มีข้อมูลตอบกลับจากระบบ")
      }

      const botMsg = makeMessage("bot", answer)
      setMessages((prev) => [...prev, botMsg])
      setLastReplyMeta({
        model: data.model,
        fallbackReason: data.fallbackReason,
        contextMatches: data.contextMatches,
        cacheHit: data.cacheHit
      })

      await saveCloudMessage(botMsg).catch(() => {
        showToast("error", "บันทึกเฉพาะในอุปกรณ์ (ซิงค์คลาวด์ล้มเหลว)")
      })

      if (userId) {
        await reloadConversations(userId)
      }
    } catch (apiError) {
      const message = apiError instanceof Error ? apiError.message : ""
      const exposeMessage =
        /too many requests|blocked by policy|คำขอขัดข้อง|ลองใหม่ใน|โควต้ารายวัน|missing/i.test(message)
      setError(exposeMessage ? message : ERROR_MESSAGE)
    } finally {
      setIsLoading(false)
    }
  }

  async function handleLogout() {
    await signOut()
    setUserId(null)
    setUserEmail(null)
    setConversationId(null)
    setConversations([])
    showToast("info", "ออกจากระบบแล้ว กลับสู่โหมดผู้เยี่ยมชม")
  }

  async function handleNewConversation() {
    if (!userId) {
      setMessages([])
      setQuestion("")
      setError(null)
      setLastQuestion("")
      showToast("info", "เริ่มแชทใหม่แล้ว (โหมดผู้เยี่ยมชมจะไม่บันทึกหลายรายการ)")
      return
    }

    try {
      const created = await createConversation(userId, "การสนทนาใหม่")
      setConversations((prev) => [created, ...prev])
      setConversationId(created.id)
      setMessages([])
      setError(null)
      setLastQuestion("")
      if (typeof window !== "undefined" && window.innerWidth <= 980) {
        setSidebarVisible(false)
      }
      showToast("success", "เริ่มการสนทนาใหม่แล้ว")
    } catch (createError) {
      const message = createError instanceof Error ? createError.message : "ไม่สามารถสร้างการสนทนาได้"
      showToast("error", message)
    }
  }

  function requestDeleteConversation(conversation: ConversationSummary) {
    setPendingDeleteConversation(conversation)
  }

  async function handleDeleteConversation() {
    if (!userId || !pendingDeleteConversation || isDeletingConversation) return
    const conversation = pendingDeleteConversation
    setIsDeletingConversation(true)
    try {
      await deleteConversation(conversation.id)
      setPinnedConversationIds((prev) => prev.filter((id) => id !== conversation.id))
      const rows = await reloadConversations(userId)

      if (!rows.length) {
        const created = await createConversation(userId, "การสนทนาใหม่")
        setConversations([created])
        await openConversation(created.id)
      } else {
        const next = rows[0]
        await openConversation(next.id)
      }

      setPendingDeleteConversation(null)
      showToast("success", "ลบการสนทนาสำเร็จ")
    } catch (deleteError) {
      const message = deleteError instanceof Error ? deleteError.message : "ไม่สามารถลบการสนทนาได้"
      showToast("error", message)
    } finally {
      setIsDeletingConversation(false)
    }
  }

  function handleTogglePin(conversationIdValue: string) {
    setPinnedConversationIds((prev) => {
      if (prev.includes(conversationIdValue)) {
        return prev.filter((id) => id !== conversationIdValue)
      }

      return [conversationIdValue, ...prev]
    })
  }

  function handleMovePinned(conversationIdValue: string, direction: "up" | "down") {
    setPinnedConversationIds((prev) => {
      const index = prev.indexOf(conversationIdValue)
      if (index === -1) return prev

      const target = direction === "up" ? index - 1 : index + 1
      if (target < 0 || target >= prev.length) return prev

      const next = [...prev]
      const [moved] = next.splice(index, 1)
      next.splice(target, 0, moved)
      return next
    })
  }

  function startRename(conversation: ConversationSummary) {
    setRenamingConversationId(conversation.id)
    setRenamingTitle(conversation.title)
  }

  function cancelRename() {
    setRenamingConversationId(null)
    setRenamingTitle("")
  }

  async function saveRename(conversation: ConversationSummary) {
    if (!userId) return
    const nextTitle = renamingTitle.trim()

    if (!nextTitle || nextTitle === conversation.title) {
      cancelRename()
      return
    }

    try {
      await renameConversation(conversation.id, nextTitle)
      setConversations((prev) => prev.map((row) => (row.id === conversation.id ? { ...row, title: nextTitle } : row)))
      cancelRename()
      await reloadConversations(userId)
      showToast("success", "เปลี่ยนชื่อการสนทนาสำเร็จ")
    } catch (renameError) {
      const message = renameError instanceof Error ? renameError.message : "ไม่สามารถเปลี่ยนชื่อการสนทนาได้"
      showToast("error", message)
    }
  }

  async function clearChat() {
    setMessages([])
    setQuestion("")
    setError(null)
    setLastQuestion("")

    if (conversationId) {
      try {
        await clearConversation(conversationId)
      } catch {
        showToast("error", "ล้างข้อมูลบนคลาวด์ล้มเหลว ล้างเฉพาะข้อมูลในอุปกรณ์")
      }
    }
  }

  function focusSidebarSearch() {
    setSidebarVisible(true)
    window.setTimeout(() => {
      sidebarSearchRef.current?.focus()
    }, 0)
  }

  function handleQuickPointerDown(event: PointerEvent<HTMLElement>) {
    if (event.pointerType !== "mouse" || event.button !== 0) {
      return
    }

    const target = event.target as HTMLElement | null
    if (target?.closest("button")) {
      return
    }

    const container = quickQuestionsRef.current
    if (!container) return

    quickDragRef.current = {
      active: true,
      startX: event.clientX,
      scrollLeft: container.scrollLeft,
      pointerId: event.pointerId
    }

    setIsQuickDragging(false)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function handleQuickPointerMove(event: PointerEvent<HTMLElement>) {
    const container = quickQuestionsRef.current
    const state = quickDragRef.current
    if (!container || !state.active || event.pointerId !== state.pointerId) {
      return
    }

    const deltaX = event.clientX - state.startX
    if (Math.abs(deltaX) > 4) {
      setIsQuickDragging(true)
    }
    container.scrollLeft = state.scrollLeft - deltaX
  }

  function stopQuickPointerDrag(event: PointerEvent<HTMLElement>) {
    const state = quickDragRef.current
    if (event.pointerId !== state.pointerId) {
      return
    }

    state.active = false
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // Ignore capture release errors when pointer is already released.
    }

    window.setTimeout(() => {
      setIsQuickDragging(false)
    }, 0)
  }

  function handleQuickWheel(event: WheelEvent<HTMLElement>) {
    const container = quickQuestionsRef.current
    if (!container) return

    const mostlyVertical = Math.abs(event.deltaY) >= Math.abs(event.deltaX)
    const canScrollHorizontally = container.scrollWidth > container.clientWidth
    if (!mostlyVertical || !canScrollHorizontally) return

    container.scrollLeft += event.deltaY
    event.preventDefault()
  }

  if (booting) {
    return (
      <ChatShell>
        <p className="chat-status">กำลังเตรียมพร้อมระบบ...</p>
      </ChatShell>
    )
  }

  return (
    <ChatShell>
      <div className={`chat-workspace ${sidebarVisible ? "sidebar-open" : ""}`}>
        <aside className="chat-sidebar">
          <div className="chat-sidebar-brand">
            <p>ประวัติการสนทนา</p>
          </div>

          {!userId ? (
            <p className="chat-status sidebar-status">โหมดผู้เยี่ยมชม: เข้าสู่ระบบเพื่อดูประวัติการสนทนา</p>
          ) : loadingConversations ? (
            <div className="sidebar-skeleton">
              <span />
              <span />
              <span />
            </div>
          ) : conversations.length === 0 ? (
            <p className="chat-status sidebar-status">ยังไม่มีประวัติการสนทนา</p>
          ) : (
            <ul className="conversation-list">
              <li>
                <input
                  type="search"
                  className="sidebar-search"
                  placeholder="ค้นหาการสนทนา..."
                  value={sidebarQuery}
                  ref={sidebarSearchRef}
                  onChange={(event) => setSidebarQuery(event.target.value)}
                />
              </li>
              {orderedConversations.length === 0 ? (
                <li>
                  <p className="chat-status sidebar-status">ไม่พบการสนทนาที่ค้นหา</p>
                </li>
              ) : null}
              {orderedConversations.map((item) => (
                <li key={item.id}>
                  {renamingConversationId === item.id ? (
                    <div className="conversation-rename">
                      <input
                        type="text"
                        className="sidebar-search"
                        value={renamingTitle}
                        onChange={(event) => setRenamingTitle(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault()
                            void saveRename(item)
                          }

                          if (event.key === "Escape") {
                            event.preventDefault()
                            cancelRename()
                          }
                        }}
                        autoFocus
                      />
                      <div className="conversation-row-actions">
                        <button type="button" className="conversation-action" onClick={() => void saveRename(item)}>
                          บันทึก
                        </button>
                        <button type="button" className="conversation-action" onClick={cancelRename}>
                          ยกเลิก
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <button
                        type="button"
                        className={`conversation-item ${conversationId === item.id ? "active" : ""}`}
                        onClick={() => openConversation(item.id)}
                      >
                        <span style={{ display: "flex", alignItems: "center", gap: "6px", fontWeight: pinnedConversationSet.has(item.id) ? 500 : 400 }}>
                          {pinnedConversationSet.has(item.id) && <Pin size={12} color="var(--accent)" />}
                          {item.title}
                        </span>
                        <time>{new Date(item.updatedAt).toLocaleString("th-TH", { month: "short", day: "numeric", year: "numeric" })}</time>
                      </button>
                      <div className="conversation-row-actions conversation-row-actions-inline">
                        <button type="button" className="conversation-action" onClick={() => handleTogglePin(item.id)} title={pinnedConversationSet.has(item.id) ? "เลิกปักหมุด" : "ปักหมุด"}>
                          {pinnedConversationSet.has(item.id) ? <PinOff size={14} /> : <Pin size={14} />}
                          <span>{pinnedConversationSet.has(item.id) ? "เลิกปักหมุด" : "ปักหมุด"}</span>
                        </button>
                        <button type="button" className="conversation-action" onClick={() => startRename(item)} title="เปลี่ยนชื่อ">
                          <Edit2 size={14} />
                          <span>เปลี่ยนชื่อ</span>
                        </button>
                        <button type="button" className="conversation-delete conversation-delete-wide" onClick={() => requestDeleteConversation(item)} title="ลบการสนทนา">
                          <Trash2 size={14} />
                          <span>ลบ</span>
                        </button>
                      </div>
                      {pinnedConversationSet.has(item.id) ? (
                        <div className="conversation-reorder">
                          <button
                            type="button"
                            className="conversation-action"
                            onClick={() => handleMovePinned(item.id, "up")}
                            disabled={pinnedConversationIds.indexOf(item.id) <= 0}
                            title="เลื่อนขึ้น"
                          >
                            <ArrowUp size={14} />
                          </button>
                          <button
                            type="button"
                            className="conversation-action"
                            onClick={() => handleMovePinned(item.id, "down")}
                            disabled={pinnedConversationIds.indexOf(item.id) === pinnedConversationIds.length - 1}
                            title="เลื่อนลง"
                          >
                            <ArrowDown size={14} />
                          </button>
                        </div>
                      ) : null}
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </aside>

        <div className="chat-main">
          <header className="chat-header">
            <div className="chat-header-top">
              <div className="chat-brand">
                <div className="brand-crest" aria-hidden="true">
                  {hasBrandLogo ? (
                    <Image
                      src="/logo/up-logo.svg"
                      alt=""
                      className="brand-logo-image"
                      width={44}
                      height={44}
                      onError={() => setHasBrandLogo(false)}
                    />
                  ) : (
                    <span>มพ</span>
                  )}
                </div>
                <div className="brand-copy">
                  <p className="chat-kicker">มหาวิทยาลัยพะเยา</p>
                  {/* --- ปรับชื่อและคำอธิบาย --- */}
                  <h1>UPChat: ผู้ช่วย AI งานทะเบียนและ กยศ.</h1>
                  <p className="chat-subtitle">สอบถามข้อมูลปฏิทินการศึกษา ขั้นตอนการกู้ยืม กยศ. (รายใหม่/รายเก่า) และการลงทะเบียนเรียน</p>
                </div>
              </div>
              <div className="header-meta">
                <a className="admin-link" href="/admin">
                  <Settings size={14} />
                  ผู้ดูแลระบบ
                </a>
                {userEmail ? (
                  <button className="ghost-button" type="button" onClick={handleLogout}>
                    <LogOut size={14} />
                    ออกจากระบบ
                  </button>
                ) : null}
              </div>
            </div>
            <p className="chat-note">รองรับทั้งโหมดผู้เยี่ยมชมและสมาชิก เพื่อเก็บประวัติการสนทนาและซิงค์ข้ามอุปกรณ์อย่างต่อเนื่อง</p>
          </header>

          {!userEmail ? (
            <section className="auth-strip auth-strip-links">
              <p className="auth-cta-text">ต้องการบันทึกประวัติและซิงค์ข้ามอุปกรณ์?</p>
              <Link href="/login?next=%2F" className="auth-link-button">
                เข้าสู่ระบบ
              </Link>
              <Link href="/signup?next=%2F" className="ghost-button">
                สมัครสมาชิก
              </Link>
            </section>
          ) : null}

          <MessageList messages={messages} />

          <div className="chat-toolbar">
            <div>
              <ChatStatus isLoading={isLoading} error={error} />
              {lastReplyMeta ? (
                <p className="chat-status" data-testid="reply-meta">
                  model: {lastReplyMeta.model ?? "-"} | reason: {lastReplyMeta.fallbackReason ?? "-"} | matches:{" "}
                  {String(lastReplyMeta.contextMatches ?? 0)} | cache: {String(Boolean(lastReplyMeta.cacheHit))}
                </p>
              ) : null}
              {toast ? <AppToast kind={toast.kind} text={toast.text} /> : null}
            </div>
            <div className="chat-actions">
              {error && lastQuestion ? (
                <button type="button" data-testid="retry-button" className="ghost-button" onClick={() => ask(lastQuestion, { retry: true })}>
                  <RotateCcw size={14} />
                  ลองใหม่
                </button>
              ) : null}
              <button
                type="button"
                data-testid="clear-chat-button"
                className="ghost-button"
                onClick={clearChat}
                disabled={messages.length === 0 && !question && !error}
              >
                <Eraser size={14} />
                ล้างแชท
              </button>
            </div>
          </div>

          <div className="quick-questions-row">
            {quickQuestionsVisible && quickQuestions.length > 0 ? (
              <section
                ref={quickQuestionsRef}
                className={`quick-questions quick-questions-bottom ${isQuickDragging ? "is-dragging" : ""}`}
                aria-label="คำถามแนะนำ"
                onPointerDown={handleQuickPointerDown}
                onPointerMove={handleQuickPointerMove}
                onPointerUp={stopQuickPointerDrag}
                onPointerCancel={stopQuickPointerDrag}
                onPointerLeave={stopQuickPointerDrag}
                onWheel={handleQuickWheel}
              >
                {quickQuestions.slice(0, 5).map((item, index) => (
                  <button
                    key={`${item}-${index}`}
                    type="button"
                    className="ghost-button"
                    disabled={isLoading}
                    onClick={() => void ask(item)}
                  >
                    {item}
                  </button>
                ))}
              </section>
            ) : null}

            {quickQuestions.length > 0 ? (
              <div className="quick-questions-control">
                <button
                  type="button"
                  className="quick-toggle-button"
                  aria-label={quickQuestionsVisible ? "ซ่อนคำถามแนะนำ" : "แสดงคำถามแนะนำ"}
                  title={quickQuestionsVisible ? "ซ่อนคำถามแนะนำ" : "แสดงคำถามแนะนำ"}
                  onClick={() => setQuickQuestionsVisible((prev) => !prev)}
                >
                  {quickQuestionsVisible ? <X size={14} /> : <Plus size={14} />}
                </button>
              </div>
            ) : null}
          </div>

          <ChatComposer value={question} disabled={isLoading} onChange={setQuestion} onSubmit={() => ask()} />
        </div>
      </div>

      <aside className="sidebar-dock" aria-label="แถบเครื่องมือการสนทนา">
        <div className="dock-top">
          <span className="dock-logo-mark" aria-hidden="true">
            <Image src="/logo/up-logo.svg" alt="" width={24} height={24} />
          </span>
        </div>
        <div className="dock-main">
          <button
            type="button"
            className="dock-button"
            title={sidebarVisible ? "ซ่อนประวัติ" : "แสดงประวัติ"}
            aria-label={sidebarVisible ? "ซ่อนประวัติ" : "แสดงประวัติ"}
            onClick={() => setSidebarVisible((prev) => !prev)}
          >
            {sidebarVisible ? <PanelLeftClose size={18} /> : <PanelLeft size={18} />}
          </button>
          <button
            type="button"
            className="dock-button"
            title="เริ่มแชทใหม่"
            aria-label="เริ่มแชทใหม่"
            onClick={() => void handleNewConversation()}
          >
            <Plus size={18} />
          </button>
          <button
            type="button"
            className="dock-button"
            title="ค้นหาในประวัติ"
            aria-label="ค้นหาในประวัติ"
            onClick={focusSidebarSearch}
          >
            <Search size={18} />
          </button>
        </div>
        <div className="dock-bottom">
          <span className="dock-avatar">{userEmail ? userEmail.slice(0, 1).toUpperCase() : "UP"}</span>
        </div>
      </aside>

      {pendingDeleteConversation ? (
        <div
          className="admin-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="ยืนยันการลบการสนทนา"
          onClick={() => {
            if (!isDeletingConversation) setPendingDeleteConversation(null)
          }}
        >
          <div className="admin-modal" onClick={(event) => event.stopPropagation()}>
            <h3>ยืนยันการลบการสนทนา</h3>
            <p>
              ต้องการลบ &quot;<strong>{pendingDeleteConversation.title}</strong>&quot; ใช่หรือไม่?
            </p>
            <div className="admin-modal-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => setPendingDeleteConversation(null)}
                disabled={isDeletingConversation}
              >
                ยกเลิก
              </button>
              <button
                type="button"
                className="auth-link-button"
                onClick={() => void handleDeleteConversation()}
                disabled={isDeletingConversation}
              >
                {isDeletingConversation ? "กำลังลบ..." : "ยืนยันการลบ"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </ChatShell>
  )
}