# Database Schema: MinimaSpend

This document contains the full SQL schema for **MinimaSpend**, including tables, Row Level Security (RLS) policies, and triggers. Execute this SQL in the Supabase Dashboard SQL Editor.

## 1. Categories Table

Allows users to define their own labels for expenses.

```sql
create table public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  name text not null,
  icon text,
  created_at timestamptz not null default now()
);

-- Enable RLS
alter table public.categories enable row level security;

-- Policies
create policy "Users can view their own categories"
  on public.categories for select
  using (auth.uid() = user_id);

create policy "Users can insert their own categories"
  on public.categories for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own categories"
  on public.categories for update
  using (auth.uid() = user_id);

create policy "Users can delete their own categories"
  on public.categories for delete
  using (auth.uid() = user_id);
```

## 2. Expenses Table

Stores individual spending entries.

```sql
create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  category_id uuid not null references public.categories(id) on delete cascade,
  amount numeric not null,
  currency text not null check (currency in ('UAH', 'USD', 'EUR')) default 'UAH',
  description text,
  is_recurring boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Enable RLS
alter table public.expenses enable row level security;

-- Policies
create policy "Users can view their own expenses"
  on public.expenses for select
  using (auth.uid() = user_id);

create policy "Users can insert their own expenses"
  on public.expenses for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own expenses"
  on public.expenses for update
  using (auth.uid() = user_id);

create policy "Users can delete their own expenses"
  on public.expenses for delete
  using (auth.uid() = user_id);
```

## 3. Automation & Triggers

### Updated At Timestamp

This function and trigger ensure that the `updated_at` column is automatically updated on every change.

```sql
-- Function to handle updated_at
create or replace function public.handle_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- Trigger for expenses
create trigger set_expenses_updated_at
  before update on public.expenses
  for each row
  execute function public.handle_updated_at();
```

## 4. Default Categories Provisioning (Reference)

On first login, the application should auto-provision a set of default categories if they don't exist:

- Food
- Transport
- Rent
- Coffee
- Server Costs
- Entertainment

## 5. Budgets Table

Stores per-category monthly spending limits set by the user.

```sql
create table public.budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  category_id uuid not null references public.categories(id) on delete cascade,
  monthly_limit numeric not null check (monthly_limit > 0),
  currency text not null check (currency in ('UAH', 'USD', 'EUR')) default 'UAH',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, category_id)
);

-- Enable RLS
alter table public.budgets enable row level security;

-- Policies
create policy "Users can view their own budgets" on public.budgets for select using (auth.uid() = user_id);
create policy "Users can insert their own budgets" on public.budgets for insert with check (auth.uid() = user_id);
create policy "Users can update their own budgets" on public.budgets for update using (auth.uid() = user_id);
create policy "Users can delete their own budgets" on public.budgets for delete using (auth.uid() = user_id);

-- Trigger
create trigger set_budgets_updated_at
  before update on public.budgets
  for each row execute function public.handle_updated_at();
```

## 6. Income Table

```sql
  create table public.income (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
    source text not null,
    amount numeric not null,
    currency text not null check (currency in ('UAH', 'USD', 'EUR')) default 'UAH',
    description text,
    created_at timestamptz not null default now()
  );
  alter table public.income enable row level security;
  create policy "Users can view their own income" on public.income for select using (auth.uid() = user_id);
  create policy "Users can insert their own income" on public.income for insert with check (auth.uid() = user_id);
  create policy "Users can update their own income" on public.income for update using (auth.uid() = user_id);
  create policy "Users can delete their own income" on public.income for delete using (auth.uid() = user_id);
```

## 7. Account Deletion RPC

**Manual step:** run this SQL in the Supabase Dashboard SQL Editor. It enables in-app account deletion (see `src/lib/account.ts`) without requiring the service-role key on the client: the authenticated user calls the `delete_own_account()` RPC, which runs with elevated (`SECURITY DEFINER`) privileges but hardcodes `auth.uid()` as the deletion target, so a caller can only ever delete their own row. Deleting the `auth.users` row cascades (via the `on delete cascade` foreign keys above) to all of that user's `categories`, `expenses`, `budgets`, and `income` rows.

```sql
create or replace function public.delete_own_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from auth.users where id = auth.uid();
end;
$$;

grant execute on function public.delete_own_account() to authenticated;
```

An earlier version of this used a `public.profiles` table with an insert/delete RLS dance plus a delete-trigger as an indirect way to delete `auth.users` from the client. That approach hit a still-unexplained RLS failure on this project (see git history) and was replaced with this direct RPC, which is simpler and is the standard Supabase pattern for self-service account deletion. If `public.profiles` and its policies/trigger still exist in your project from the earlier approach, they can be dropped:

```sql
drop trigger if exists on_profile_deleted on public.profiles;
drop function if exists public.handle_user_delete();
drop table if exists public.profiles;
```
