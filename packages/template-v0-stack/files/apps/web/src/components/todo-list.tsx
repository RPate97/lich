'use client';

/**
 * `<TodoList>` — interactive list + add-todo input for the dashboard
 * (LEV-196). All mutations go through the api via `lib/api.ts` (which
 * forwards the Better Auth session cookie).
 *
 * Form names match what the e2e test (`e2e/auth-flow.spec.ts`) drives:
 *   - input is `[name=todo-text]`
 *   - add button has accessible name "Add"
 *   - per-row delete button has accessible name "Delete"
 *   - per-row toggle is a `role=checkbox`
 *
 * Pattern: optimistic-ish — we re-fetch the full list after each mutation
 * rather than mutating state in-place. That keeps the client honest about
 * the server's view (the api enforces user-ownership; the list returned is
 * authoritative). Re-fetching is fine for the small lists this template
 * targets; replace with `useOptimistic` or SWR once the list grows.
 */
import { useState, type FormEvent } from 'react';
import {
  createTodo,
  deleteTodo,
  listTodos,
  toggleTodo,
  type Todo,
} from '../lib/api';

export interface TodoListProps {
  initialTodos: Todo[];
}

export function TodoList({ initialTodos }: TodoListProps): JSX.Element {
  const [todos, setTodos] = useState<Todo[]>(initialTodos);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      setTodos(await listTodos());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'refresh failed');
    }
  }

  async function onAdd(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError(null);
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    setBusy(true);
    try {
      await createTodo(trimmed);
      setText('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'add failed');
    } finally {
      setBusy(false);
    }
  }

  async function onToggle(id: string, done: boolean): Promise<void> {
    setError(null);
    try {
      await toggleTodo(id, done);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'toggle failed');
    }
  }

  async function onDelete(id: string): Promise<void> {
    setError(null);
    try {
      await deleteTodo(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'delete failed');
    }
  }

  return (
    <div className="lz-stack">
      <form className="lz-inline" onSubmit={onAdd}>
        <input
          type="text"
          name="todo-text"
          placeholder="What needs doing?"
          className="lz-input"
          style={{ flex: 1 }}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
        />
        <button type="submit" className="lz-button" disabled={busy || text.trim().length === 0}>
          Add
        </button>
      </form>

      {error ? <p className="lz-error">{error}</p> : null}

      {todos.length === 0 ? (
        <p className="lz-muted">No todos yet. Add one above.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {todos.map((t) => (
            <li key={t.id} className="lz-row">
              <input
                type="checkbox"
                aria-label={`mark "${t.text}" as ${t.done ? 'not done' : 'done'}`}
                checked={t.done}
                onChange={(e) => onToggle(t.id, e.target.checked)}
              />
              <span className={'lz-row-text' + (t.done ? ' lz-done' : '')}>{t.text}</span>
              <button
                type="button"
                className="lz-button lz-button-danger"
                onClick={() => onDelete(t.id)}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
