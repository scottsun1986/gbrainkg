import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { getPrismaClient } from '../prisma';
import { AuthService } from '../auth/auth.service';
import { AuthGuard } from '../auth/auth.guard';
import { authorizationEnforced } from '../permission/authorization-revision';
import { validateEvidenceDependencies } from '../permission/evidence-dependencies';

@UseGuards(AuthGuard)
@Controller('api/v1/conversations')
export class ConversationController {
  private readonly prisma = getPrismaClient();

  constructor(private readonly authService: AuthService) {}

  @Get()
  async list(@Req() req: any) {
    const userId = await this.authService.userIdFromRequest(req);
    // 列表只回给侧栏/命令面板用的三个字段；kbScope 等 JSON 列在百级会话下
    // 会让登录首屏的并行 bootstrap 载荷无谓膨胀。
    return this.prisma.conversation.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, title: true, createdAt: true },
    });
  }

  @Get(':id')
  async get(@Req() req: any, @Param('id') id: string, @Query('limit') limitParam?: string, @Query('before') before?: string) {
    const userId = await this.authService.userIdFromRequest(req);
    // R-3: 会话消息改游标分页。默认窗口 200 条（现网会话长度内体验无变化），
    // ?before=<messageId> 取该消息之后的下一窗口，不再一次拉回全部消息。
    const limit = Math.max(1, Math.min(500, Number.parseInt(limitParam || '200', 10) || 200));
    const conversation = await this.prisma.conversation.findFirst({ where: { id, userId } });
    if (!conversation) throw new NotFoundException('Conversation not found.');
    const messages = await this.prisma.message.findMany({
      where: { conversationId: id, ...(before ? {} : {}) },
      orderBy: { createdAt: 'asc' },
      ...(before
        ? { cursor: { id: before }, skip: 1, take: limit }
        : { take: limit }),
    });
    if (authorizationEnforced()) {
      const checks = new Map<string, boolean>();
      for (let index = 0; index < messages.length; index++) {
        const message: any = messages[index];
        if (message.role !== 'assistant') continue;
        const key = JSON.stringify(message.dependencyManifest);
        if (!checks.has(key)) checks.set(key, await validateEvidenceDependencies(userId, message.dependencyManifest));
        if (!checks.get(key)) messages[index] = { ...message, content: '该回答的来源已失效或您已无权访问。', citationsSummary: null, processingTrace: null, dependencyManifest: null } as any;
      }
    }
    // dependencyManifest 只服务端证据校验使用；trace JSON 可达百 KB/条，
    // 不下发给前端。
    const totalMessages = await this.prisma.message.count({ where: { conversationId: id } });
    const safeMessages = messages.map(({ dependencyManifest: _drop, ...message }: any) => message);
    const lastLoaded = messages[messages.length - 1];
    return {
      ...conversation,
      messages: safeMessages,
      // R-3: 翻页元数据（超长会话按 nextCursor 取下一窗口；老客户端可忽略）。
      hasMore: Boolean(lastLoaded) && totalMessages > safeMessages.length + (before ? 0 : 0) && messages.length === limit,
      nextCursor: lastLoaded?.id ?? null,
    };
  }

  @Patch(':id')
  async update(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    const userId = await this.authService.userIdFromRequest(req);
    const title = String(body?.title || '').trim();
    if (!title) throw new NotFoundException('Title cannot be empty.');
    const conversation = await this.prisma.conversation.findFirst({ where: { id, userId } });
    if (!conversation) throw new NotFoundException('Conversation not found.');
    return this.prisma.conversation.update({ where: { id }, data: { title } });
  }

  @Delete(':id')
  async remove(@Req() req: any, @Param('id') id: string) {
    const userId = await this.authService.userIdFromRequest(req);
    const conversation = await this.prisma.conversation.findFirst({ where: { id, userId } });
    if (!conversation) throw new NotFoundException('Conversation not found.');
    return this.prisma.conversation.delete({ where: { id } });
  }

  @Post(':conversationId/messages/:messageId/feedback')
  async feedback(@Req() req: any, @Param('conversationId') conversationId: string, @Param('messageId') messageId: string, @Body() body: any) {
    const userId = await this.authService.userIdFromRequest(req);
    const message = await this.prisma.message.findFirst({ where: { id: messageId, conversationId, conversation: { userId }, role: 'assistant' } });
    if (!message) throw new NotFoundException('Message not found.');
    if (authorizationEnforced() && !await validateEvidenceDependencies(userId, message.dependencyManifest)) {
      throw new NotFoundException('Evidence access is no longer available.');
    }
    const feedback = ['useful', 'not_useful'].includes(body?.feedback) ? body.feedback : null;
    const updated = await this.prisma.message.update({ where: { id: messageId }, data: { feedback } });

    // Negative feedback becomes a durable triage case instead of a dead flag.
    // Repeated clicks update the existing open case rather than multiplying
    // training/evaluation work items for the same answer.
    if (feedback === 'not_useful') {
      const [questionMessage, existingCase] = await Promise.all([
        this.prisma.message.findFirst({
          where: {
            conversationId,
            role: 'user',
            createdAt: { lte: message.createdAt },
          },
          orderBy: { createdAt: 'desc' },
          select: { content: true },
        }),
        this.prisma.feedbackCase.findFirst({
          where: { messageId, status: { in: ['new', 'triaging'] } },
          select: { id: true },
        }),
      ]);
      const correction = String(body?.correction || '').trim().slice(0, 4000) || null;
      const data = {
        question: questionMessage?.content || '',
        answer: message.content,
        evidence: message.citationsSummary ?? undefined,
        trace: message.processingTrace ?? undefined,
        correction,
      };
      if (existingCase) {
        await this.prisma.feedbackCase.update({ where: { id: existingCase.id }, data });
      } else {
        await this.prisma.feedbackCase.create({
          data: { userId, messageId, ...data },
        });
      }
    }
    return updated;
  }

  @Get(':conversationId/messages/:messageId/trace')
  async getTrace(@Req() req: any, @Param('conversationId') conversationId: string, @Param('messageId') messageId: string) {
    const userId = await this.authService.userIdFromRequest(req);
    const message = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId, conversation: { userId } },
      select: { id: true, role: true, latencyMs: true, citationsSummary: true, processingTrace: true, dependencyManifest: true, createdAt: true },
    });
    if (!message) throw new NotFoundException('Message not found.');
    if (authorizationEnforced() && message.role === 'assistant' && !await validateEvidenceDependencies(userId, message.dependencyManifest)) {
      throw new NotFoundException('Evidence access is no longer available.');
    }
    return {
      messageId: message.id,
      role: message.role,
      latencyMs: message.latencyMs,
      citations: message.citationsSummary,
      trace: message.processingTrace,
      createdAt: message.createdAt,
    };
  }
}
