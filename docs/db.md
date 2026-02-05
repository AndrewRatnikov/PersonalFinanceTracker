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
