import {
  BadRequestException,
  Controller,
  Post,
  Body,
  Delete,
  Get,
  MessageEvent,
  Req,
  Res,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ChatService } from "./chat.service";
import { Observable } from "rxjs";
import { Response } from "express";
import { AuthService } from "../auth/auth.service";
import { PrismaClient } from "@prisma/client";
import { AuthGuard } from "../auth/auth.guard";

@UseGuards(AuthGuard)
@Controller("api/v1/chat")
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly authService: AuthService,
  ) {}

  private readonly prisma = new PrismaClient();

  @Get("memory")
  async recallMemory(@Req() req: any, @Query("query") query?: string, @Query("limit") rawLimit?: string) {
    const userId = await this.authService.userIdFromRequest(req);
    const limit = Math.max(1, Math.min(Number(rawLimit || 20) || 20, 100));
    return this.chatService.recallPersonalFacts(userId, query, limit);
  }

  @Post("memory")
  async rememberMemory(@Req() req: any, @Body() body: any) {
    const userId = await this.authService.userIdFromRequest(req);
    const fact = String(body?.fact || "").trim();
    if (!fact) throw new BadRequestException("fact is required.");
    return this.chatService.rememberPersonalFact(userId, fact, typeof body?.entity === "string" ? body.entity : undefined);
  }

  @Delete("memory/:id")
  async forgetMemory(@Req() req: any, @Param("id") id: string) {
    const userId = await this.authService.userIdFromRequest(req);
    return this.chatService.forgetPersonalFact(userId, id);
  }

  @Post("memory/context-pack")
  async loadMemoryContext(@Req() req: any, @Body() body: any) {
    const userId = await this.authService.userIdFromRequest(req);
    const entities = String(body?.entities || "").trim();
    if (!entities) throw new BadRequestException("entities is required.");
    return this.chatService.personalContextPack(userId, entities, typeof body?.session_id === "string" ? body.session_id : undefined);
  }

  @Post("completions")
  async streamCompletions(
    @Body() body: any,
    @Req() req: any,
    @Res() response: Response,
  ): Promise<void> {
    const userId = await this.authService.userIdFromRequest(req);
    const { message, kb_scope } = body;
    const normalizedMessage = String(message || "").trim();
    if (!normalizedMessage)
      throw new BadRequestException("Message is required.");
    if (normalizedMessage.length > 10_000)
      throw new BadRequestException("Message is too long.");
    if (Array.isArray(kb_scope) && kb_scope.length > 100)
      throw new BadRequestException("Knowledge-base scope is too large.");
    let conversation = body.conversation_id
      ? await this.prisma.conversation.findFirst({
          where: { id: body.conversation_id, userId },
        })
      : null;
    if (body.conversation_id && !conversation)
      throw new NotFoundException("Conversation not found.");
    if (!conversation) {
      conversation = await this.prisma.conversation.create({
        data: {
          userId,
          title: normalizedMessage.slice(0, 120),
          kbScope: kb_scope || undefined,
        },
      });
    }
    await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: "user",
        content: normalizedMessage,
      },
    });

    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders?.();
    response.write(
      `data: ${JSON.stringify({ type: "conversation", conversation_id: conversation.id })}\n\n`,
    );

    const stream$: Observable<MessageEvent> =
      await this.chatService.handleChatStream(
        userId,
        normalizedMessage,
        kb_scope,
        conversation.id,
      );
    const requestStartedAt = Date.now();
    let answer = "";
    let errorContent = "";
    let traceId = "";
    let totalTokens = 0;
    const citations: any[] = [];
    const traceNodes = new Map<string, any>();
    let finalizePromise: Promise<void> | null = null;
    const writeEvent = (data: any) => {
      if (!response.writableEnded) {
        response.write(`data: ${JSON.stringify(data)}\n\n`);
      }
    };
    const upsertPersistenceTrace = (status: string, summary: string) => {
      const previous = traceNodes.get("message_persistence");
      const now = new Date();
      const startedAt = previous?.startedAt || now.toISOString();
      const node = {
        id: "message_persistence",
        name: "回答与诊断链路落库",
        status,
        startedAt,
        ...(status !== "running"
          ? {
              finishedAt: now.toISOString(),
              durationMs: Math.max(0, now.getTime() - new Date(startedAt).getTime()),
            }
          : {}),
        summary,
      };
      traceNodes.set(node.id, node);
      writeEvent({ type: "trace", schema_version: 1, trace_id: traceId, node });
    };
    const finalize = () => {
      if (finalizePromise) return finalizePromise;
      finalizePromise = (async () => {
        const content = answer || errorContent || "本次问答未生成可保存的回答。";
        upsertPersistenceTrace("running", "正在保存回答、引用和处理链路");
        try {
          const created = await this.prisma.message.create({
            data: {
              conversationId: conversation.id,
              role: "assistant",
              content,
              citationsSummary: citations,
              processingTrace: [...traceNodes.values()],
              latencyMs: Date.now() - requestStartedAt,
            },
          });
          upsertPersistenceTrace("success", "回答、引用和处理链路已保存");
          await this.prisma.message.update({
            where: { id: created.id },
            data: { processingTrace: [...traceNodes.values()] },
          });
        } catch (error: any) {
          console.error("Failed to persist assistant message:", error);
          upsertPersistenceTrace(
            "failed",
            `保存失败：${String(error?.message || error || "未知错误").slice(0, 300)}`,
          );
        } finally {
          writeEvent({
            type: "done",
            total_tokens: totalTokens,
            latency_ms: Date.now() - requestStartedAt,
            trace_id: traceId,
          });
          if (!response.writableEnded) response.end();
        }
      })();
      return finalizePromise;
    };
    const subscription = stream$.subscribe({
      next: (event) => {
        if (response.writableEnded) return;
        const data: any = event.data;
        if (data?.type === "delta") answer += String(data.content || "");
        if (data?.type === "citation") citations.push(data);
        if (data?.type === "error") errorContent = String(data.content || "问答处理失败");
        if (data?.type === "trace" && data.node?.id) {
          traceId = String(data.trace_id || traceId);
          traceNodes.set(data.node.id, data.node);
        }
        if (data?.type === "done") {
          totalTokens = Number(data.total_tokens || 0);
          return;
        }
        writeEvent(event.data);
      },
      error: (error) => {
        if (response.writableEnded) return;
        errorContent = `问答处理失败：${error.message || "Chat failed"}`;
        const now = new Date().toISOString();
        const node = {
          id: "request_failure",
          name: "问答处理",
          status: "failed",
          startedAt: now,
          finishedAt: now,
          durationMs: 0,
          summary: String(error.message || "Chat failed").slice(0, 300),
        };
        traceNodes.set(node.id, node);
        writeEvent({ type: "trace", schema_version: 1, trace_id: traceId, node });
        writeEvent({ type: "error", content: errorContent });
        void finalize();
      },
      complete: () => {
        // RxJS 不会等待 async complete 回调，统一由 finalize 收口并在
        // 消息真正落库后再向浏览器发送 done。
        void finalize();
      },
    });
    req.on("close", () => subscription.unsubscribe());
  }
}
