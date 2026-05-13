# Code Review — Top Issues

## 1) Critical Security: SQL injection in task search
- **File:** `src/app/api/projects/[id]/tasks/route.ts`
- **Line:** 34
- **Category:** Security
- **Severity:** Critical
- **Description:** The search endpoint constructs SQL using the raw query parameter `q` and passes it directly into `prisma.$queryRawUnsafe(sql)`. This allows user-supplied input to be executed as SQL, exposing the application to SQL injection and unauthorized data access.
- **Recommended fix:** Replace the raw SQL query with Prisma query filters using parameter binding. Example:
  ```ts
  const tasks = await prisma.task.findMany({
    where: {
      projectId,
      OR: [
        { title: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } },
      ],
    },
    orderBy: { position: "asc" },
  });
  ```

## 2) Critical Security/Data Integrity: Task update is not authorized
- **File:** `src/app/api/tasks/[id]/route.ts`
- **Lines:** 26-33
- **Category:** Security / Data Integrity
- **Severity:** Critical
- **Description:** The `PATCH` handler updates any task by ID for any authenticated user without checking project membership or role. A user who does not belong to the project can therefore modify tasks they should not have access to.
- **Recommended fix:** Before updating, verify the authenticated user is a project member and has sufficient task permissions (`admin` or `member`). If not, return `403 forbidden`.

## 3) High Risk Data Integrity: Missing unique email constraint at the database level
- **File:** `prisma/schema.prisma`
- **Line:** 25
- **Category:** Data Integrity
- **Severity:** High
- **Description:** `User.email` is not enforced as unique in the database schema. The registration endpoint performs an application-level uniqueness check, but this is insufficient for race conditions and duplicate-account prevention.
- **Recommended fix:** Add a unique constraint on `User.email` in Prisma. Then update registration/login logic to use `findUnique({ where: { email } })` and gracefully handle duplicate-key constraint errors.

## 4) High Impact Testing gap: Missing backend API / authorization tests
- **Files:** `src/tests/auth.test.ts`, `src/tests/schemas.test.ts`
- **Category:** Testing
- **Severity:** High
- **Description:** Existing tests only cover JWT utilities and schema validation. There is no coverage for auth endpoints, task authorization rules, or protection against malformed and injected inputs.
- **Recommended fix:** Add tests for API behavior, including:
  - successful and failed login/register flows
  - protected route access with missing/invalid tokens
  - task update/delete authorization enforcement
  - SQL injection attempts against the search endpoint

## Reproducible example for the SQL injection bug

```bash
curl -i "http://localhost:3000/api/projects/<PROJECT_ID>/tasks?q=' OR '1'='1"
```

### Expected insecure effect
If the raw query branch is reached, the request may return all tasks for the project or trigger unexpected SQL behavior, because the user input is interpolated directly into the query.

### Recommended secure behavior
The endpoint should treat `q` as a search string only and never execute it as raw SQL source.
