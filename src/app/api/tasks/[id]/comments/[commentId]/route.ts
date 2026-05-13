import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getCurrentUser,
  unauthorized,
  forbidden,
  notFound,
  badRequest,
  getProjectMembership,
  canEditTasks,
} from "@/lib/auth";
import { updateCommentSchema } from "@/schemas/comment";

type Params = { params: Promise<{ id: string; commentId: string }> };

async function getWritableComment(req: NextRequest, taskId: string, commentId: string) {
  const user = await getCurrentUser(req);
  if (!user) return { response: unauthorized() };

  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    select: { id: true, taskId: true, task: { select: { projectId: true } } },
  });
  if (!comment || comment.taskId !== taskId) {
    return { response: notFound("comment not found") };
  }

  const membership = await getProjectMembership(user.id, comment.task.projectId);
  if (!membership) {
    return { response: forbidden("you are not a member of this project") };
  }
  if (!canEditTasks(membership.role)) {
    return { response: forbidden("viewers cannot modify comments") };
  }

  return { comment };
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id, commentId } = await params;
  const result = await getWritableComment(req, id, commentId);
  if (result.response) return result.response;

  const body = await req.json().catch(() => null);
  const parsed = updateCommentSchema.safeParse(body);
  if (!parsed.success) return badRequest("invalid input", parsed.error.flatten());

  const comment = await prisma.comment.update({
    where: { id: commentId },
    data: { body: parsed.data.body },
    include: {
      author: { select: { id: true, name: true, email: true } },
    },
  });

  return NextResponse.json({ comment });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const { id, commentId } = await params;
  const result = await getWritableComment(req, id, commentId);
  if (result.response) return result.response;

  await prisma.comment.delete({ where: { id: commentId } });

  return NextResponse.json({ ok: true });
}
