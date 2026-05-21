/**
 * `/dashboard` — authenticated todo CRUD landing page (LEV-196).
 *
 * Server component: fetches the current session + initial todos from the api
 * (forwarding the incoming request's cookies via `lib/api.ts`'s server
 * helpers). If the session probe returns null, redirects to `/sign-in`. The
 * actual interaction happens in the `<TodoList>` client component below.
 *
 * Why we fetch on the server: it avoids a client-side flash of "no todos"
 * before the first round-trip lands, and proves the full cookie-forwarding
 * path is wired for SSR. The `<TodoList>` re-fetches after every mutation
 * so the displayed state stays in lockstep with the database.
 */
import { redirect } from 'next/navigation';
import { fetchSessionUserServer, fetchTodosServer } from '../../lib/api';
import { TodoList } from '../../components/todo-list';
import { SignOutButton } from '../../components/sign-out-button';

export const metadata = {
  title: 'Dashboard — {{projectName}}',
};

// Force dynamic rendering — every request reads cookies, which Next can't
// statically pre-render.
export const dynamic = 'force-dynamic';

export default async function DashboardPage(): Promise<JSX.Element> {
  const user = await fetchSessionUserServer();
  if (!user) {
    redirect('/sign-in');
  }
  const todos = await fetchTodosServer();

  return (
    <main className="lz-main">
      <header className="lz-header">
        <h1 className="lz-title">Dashboard</h1>
        <p className="lz-subtitle">
          Signed in as <strong>{user.email}</strong>.
        </p>
      </header>
      <section className="lz-card">
        <TodoList initialTodos={todos} />
      </section>
      <p>
        <SignOutButton />
      </p>
    </main>
  );
}
