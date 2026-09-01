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
    let answer = "";
    const citations: any[] = [];
    const subscription = stream$.subscribe({
      next: (event) => {
        if (response.writableEnded) return;
        const data: any = event.data;
        if (data?.type === "delta") answer += String(data.content || "");
        if (data?.type === "citation") citations.push(data);
        response.write(`data: ${JSON.stringify(event.data)}\n\n`);
      },
      error: (error) => {
        if (response.writableEnded) return;
        response.write(
          `data: ${JSON.stringify({ type: "error", content: error.message || "Chat failed" })}\n\n`,
        );
        response.end();
      },
      complete: () => {
        // RxJS 不会等待 async complete 回调；显式收口异常，确保数据库写入
        // 失败时也能结束 SSE，不让请求悬挂。
        void (async () => {
          try {
            if (answer) {
              await this.prisma.message.create({
                data: {
                  conversationId: conversation.id,
                  role: "assistant",
                  content: answer,
                  citationsSummary: citations,
                },
              });
            }
          } catch (error) {
            console.error("Failed to persist assistant message:", error);
          } finally {
            if (!response.writableEnded) response.end();
          }
        })();
      },
    });
    req.on("close", () => subscription.unsubscribe());
  }
}
