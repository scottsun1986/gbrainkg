import { Controller, Post, Body, MessageEvent, Req, Res, NotFoundException } from '@nestjs/common';
import { ChatService } from './chat.service';
import { Observable } from 'rxjs';
import { Response } from 'express';
import { AuthService } from '../auth/auth.service';
import { PrismaClient } from '@prisma/client';

@Controller('api/v1/chat')
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly authService: AuthService,
  ) {}

  private readonly prisma = new PrismaClient();

  @Post('completions')
  async streamCompletions(@Body() body: any, @Req() req: any, @Res() response: Response): Promise<void> {
    const userId = await this.authService.userIdFromRequest(req);
    const { message, kb_scope } = body;
    if (!String(message || '').trim()) throw new NotFoundException('Message is required.');
    let conversation = body.conversation_id
      ? await this.prisma.conversation.findFirst({ where: { id: body.conversation_id, userId } })
      : null;
    if (body.conversation_id && !conversation) throw new NotFoundException('Conversation not found.');
    if (!conversation) {
      conversation = await this.prisma.conversation.create({
        data: { userId, title: String(message).trim().slice(0, 120), kbScope: kb_scope || undefined },
      });
    }
    await this.prisma.message.create({ data: { conversationId: conversation.id, role: 'user', content: String(message).trim() } });

    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders?.();
    response.write(`data: ${JSON.stringify({ type: 'conversation', conversation_id: conversation.id })}\n\n`);

    const stream$: Observable<MessageEvent> = await this.chatService.handleChatStream(userId, message, kb_scope, conversation.id);
    let answer = '';
    const citations: any[] = [];
    const subscription = stream$.subscribe({
      next: (event) => {
        if (response.writableEnded) return;
        const data: any = event.data;
        if (data?.type === 'delta') answer += String(data.content || '');
        if (data?.type === 'citation') citations.push(data);
        response.write(`data: ${JSON.stringify(event.data)}\n\n`);
      },
      error: (error) => {
        if (response.writableEnded) return;
        response.write(`data: ${JSON.stringify({ type: 'error', content: error.message || 'Chat failed' })}\n\n`);
        response.end();
      },
      complete: () => {
        // RxJS 不会等待 async complete 回调；显式收口异常，确保数据库写入
        // 失败时也能结束 SSE，不让请求悬挂。
        void (async () => {
          try {
            if (answer) {
              await this.prisma.message.create({
                data: { conversationId: conversation.id, role: 'assistant', content: answer, citationsSummary: citations },
              });
            }
          } catch (error) {
            console.error('Failed to persist assistant message:', error);
          } finally {
            if (!response.writableEnded) response.end();
          }
        })();
      },
    });
    req.on('close', () => subscription.unsubscribe());
  }
}
