import Airtable from "airtable";

export type AirtableTaskFields = {
  "Task ID": string;
  "Project ID": string;
  "Project Name": string;
  Title: string;
  Description: string;
  Status: string;
  "Assignee Name": string;
  "Assignee Email": string;
  "Created By ID": string;
  Position: number;
  "Created At": string;
  "Updated At": string;
  "Last Exported At": string;
};

export type ExportableTask = {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: string;
  assigneeId: string | null;
  createdById: string;
  position: number;
  createdAt: Date;
  updatedAt: Date;
  project: { id: string; name: string };
  assignee: { id: string; name: string; email: string } | null;
};

export type AirtableExportResult =
  | {
      taskId: string;
      status: "created" | "updated";
      airtableRecordId: string;
    }
  | {
      taskId: string;
      status: "failed";
      error: string;
      retryable: boolean;
    };

export type AirtableExportSummary = {
  projectId: string;
  tableName: string;
  total: number;
  created: number;
  updated: number;
  failed: number;
  results: AirtableExportResult[];
};

type AirtableConfig = {
  apiKey: string;
  baseId: string;
  tableName: string;
};

type AirtableRecord = {
  id: string;
  fields: Partial<AirtableTaskFields>;
};

type AirtableTasksTable = {
  select: (params: {
    fields: Array<keyof AirtableTaskFields>;
    filterByFormula: string;
    pageSize: number;
  }) => { all: () => Promise<readonly AirtableRecord[]> };
  create: (
    fields: AirtableTaskFields,
    options: { typecast: true },
  ) => Promise<{ id: string }>;
  update: (
    recordId: string,
    fields: AirtableTaskFields,
    options: { typecast: true },
  ) => Promise<{ id: string }>;
};

const retryDelaysMs = [300, 900, 1800];
const retryableStatusCodes = new Set([408, 429, 500, 502, 503, 504]);

export function getAirtableConfig(): AirtableConfig {
  const apiKey = process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const tableName = process.env.AIRTABLE_TABLE_NAME || "Tasks";

  if (!apiKey || !baseId) {
    throw new Error("Airtable export is not configured");
  }

  return { apiKey, baseId, tableName };
}

export async function exportTasksToAirtable(
  projectId: string,
  tasks: ExportableTask[],
  config = getAirtableConfig(),
): Promise<AirtableExportSummary> {
  const table = getAirtableTable(config);
  return exportTasksToAirtableTable(projectId, tasks, table, config.tableName);
}

export async function exportTasksToAirtableTable(
  projectId: string,
  tasks: ExportableTask[],
  table: AirtableTasksTable,
  tableName: string,
): Promise<AirtableExportSummary> {
  const existingRecords = await withRetry(
    () => listExistingProjectRecords(table, projectId),
    "list existing Airtable records",
  );
  const existingByTaskId = new Map<string, AirtableRecord>();

  for (const record of existingRecords) {
    const taskId = record.fields["Task ID"];
    if (typeof taskId === "string") existingByTaskId.set(taskId, record);
  }

  const results: AirtableExportResult[] = [];

  for (const task of tasks) {
    const fields = mapTaskToAirtableFields(task);
    const existing = existingByTaskId.get(task.id);

    try {
      if (existing) {
        const record = await withRetry(
          () => table.update(existing.id, fields, { typecast: true }),
          `update Airtable task ${task.id}`,
        );
        results.push({
          taskId: task.id,
          status: "updated",
          airtableRecordId: record.id,
        });
      } else {
        const record = await withRetry(
          () => table.create(fields, { typecast: true }),
          `create Airtable task ${task.id}`,
        );
        results.push({
          taskId: task.id,
          status: "created",
          airtableRecordId: record.id,
        });
      }
    } catch (error) {
      const normalized = normalizeAirtableError(error);
      results.push({
        taskId: task.id,
        status: "failed",
        error: normalized.message,
        retryable: normalized.retryable,
      });
    }
  }

  return {
    projectId,
    tableName,
    total: tasks.length,
    created: results.filter((result) => result.status === "created").length,
    updated: results.filter((result) => result.status === "updated").length,
    failed: results.filter((result) => result.status === "failed").length,
    results,
  };
}

export function mapTaskToAirtableFields(task: ExportableTask): AirtableTaskFields {
  return {
    "Task ID": task.id,
    "Project ID": task.projectId,
    "Project Name": task.project.name,
    Title: task.title,
    Description: task.description ?? "",
    Status: task.status,
    "Assignee Name": task.assignee?.name ?? "",
    "Assignee Email": task.assignee?.email ?? "",
    "Created By ID": task.createdById,
    Position: task.position,
    "Created At": task.createdAt.toISOString(),
    "Updated At": task.updatedAt.toISOString(),
    "Last Exported At": new Date().toISOString(),
  };
}

function getAirtableTable(config: AirtableConfig) {
  const client = new Airtable({
    apiKey: config.apiKey,
    noRetryIfRateLimited: true,
    requestTimeout: 30_000,
  });

  return client.base(config.baseId)<AirtableTaskFields>(config.tableName);
}

async function listExistingProjectRecords(
  table: AirtableTasksTable,
  projectId: string,
): Promise<AirtableRecord[]> {
  const records = await table
    .select({
      fields: ["Task ID"],
      filterByFormula: `{Project ID} = '${escapeFormulaString(projectId)}'`,
      pageSize: 100,
    })
    .all();

  return records.map((record) => ({
    id: record.id,
    fields: record.fields,
  }));
}

async function withRetry<T>(operation: () => Promise<T>, label: string): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const normalized = normalizeAirtableError(error);
      const isLastAttempt = attempt === retryDelaysMs.length;

      if (!normalized.retryable || isLastAttempt) {
        throw new Error(`${label} failed: ${normalized.message}`);
      }

      await sleep(retryDelaysMs[attempt]);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`${label} failed`);
}

function normalizeAirtableError(error: unknown) {
  const maybeError = error as {
    message?: string;
    statusCode?: number;
    status?: number;
    error?: string;
  };
  const statusCode = maybeError.statusCode ?? maybeError.status;
  const message =
    maybeError.message ||
    maybeError.error ||
    (typeof error === "string" ? error : "Unknown Airtable error");

  return {
    message,
    statusCode,
    retryable:
      typeof statusCode === "number"
        ? retryableStatusCodes.has(statusCode)
        : message.toLowerCase().includes("network") ||
          message.toLowerCase().includes("timeout") ||
          message.toLowerCase().includes("econnreset"),
  };
}

function escapeFormulaString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
