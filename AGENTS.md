# Repository Guidelines

Cadence: a course platform built on React Router v8 (framework mode), TypeScript, SQLite via `better-sqlite3`, and Drizzle ORM.

## Project Structure

- Routes are registered explicitly in `app/routes.ts`; files in `app/routes/` use flat dot-naming (`courses.$slug.lessons.$lessonId.tsx`). Adding a file there does nothing until it is listed in `app/routes.ts`.
- Loaders and actions call `app/services/*Service.ts`; database access lives in services, each with a sibling `*.test.ts`.
- `app/db/index.ts` opens the connection lazily behind a Proxy so the module stays side-effect free and `better-sqlite3` stays out of the client bundle. Keep it that way.
- Current user comes from the cookie session in `app/lib/session.ts` (`getCurrentUserId`).
- UI primitives are shadcn components in `app/components/ui/`.

## Commands

- `npm run dev` — dev server at `http://localhost:5173`
- `npm test` — Vitest, all tests; `npx vitest run app/services/courseService.test.ts` for one file, add `-t "<name>"` for one test
- `npm run typecheck` — `react-router typegen && tsc` (strict mode)
- `npm run build`

## Style

Prettier (`.prettierrc`): 2-space indent, double quotes, semicolons, ES5 trailing commas, 80-column width. Import app code through the `~/` alias.

## Testing

Service tests swap the real database for an in-memory one built from the same `drizzle/` migrations:

```ts
let testDb: ReturnType<typeof createTestDb>;
vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));
```

Build `testDb` with `createTestDb()` and base rows with `seedBaseData()` from `app/test/setup.ts` in `beforeEach`.

## Commits

Subject format is `<branch-slug>: <Imperative summary>`, e.g. `lesson-comments: Add lesson comments`.

## Database

`data.db` is disposable seed data. Load the `database-migrations` skill before touching `app/db/schema.ts`, `drizzle/`, `scripts/seed.ts`, or a broken `data.db`.
