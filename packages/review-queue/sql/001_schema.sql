-- review-queue: schema v1.
-- Every table carries tenant_id and every query in PostgresStore filters on it.
-- Rows in review_items are never deleted: a reviewed line is the audit trail
-- of what the model said and what the human decided.

create table if not exists review_documents (
  id           text primary key,
  tenant_id    text not null,
  source       text not null,
  received_at  timestamptz not null,
  processed_at timestamptz,
  status       text not null check (status in ('received', 'processed', 'failed')),
  error        text,
  line_count   integer not null default 0
);

create index if not exists review_documents_tenant_recent
  on review_documents (tenant_id, received_at desc);

create table if not exists review_items (
  id                text primary key,
  tenant_id         text not null,
  document_id       text not null references review_documents (id),
  line              jsonb not null,      -- original extractor output, immutable
  status            text not null check (status in ('pending', 'approved', 'corrected', 'rejected')),
  category          text,
  entity_code       text,
  applied_lesson_id text,
  reviewed_by       text,
  reviewed_at       timestamptz,
  review_note       text,
  created_at        timestamptz not null
);

create index if not exists review_items_tenant_status
  on review_items (tenant_id, status, created_at);

create table if not exists review_lessons (
  id             text primary key,
  tenant_id      text not null,
  pattern        text not null,
  category       text,
  entity_code    text,
  source_item_id text not null,
  created_at     timestamptz not null,
  updated_at     timestamptz not null,
  times_applied  integer not null default 0,
  unique (tenant_id, pattern)
);
