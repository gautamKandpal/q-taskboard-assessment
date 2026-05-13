# Airtable Bulk Task Export Flow

## Goal

Add a project-level export action that pushes every task in a project to a real Airtable base using the official `airtable` npm package.

At the end of a successful export attempt, opening the configured Airtable table should show the project's tasks. Re-running the export should update existing task rows instead of creating duplicates.

## User Flow

1. User opens a project detail page.
2. The page loads the project, memberships, and task board as it does today.
3. If the current user is an `admin` or `member` of the project, show an `Export to Airtable` button in the project header.
4. If the current user is a `viewer`, hide or disable the export button.
5. User clicks `Export to Airtable`.
6. The client calls a new server endpoint:

   ```txt
   POST /api/projects/:id/export/airtable
   ```

7. The server validates the user and project membership.
8. The server fetches all tasks for that project from Prisma.
9. The server pushes the tasks to Airtable.
10. The UI displays a summary: created, updated, failed, skipped, and total tasks processed.

## Authorization

The export is a write operation against an external destination, so it follows the same role policy as task creation and task editing.

Allowed:

```txt
admin
member
```

Rejected:

```txt
viewer
non-member
unauthenticated user
```

Authorization steps:

1. Read JWT from `Authorization: Bearer <token>`.
2. Resolve current user with `getCurrentUser(req)`.
3. Resolve project id from route params.
4. Fetch membership with `getProjectMembership(user.id, projectId)`.
5. Return `401` if unauthenticated.
6. Return `403` if not a project member.
7. Return `403` if role is `viewer`.
8. Continue only when `canEditTasks(membership.role)` is true.

## Endpoint Design

### Route

```txt
POST /api/projects/:id/export/airtable
```

Suggested file:

```txt
src/app/api/projects/[id]/export/airtable/route.ts
```

### Response

```json
{
  "export": {
    "projectId": "project-id",
    "tableName": "Tasks",
    "total": 42,
    "created": 20,
    "updated": 21,
    "failed": 1,
    "results": [
      {
        "taskId": "task-id",
        "status": "created",
        "airtableRecordId": "recXXXXXXXXXXXXXX"
      },
      {
        "taskId": "task-id-2",
        "status": "failed",
        "error": "Invalid field name: Assignee Email",
        "retryable": false
      }
    ]
  }
}
```

Use status `200` when the endpoint completed the export attempt, even if individual records failed. Use `500` only when the whole export cannot start, such as missing Airtable configuration.

## Airtable Configuration

Required environment variables:

```txt
AIRTABLE_API_KEY=
AIRTABLE_BASE_ID=
AIRTABLE_TABLE_NAME=Tasks
```

The existing `.env` already includes these keys, so implementation should validate that `AIRTABLE_API_KEY` and `AIRTABLE_BASE_ID` are present before making API calls.

Recommended Airtable table fields:

```txt
Task ID
Project ID
Project Name
Title
Description
Status
Assignee Name
Assignee Email
Created By ID
Position
Created At
Updated At
Last Exported At
```

`Task ID` is the stable idempotency key.

## Idempotency Strategy

Airtable does not provide a native client-supplied record id for normal table records. To make repeated exports graceful, use a stable `Task ID` field and perform an upsert-like flow:

1. Before exporting, query Airtable for existing records where `Project ID` equals the current project id.
2. Build a map:

   ```txt
   Task ID -> Airtable record id
   ```

3. For each local task:
   - If `Task ID` exists in Airtable, update that Airtable record.
   - If `Task ID` does not exist, create a new Airtable record.

This prevents duplicate rows when export is run multiple times.

## Airtable Client Design

Create a small wrapper around the official package:

```txt
src/lib/airtable.ts
```

Responsibilities:

1. Initialize the real Airtable client from env vars.
2. List existing task records for a project.
3. Create task records.
4. Update task records.
5. Normalize Airtable errors into a local error shape.
6. Retry transient failures.

Do not import `src/lib/airtable-mock.ts` from production code. That file should only be used by tests.

## Task Mapping

Fetch tasks with related users:

```ts
const tasks = await prisma.task.findMany({
  where: { projectId },
  include: {
    project: { select: { id: true, name: true } },
    assignee: { select: { id: true, name: true, email: true } },
  },
  orderBy: [{ status: "asc" }, { position: "asc" }],
});
```

Map each task to Airtable fields:

```ts
{
  "Task ID": task.id,
  "Project ID": task.projectId,
  "Project Name": task.project.name,
  "Title": task.title,
  "Description": task.description ?? "",
  "Status": task.status,
  "Assignee Name": task.assignee?.name ?? "",
  "Assignee Email": task.assignee?.email ?? "",
  "Created By ID": task.createdById,
  "Position": task.position,
  "Created At": task.createdAt.toISOString(),
  "Updated At": task.updatedAt.toISOString(),
  "Last Exported At": new Date().toISOString()
}
```

## Retry Policy

Retry transient failures only.

Retryable:

```txt
429 rate limit
500 server error
502 bad gateway
503 unavailable
504 gateway timeout
network timeout / connection reset
```

Not retryable:

```txt
400 invalid request
401 invalid API key
403 forbidden
404 base/table not found
422 invalid field
```

Suggested retry behavior:

```txt
max attempts: 3
delay: 300ms, 900ms, 1800ms
```

If one task fails after retries, record that task as failed and continue exporting the remaining tasks.

## Failure Handling

The export should not fail the whole operation because one Airtable record fails.

Per-record failure result:

```json
{
  "taskId": "task-id",
  "status": "failed",
  "error": "Airtable error message",
  "retryable": true
}
```

Whole-export failures are reserved for setup or authorization problems:

```txt
401 unauthenticated
403 unauthorized role
500 missing Airtable env vars
500 unable to list existing Airtable records after retries
```

Listing existing Airtable records is a whole-export dependency because idempotency depends on it.

## Batching

Airtable supports creating and updating records in batches. For ~1,000 tasks, synchronous export is acceptable.

Implementation can start with simple per-record create/update calls for clarity, but a better version should batch records in chunks of 10 because Airtable's API commonly works with batches of up to 10 records.

Recommended implementation:

1. Fetch all local tasks.
2. Fetch existing Airtable records for the project.
3. Split tasks into `toCreate` and `toUpdate`.
4. Process in chunks of 10.
5. Retry failed chunks when the error is transient.
6. If a chunk fails permanently, retry individual records in that chunk only if useful for isolating single-record failures.
7. Return a detailed summary.

## UI Design

Location:

```txt
src/app/projects/[id]/page.tsx
```

Add the export button in the project header, near the project name and metadata.

States:

```txt
idle: Export to Airtable
pending: Exporting...
success: Exported X tasks
partial success: Exported X tasks, Y failed
error: Display endpoint error message
```

The button should be available only when the current project membership role is `admin` or `member`.

Because `ProjectPage` currently has project memberships and the auth user can be read from local storage, the UI can compute:

```ts
const currentMembership = project.memberships.find(
  (membership) => membership.user.id === currentUser?.id,
);
const canExport = currentMembership?.role === "admin" || currentMembership?.role === "member";
```

The backend remains the source of truth for permission enforcement.

## Testing Plan

Unit tests should use `src/lib/airtable-mock.ts` or a dedicated fake client, not the real Airtable API.

Test cases:

1. Admin can trigger export.
2. Member can trigger export.
3. Viewer receives `403`.
4. Non-member receives `403`.
5. Missing Airtable config returns a graceful error.
6. First export creates Airtable records.
7. Second export updates existing Airtable records and does not duplicate them.
8. Retryable Airtable errors are retried.
9. Permanent Airtable errors are not retried.
10. One failed task does not stop remaining tasks from exporting.
11. Response summary accurately reports created, updated, failed, and total counts.

Manual verification:

1. Set real Airtable env vars.
2. Start app and database.
3. Login as `meera@taskboard.dev` or `arjun@taskboard.dev`.
4. Open a project detail page.
5. Click `Export to Airtable`.
6. Open Airtable and verify rows are visible.
7. Run export again and verify no duplicate rows are created.

## Implementation Order

1. Build `src/lib/airtable.ts` wrapper around the official Airtable package.
2. Add the export API route.
3. Add tests with a fake/mock Airtable client.
4. Add project-page export button and result messaging.
5. Run typecheck and tests.
6. Manually verify against a real Airtable base.

## Notes

The current `airtable-mock.ts` is useful for unit tests but must not be used as the production integration. Production code must use the official `airtable` npm package and real Airtable credentials.
