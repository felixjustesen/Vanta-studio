-- Efterligning af Supabase-udvidelserne pg_net, pg_cron og Vault (kun til lokale tests).
-- Kolonner og funktionssignaturer som i de rigtige udvidelser, så
-- 10-forbindelse-til-platform.sql kan køres uændret. Intet sendes herfra:
-- testerne læser net.http_request_queue og skriver svarene i net._http_response.

-- pg_net
create schema net;
create table net.http_request_queue (
  id bigserial primary key,
  method text not null,
  url text not null,
  headers jsonb,
  body bytea,
  timeout_milliseconds integer not null
);
create table net._http_response (
  id bigint,
  status_code integer,
  content_type text,
  headers jsonb,
  content text,
  timed_out boolean,
  error_msg text,
  created timestamptz not null default now()
);
create function net.http_post(
  url text,
  body jsonb default '{}'::jsonb,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{"Content-Type": "application/json"}'::jsonb,
  timeout_milliseconds integer default 5000
) returns bigint language sql volatile as $$
  insert into net.http_request_queue (method, url, headers, body, timeout_milliseconds)
  values ('POST', url, headers, convert_to(body::text, 'UTF8'), timeout_milliseconds)
  returning id;
$$;
revoke all on schema net from public;

-- pg_cron
create schema cron;
create table cron.job (
  jobid bigserial primary key,
  schedule text not null,
  command text not null,
  nodename text not null default 'localhost',
  nodeport integer not null default 5432,
  database text not null default current_database(),
  username text not null default current_user,
  active boolean not null default true,
  jobname text unique
);
create table cron.job_run_details (
  jobid bigint,
  runid bigserial primary key,
  status text,
  start_time timestamptz,
  end_time timestamptz
);
create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql volatile as $$
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command, active = true
  returning jobid;
$$;
create function cron.unschedule(job_id bigint) returns boolean language sql volatile as $$
  with d as (delete from cron.job where jobid = job_id returning 1) select exists (select 1 from d);
$$;
create function cron.unschedule(job_name text) returns boolean language sql volatile as $$
  with d as (delete from cron.job where jobname = job_name returning 1) select exists (select 1 from d);
$$;
revoke all on schema cron from public;

-- Vault (i Supabase krypteret; her i klartekst)
create schema vault;
create table vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text unique,
  description text not null default '',
  secret text not null,
  key_id uuid,
  nonce bytea,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create view vault.decrypted_secrets as
  select id, name, description, secret, secret as decrypted_secret, key_id, nonce, created_at, updated_at
  from vault.secrets;
create function vault.create_secret(new_secret text, new_name text default null, new_description text default '', new_key_id uuid default null)
returns uuid language sql volatile as $$
  insert into vault.secrets (secret, name, description) values (new_secret, new_name, coalesce(new_description, '')) returning id;
$$;
create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null, new_key_id uuid default null)
returns void language sql volatile as $$
  update vault.secrets
  set secret = coalesce(new_secret, secret), name = coalesce(new_name, name),
      description = coalesce(new_description, description), updated_at = now()
  where id = secret_id;
$$;
revoke all on schema vault from public;
