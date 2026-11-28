-- ====================================================================
-- NTD AGENCY - REMOTE CONTROL SYSTEM MIGRATION (SUPABASE)
-- Chạy đoạn mã này trong: Supabase Dashboard -> SQL Editor -> Run
-- Project: website-duy (textwlxfxksdtnbzzzok)
-- ====================================================================

-- 1. Bảng ntd_devices (Quản lý các máy tính/thiết bị chạy Chrome Extension)
create table if not exists public.ntd_devices (
    id text primary key,
    owner_username text not null,
    device_name text not null default 'Máy tính NTD',
    ext_version text not null default '1.0.0',
    status text not null default 'idle' check (status in ('online', 'idle', 'running', 'offline')),
    last_heartbeat timestamptz not null default now(),
    current_task_id text,
    capabilities jsonb not null default '["post_campaign","warmup","scan_groups","scan_maps"]'::jsonb,
    system_info jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists idx_ntd_devices_owner on public.ntd_devices (owner_username, last_heartbeat desc);

-- 2. Bảng ntd_remote_tasks (Hàng đợi tác vụ điều khiển từ xa: Đăng bài, Nuôi nick, Quét data...)
create table if not exists public.ntd_remote_tasks (
    id uuid default gen_random_uuid() primary key,
    owner_username text not null,
    device_id text not null default 'auto',
    task_type text not null,
    payload jsonb not null default '{}'::jsonb,
    scheduled_at timestamptz not null default now(),
    started_at timestamptz,
    finished_at timestamptz,
    status text not null default 'pending' check (status in ('pending', 'running', 'paused', 'completed', 'failed', 'cancelled')),
    progress jsonb not null default '{"current":0,"total":0,"percent":0,"status_text":"Chờ thiết bị nhận việc..."}'::jsonb,
    result jsonb not null default '{}'::jsonb,
    error_message text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists idx_ntd_tasks_owner_status on public.ntd_remote_tasks (owner_username, status, created_at desc);
create index if not exists idx_ntd_tasks_device on public.ntd_remote_tasks (device_id, status);

-- 3. Bảng ntd_task_logs (Nhật ký thời gian thực chi tiết từng bước thực thi)
create table if not exists public.ntd_task_logs (
    id bigint generated always as identity primary key,
    task_id uuid not null references public.ntd_remote_tasks(id) on delete cascade,
    owner_username text not null,
    device_id text not null default '',
    message text not null,
    details jsonb not null default '{}'::jsonb,
    log_level text not null default 'info' check (log_level in ('info', 'success', 'warning', 'error')),
    created_at timestamptz not null default now()
);
create index if not exists idx_ntd_logs_task on public.ntd_task_logs (task_id, created_at asc);

-- 4. Hàm tiếp nhận tác vụ nguyên tử (Atomic Claim Task) chống trùng lặp tuyệt đối
create or replace function public.claim_remote_task(
    p_device_id text,
    p_task_id uuid default null,
    p_owner_username text default null
)
returns jsonb
language plpgsql
security definer
as $$
declare
    v_task record;
begin
    if p_task_id is not null then
        select * into v_task
        from public.ntd_remote_tasks
        where id = p_task_id
          and status = 'pending'
          and (device_id = p_device_id or device_id = '' or device_id = 'auto')
        for update skip locked;
    else
        select * into v_task
        from public.ntd_remote_tasks
        where status = 'pending'
          and (device_id = p_device_id or (device_id in ('', 'auto') and (p_owner_username is null or owner_username = p_owner_username)))
          and (scheduled_at is null or scheduled_at <= now())
        order by created_at asc
        limit 1
        for update skip locked;
    end if;

    if v_task.id is null then
        return jsonb_build_object('ok', false, 'message', 'No pending task available');
    end if;

    update public.ntd_remote_tasks
    set status = 'running',
        device_id = p_device_id,
        started_at = coalesce(started_at, now()),
        updated_at = now()
    where id = v_task.id;

    update public.ntd_devices
    set status = 'running',
        current_task_id = v_task.id::text,
        last_heartbeat = now(),
        updated_at = now()
    where id = p_device_id;

    return jsonb_build_object(
        'ok', true,
        'task', row_to_json(v_task)
    );
end;
$$;

-- 5. Bật Row Level Security (RLS) & cấp quyền Data API
alter table public.ntd_devices enable row level security;
alter table public.ntd_remote_tasks enable row level security;
alter table public.ntd_task_logs enable row level security;

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.ntd_devices, public.ntd_remote_tasks, public.ntd_task_logs to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;
grant execute on function public.claim_remote_task(text, uuid, text) to anon, authenticated;

-- Policies
drop policy if exists "ntd_devices_all" on public.ntd_devices;
create policy "ntd_devices_all" on public.ntd_devices for all to anon, authenticated using (true) with check (true);

drop policy if exists "ntd_remote_tasks_all" on public.ntd_remote_tasks;
create policy "ntd_remote_tasks_all" on public.ntd_remote_tasks for all to anon, authenticated using (true) with check (true);

drop policy if exists "ntd_task_logs_all" on public.ntd_task_logs;
create policy "ntd_task_logs_all" on public.ntd_task_logs for all to anon, authenticated using (true) with check (true);

-- 6. Kích hoạt Supabase Realtime cho thiết bị và tác vụ từ xa
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'ntd_devices') then
    alter publication supabase_realtime add table public.ntd_devices;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'ntd_remote_tasks') then
    alter publication supabase_realtime add table public.ntd_remote_tasks;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'ntd_task_logs') then
    alter publication supabase_realtime add table public.ntd_task_logs;
  end if;
exception when others then
  null;
end $$;
