import { describe, expect, it } from "vitest";
import {
  exportTasksToAirtableTable,
  mapTaskToAirtableFields,
  type AirtableTaskFields,
  type ExportableTask,
} from "@/lib/airtable";

function makeTask(overrides: Partial<ExportableTask> = {}): ExportableTask {
  return {
    id: "task_1",
    projectId: "project_1",
    title: "Write export tests",
    description: "Cover Airtable export behavior",
    status: "todo",
    assigneeId: null,
    createdById: "user_1",
    position: 0,
    createdAt: new Date("2026-05-13T10:00:00.000Z"),
    updatedAt: new Date("2026-05-13T11:00:00.000Z"),
    project: { id: "project_1", name: "Q3 Launch" },
    assignee: { id: "user_2", name: "Arjun Rao", email: "arjun@taskboard.dev" },
    ...overrides,
  };
}

function makeTable(existing: Array<{ id: string; fields: Partial<AirtableTaskFields> }> = []) {
  const records = [...existing];
  const created: AirtableTaskFields[] = [];
  const updated: Array<{ id: string; fields: AirtableTaskFields }> = [];

  return {
    created,
    updated,
    table: {
      select: () => ({
        all: async () => records,
      }),
      create: async (fields: AirtableTaskFields) => {
        created.push(fields);
        return { id: `rec_created_${created.length}` };
      },
      update: async (id: string, fields: AirtableTaskFields) => {
        updated.push({ id, fields });
        return { id };
      },
    },
  };
}

describe("Airtable export", () => {
  it("maps a task into Airtable fields", () => {
    const fields = mapTaskToAirtableFields(makeTask());

    expect(fields["Task ID"]).toBe("task_1");
    expect(fields["Project ID"]).toBe("project_1");
    expect(fields["Project Name"]).toBe("Q3 Launch");
    expect(fields["Assignee Email"]).toBe("arjun@taskboard.dev");
    expect(fields["Created At"]).toBe("2026-05-13T10:00:00.000Z");
  });

  it("creates missing records and updates existing records", async () => {
    const fake = makeTable([{ id: "rec_existing", fields: { "Task ID": "task_2" } }]);

    const summary = await exportTasksToAirtableTable(
      "project_1",
      [makeTask(), makeTask({ id: "task_2", title: "Existing task" })],
      fake.table,
      "Tasks",
    );

    expect(summary.created).toBe(1);
    expect(summary.updated).toBe(1);
    expect(summary.failed).toBe(0);
    expect(fake.created[0]["Task ID"]).toBe("task_1");
    expect(fake.updated[0].id).toBe("rec_existing");
    expect(fake.updated[0].fields.Title).toBe("Existing task");
  });

  it("keeps exporting when one task fails", async () => {
    const created: AirtableTaskFields[] = [];
    const table = {
      select: () => ({ all: async () => [] }),
      create: async (fields: AirtableTaskFields) => {
        if (fields["Task ID"] === "task_2") {
          const error = new Error("Invalid field");
          Object.assign(error, { statusCode: 422 });
          throw error;
        }
        created.push(fields);
        return { id: `rec_${fields["Task ID"]}` };
      },
      update: async () => ({ id: "unused" }),
    };

    const summary = await exportTasksToAirtableTable(
      "project_1",
      [makeTask(), makeTask({ id: "task_2" }), makeTask({ id: "task_3" })],
      table,
      "Tasks",
    );

    expect(summary.created).toBe(2);
    expect(summary.failed).toBe(1);
    expect(created.map((fields) => fields["Task ID"])).toEqual(["task_1", "task_3"]);
  });
});
