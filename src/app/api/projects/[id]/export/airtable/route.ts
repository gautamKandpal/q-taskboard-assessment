import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getCurrentUser,
  unauthorized,
  forbidden,
  notFound,
  getProjectMembership,
  canEditTasks,
} from "@/lib/auth";
import { exportTasksToAirtable } from "@/lib/airtable";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const user = await getCurrentUser(req);
  if (!user) return unauthorized();

  const { id: projectId } = await params;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!project) return notFound("project not found");

  const membership = await getProjectMembership(user.id, projectId);
  if (!membership) return forbidden("you are not a member of this project");
  if (!canEditTasks(membership.role)) {
    return forbidden("viewers cannot export tasks");
  }

  const tasks = await prisma.task.findMany({
    where: { projectId },
    include: {
      project: { select: { id: true, name: true } },
      assignee: { select: { id: true, name: true, email: true } },
    },
    orderBy: [{ status: "asc" }, { position: "asc" }],
  });

  try {
    const exportSummary = await exportTasksToAirtable(projectId, tasks);
    return NextResponse.json({ export: exportSummary });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Airtable export failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
