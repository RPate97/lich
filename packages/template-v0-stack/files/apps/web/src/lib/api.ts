/**
 * Thin client wrappers around the `{{projectName}}` api (LEV-196).
 *
 * Why this file exists, given that `levelzero gen --only api-client` emits a
 * typed client at `packages/api-client/src/index.ts`: the generated client is
 * a strict mirror of the api's routes (one function per route, fetch-only,
 * no auth-cookie plumbing). In a freshly-scaffolded project the generated
 * file may not yet exist (the user hasn't run `levelzero gen`), so this
 * shim provides a small handwritten surface the pages can rely on no matter
 * what — and it sets `credentials: 'include'` so the Better Auth session
 * cookie rides along on every request. Once you run `levelzero gen`, you
 * can replace these helpers with the generated functions; until then this
 * keeps the dashboard functional out of the box.
 */
const API_URL =
  // Server-side (RSC, route handlers, server actions).
  process.env.API_URL ??
  // Client-side (browser bundle). Mirrors `auth-client.ts`.
  process.env.NEXT_PUBLIC_API_URL ??
  'http://localhost:3001';

export interface Todo {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
}

/** All fetches go through here so headers + credentials stay consistent. */
async function apiFetch(path: string, init: RequestInit & { headersInit?: HeadersInit } = {}): Promise<Response> {
  const { headersInit, ...rest } = init;
  return fetch(`${API_URL}${path}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(headersInit ?? {}),
    },
    ...rest,
  });
}

/**
 * Server-side variant: forwards the incoming request's cookies so the api
 * sees the user's session. Next.js's RSC doesn't auto-forward cookies on
 * a server-to-server `fetch` — we have to read them off `next/headers` and
 * paste them onto the outgoing Cookie header by hand.
 */
async function apiFetchServer(path: string, init: RequestInit = {}): Promise<Response> {
  // Lazy import so this module stays usable from client components too.
  const { headers } = await import('next/headers');
  const cookie = headers().get('cookie') ?? '';
  return fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
      cookie,
    },
  });
}

export async function fetchTodosServer(): Promise<Todo[]> {
  const r = await apiFetchServer('/api/todos', { cache: 'no-store' });
  if (r.status === 401) return [];
  if (!r.ok) throw new Error(`fetchTodos: ${r.status}`);
  const body = (await r.json()) as { todos: Todo[] };
  return body.todos;
}

export async function fetchSessionUserServer(): Promise<{ id: string; email: string; name?: string } | null> {
  const r = await apiFetchServer('/api/me', { cache: 'no-store' });
  if (r.status === 401) return null;
  if (!r.ok) throw new Error(`fetchSessionUser: ${r.status}`);
  const body = (await r.json()) as { user: { id: string; email: string; name?: string } };
  return body.user;
}

export async function createTodo(text: string): Promise<Todo> {
  const r = await apiFetch('/api/todos', {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
  if (!r.ok) throw new Error(`createTodo: ${r.status}`);
  const body = (await r.json()) as { todo: Todo };
  return body.todo;
}

export async function toggleTodo(id: string, done: boolean): Promise<Todo> {
  const r = await apiFetch(`/api/todos/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ done }),
  });
  if (!r.ok) throw new Error(`toggleTodo: ${r.status}`);
  const body = (await r.json()) as { todo: Todo };
  return body.todo;
}

export async function deleteTodo(id: string): Promise<void> {
  const r = await apiFetch(`/api/todos/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(`deleteTodo: ${r.status}`);
}

export async function listTodos(): Promise<Todo[]> {
  const r = await apiFetch('/api/todos');
  if (!r.ok) throw new Error(`listTodos: ${r.status}`);
  const body = (await r.json()) as { todos: Todo[] };
  return body.todos;
}
