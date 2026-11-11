create extension if not exists vector with schema extensions;

create table public.stores (
  id bigint generated always as identity primary key,
  username varchar(255) not null unique,
  password varchar(255) not null,
  is_customer boolean not null default false
);

create table public.books (
  id bigint generated always as identity primary key,
  store_id bigint not null references public.stores(id),
  isbn varchar(20),
  title varchar(500) not null,
  author varchar(255) not null,
  genre varchar(50) not null,
  publisher varchar(255),
  publication_year integer,
  page_count integer,
  language varchar(50) default 'en',
  cover_image_url text,
  description text,
  price numeric(10,2) not null,
  stock_quantity integer not null default 0 check (stock_quantity >= 0),
  total_sold integer not null default 0,
  average_rating numeric(3,2) default 0,
  created_at timestamp not null default now(),
  embedding extensions.vector(384),
  unique (store_id, isbn)
);

create table public.sales (
  id bigint generated always as identity primary key,
  book_id bigint not null references public.books(id),
  customer_id bigint not null references public.stores(id),
  quantity integer not null,
  price_at_purchase numeric(10,2) not null,
  purchased_at timestamp not null default now()
);

create table public.reviews (
  id bigint generated always as identity primary key,
  book_id bigint not null references public.books(id),
  customer_id bigint not null references public.stores(id),
  rating integer not null check (rating >= 1 and rating <= 5),
  review_text text,
  created_at timestamp not null default now(),
  unique (book_id, customer_id)
);

create index idx_books_store_id on public.books(store_id);
create index idx_books_genre on public.books(genre);
create index idx_books_author on public.books(author);
create index idx_books_isbn on public.books(isbn);
create index idx_books_stock on public.books(stock_quantity);
create index idx_books_embedding on public.books using hnsw (embedding extensions.vector_cosine_ops);
create index idx_sales_book_id on public.sales(book_id);
create index idx_sales_customer_id on public.sales(customer_id);
create index idx_sales_purchased_at on public.sales(purchased_at);
create index idx_reviews_book_id on public.reviews(book_id);

-- The backend and AI service connect as the table owner, which bypasses RLS.
-- With RLS on and no policies, the public API keys can read and write nothing.
alter table public.stores enable row level security;
alter table public.books enable row level security;
alter table public.sales enable row level security;
alter table public.reviews enable row level security;
