-- chat-ops-classifier: schema v1 (optional; the package ships in-memory stores).
-- Every table carries project_id; a project is the tenant boundary.

create table if not exists ops_timeline (
  id          text primary key,
  project_id  text not null,
  kind        text not null check (kind in ('progress', 'decision')),
  text        text not null,
  author_ref  text not null,
  author_name text not null,
  at          timestamptz not null,
  message_id  text not null,
  media_ref   text
);

create index if not exists ops_timeline_project_at on ops_timeline (project_id, at desc);

create table if not exists ops_tasks (
  id                      text primary key,
  project_id              text not null,
  title                   text not null,
  status                  text not null check (status in ('open', 'done')),
  created_from_message_id text not null,
  created_by_ref          text not null,
  created_by_name         text not null,
  created_at              timestamptz not null,
  done_at                 timestamptz,
  done_by_ref             text
);

create index if not exists ops_tasks_project_status on ops_tasks (project_id, status, created_at);

create table if not exists ops_expenses (
  id                      text primary key,
  project_id              text not null,
  supplier                text not null,
  tax_id                  text not null,
  amount                  numeric(14, 2) not null,
  due_date                date not null,
  invoice_number          text,
  status                  text not null check (status in ('draft', 'confirmed', 'discarded')),
  duplicate_of            text references ops_expenses (id),
  created_from_message_id text not null,
  created_by_ref          text not null,
  created_by_name         text not null,
  created_at              timestamptz not null,
  confirmed_by_ref        text,
  confirmed_at            timestamptz,
  discarded_by_ref        text,
  discarded_at            timestamptz,
  -- a confirmed expense always says who confirmed it
  check (status <> 'confirmed' or confirmed_by_ref is not null)
);

create index if not exists ops_expenses_project_status on ops_expenses (project_id, status, created_at);

create table if not exists ops_audit (
  id           text primary key,
  at           timestamptz not null,
  project_id   text,
  actor_ref    text not null,
  actor_name   text not null,
  action       text not null,
  subject_type text not null,
  subject_id   text not null,
  detail       jsonb not null default '{}'::jsonb
);

create index if not exists ops_audit_project_at on ops_audit (project_id, at);
