# rag-upchat

แอปแชต RAG (Next.js) ที่ใช้:
- Cloudflare AI (`@cf/baai/bge-m3`) สำหรับ embedding
- Supabase (Postgres + pgvector) สำหรับ vector search
- Gemini (`gemini-2.5-flash`) สำหรับตอบคำถาม
- Fallback model: z.ai (`glm-4.7-flash`) เมื่อ Gemini ติด quota/rate-limit

## โครงสร้างหลัก

- `app/page.tsx` หน้าแชต
- `app/api/chat/route.ts` endpoint ตอบคำถามด้วย RAG + Gemini
- `app/api/embed/route.ts` endpoint สำหรับสร้าง embedding
- `app/lib/embedding.ts` helper เรียก Cloudflare embedding
- `app/lib/supabase.ts` helper สร้าง Supabase client จาก env
- `scripts/embed.mjs` สคริปต์ฝัง embedding ให้ข้อมูลในตาราง `documents`

## 1) ติดตั้ง

```bash
npm install
```

## 2) ตั้งค่า Environment

สร้างไฟล์ `.env.local`:

```env
GEMINI_API_KEY=...
GEMINI_MODEL_CHAIN=gemini-2.5-flash
ZAI_API_KEY=...
MODEL_TIMEOUT_MS=6000
LLM_MAX_LATENCY_MS=8000
ENABLE_CHAT_RESPONSE_CACHE=false
CHAT_RESPONSE_CACHE_TTL_MS=60000
RAG_DIRECT_ANSWER_SIMILARITY=0.75
RAG_LOCK_ANSWER_SIMILARITY=0.65
RAG_LOCK_LEXICAL_MIN=0.25
RAG_LOCK_GAP_MIN=0.04
PROHIBITED_KEYWORDS=keyword1,keyword2
ENABLE_OUT_OF_SCOPE_GUARDRAIL=false
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
CF_ACCOUNT_ID=...
CF_API_TOKEN=...
```

## 3) เตรียมฐานข้อมูล Supabase

ถ้าระบบเดิมยังใช้คอลัมน์ `question/answer` ให้รัน migration นี้ก่อน:

```sql
-- copy เนื้อหาจากไฟล์:
-- supabase/migrations/20260315_unify_documents_content_and_rag.sql
-- supabase/migrations/20260318_add_user_roles.sql
```

รัน SQL นี้ใน Supabase SQL Editor:

```sql
create extension if not exists vector;

create table if not exists documents (
  id bigserial primary key,
  content text not null,
  embedding vector(1024)
);

create or replace function match_documents(
  query_embedding vector(1024),
  match_threshold float default 0.7,
  match_count int default 3
)
returns table (
  id bigint,
  content text,
  similarity float
)
language sql
as $$
  select
    documents.id,
    documents.content,
    1 - (documents.embedding <=> query_embedding) as similarity
  from documents
  where documents.embedding is not null
    and 1 - (documents.embedding <=> query_embedding) > match_threshold
  order by documents.embedding <=> query_embedding
  limit match_count;
$$;
```

เพิ่มตาราง memory แชท (สำหรับจำข้ามอุปกรณ์เมื่อ login):

```sql
create table if not exists chat_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references chat_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user','bot')),
  content text not null,
  created_at timestamptz not null default now()
);

alter table chat_conversations enable row level security;
alter table chat_messages enable row level security;

create policy "users own conversations"
on chat_conversations for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "users own messages"
on chat_messages for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
```

## 4) ใส่ข้อมูลคำถาม/คำตอบ

นำเข้า `data.csv` ลงตาราง `documents` (แนะนำให้เป็นคอลัมน์ `content`)
ตัวอย่าง format:
- `คำถาม: ... คำตอบ: ...`

## 5) สร้าง embedding ให้เอกสาร

```bash
npm run embed:all
```

## 6) รันโปรเจกต์

```bash
npm run dev
```

เปิด `http://localhost:3000`

## 7) จัดการข้อมูล RAG ผ่านหน้า Admin

- เปิด `http://localhost:3000/admin`
- เข้าระบบด้วย Supabase Auth (email/password)
- ระบบใช้ RBAC ผ่านตาราง `user_roles` (role ที่อนุญาตเข้า admin: `admin`, `super_admin`)
- หน้า Admin รองรับ:
  - ค้นหา/เพิ่ม/แก้ไข/ลบ เอกสารในตาราง `documents`
  - Re-embed รายเอกสาร หรือ Re-embed ทั้งระบบ
  - นำเข้า CSV (`question,answer`) และสั่ง embed ทันทีได้
  - Dashboard metrics (total/embedded/pending/latest id)

ต้องตั้งค่า:
- `SUPABASE_SERVICE_ROLE_KEY` (จำเป็น)
- เพิ่ม role ให้ผู้ดูแลอย่างน้อย 1 คน:

```sql
insert into public.user_roles (user_id, role)
values ('<SUPABASE_USER_UUID>', 'super_admin')
on conflict (user_id) do update set role = excluded.role;
```

## 8) รันทดสอบ

```bash
npm run test:run
npm run lint
npm run build
npm run test:e2e
```

## 9) Guardrails (No-Login Mode)

- Model timeout: ตัดคำขอโมเดลที่ช้าเกินกำหนดผ่าน `MODEL_TIMEOUT_MS`
- Response cache: เปิด/ปิดด้วย `ENABLE_CHAT_RESPONSE_CACHE` และกำหนด TTL ผ่าน `CHAT_RESPONSE_CACHE_TTL_MS`
- Shared runtime state: ถ้าตั้งค่า Upstash Redis จะใช้ state ร่วมกันข้าม instance สำหรับ state ที่ต้องแชร์ (ถ้าไม่ตั้งจะ fallback เป็น memory)
- Prohibited keywords: block ก่อนถึง LLM ผ่าน `PROHIBITED_KEYWORDS`
- Out-of-scope rule: ถ้าคำถามนอกขอบเขตและไม่ match ฐานความรู้เพียงพอ ระบบจะปฏิเสธแบบสุภาพ

## หมายเหตุ

- โค้ดถูกปรับให้ `build` ผ่านแล้วและไม่ hardcode `http://localhost:3000` ใน API ภายใน
- ถ้า env ไม่ครบ API จะตอบ error ชัดเจนแทนพังตอน build
