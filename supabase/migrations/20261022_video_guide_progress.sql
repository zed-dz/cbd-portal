-- 20261022_video_guide_progress.sql
-- Video guide progress per person (owner 2026-10-22: "save the watched ticks per person").
-- One row per worker + chapter. A person reads and writes only their own rows; the
-- office can read everyone's (to see who has watched what). Additive only.
create table if not exists public.video_guide_progress (
  worker_id   uuid not null references public.workers(id) on delete cascade,
  chapter     text not null check (char_length(chapter) between 1 and 40),
  watched_at  timestamptz not null default now(),
  primary key (worker_id, chapter)
);
create index if not exists video_guide_progress_chapter_idx on public.video_guide_progress (chapter);

alter table public.video_guide_progress enable row level security;
drop policy if exists "video_guide_progress own all" on public.video_guide_progress;
create policy "video_guide_progress own all" on public.video_guide_progress
  for all to authenticated
  using (worker_id = (select public.current_worker_id()))
  with check (worker_id = (select public.current_worker_id()));
drop policy if exists "video_guide_progress office read" on public.video_guide_progress;
create policy "video_guide_progress office read" on public.video_guide_progress
  for select to authenticated using ((select public.is_office_user()));
grant select, insert, update, delete on public.video_guide_progress to authenticated;
