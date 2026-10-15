-- Remove unrestricted anonymous read access to AI state tables.
-- Backend service-role access continues to bypass RLS as intended.

drop policy if exists ponyo_read_ai_chat on public.ai_chat;
drop policy if exists ponyo_read_ai_answers on public.ai_answers;
drop policy if exists ponyo_read_ai_conversations on public.ai_conversations;

alter table public.ai_chat enable row level security;
alter table public.ai_answers enable row level security;
alter table public.ai_conversations enable row level security;
