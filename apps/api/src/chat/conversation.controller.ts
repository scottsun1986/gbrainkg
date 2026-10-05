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
  async list(
    @Req() req: any,
    @Query('limit') limitParam?: string,
    @Query('before') before?: string,
    @Query('paginated') paginated?: string,
  ) {
    const userId = await this.authService.userIdFromRequest(req);
    // 列表只回给侧栏/命令面板用的三个字段；kbScope 等 JSON 列在百级会话下
    // 会让登录首屏的并行 bootstrap 载荷无谓膨胀。
    //
    // 游标分页：首屏只取一页（默认 30），更早的会话由侧栏“加载更早会话”
    // 按需取。`?paginated=1` 返回 {items,nextCursor,hasMore}；不带该参数的
    // 旧客户端仍拿到裸数组，行为不变。
    const limit = Math.max(1, Math.min(200, Number.parseInt(limitParam || '30', 10) || 30));
    // Keyset 分页而非 offset：createdAt 不唯一，Prisma 的 cursor 要求唯一字段，
    // 这里改为先按 id 定位锚点行，再用 (createdAt, id) 严格小于锚点推进，
    // 长列表翻页不漏行也不重复，且复用现有 @@index([userId])。
    let anchor: { createdAt: Date; id: string } | null = null;
    if (before) {
      anchor = await this.prisma.conversation.findFirst({
        where: { id: before, userId },
        select: { createdAt: true, id: true },
      });
      if (!anchor) {
        const empty = { items: [], nextCursor: null, hasMore: false };
        if (paginated === undefined) return [];
        return empty;
      }
    }
    const rows = await this.prisma.conversation.findMany({
      where: {
        userId,
        ...(anchor
          ? {
              OR: [
                { createdAt: { lt: anchor.createdAt } },
                { createdAt: anchor.createdAt, id: { lt: anchor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: { id: true, title: true, createdAt: true },
    });
    // A run still in flight belongs to this user's conversations, so the sidebar
    // can mark them after a reload. Before this the running state lived only in
    // the browser, and a refresh left the list disagreeing with the server.
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const running = await this.prisma.chatRun.findMany({
      where: { conversationId: { in: page.map((row) => row.id) }, status: 'running' },
      select: { id: true, conversationId: true, stage: true },
    });
    const runningByConv = new Map(running.map((row) => [row.conversationId, row]));
    const withRun = page.map((row) => ({
      ...row,
      ...(runningByConv.has(row.id) ? { runStage: runningByConv.get(row.id)!.stage, runId: runningByConv.get(row.id)!.id } : {}),
    }));
    if (paginated === undefined) return withRun;
    return {
      items: withRun,
      nextCursor: page.length === limit && last ? last.id : null,
      hasMore: rows.length > limit,
    };
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
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(before
        ? { cursor: { id: before }, skip: 1, take: limit + 1 }
        : { take: limit + 1 }),
    });
    const hasMore = messages.length > limit;
    if (hasMore) messages.pop();
    messages.reverse();
    if (authorizationEnforced()) {
      const checks = new Map<string, boolean>();
      for (let index = 0; index < messages.length; index++) {
        const message: any = messages[index];
        if (message.role !== 'assistant') continue;
        // Older failed runs have no evidence manifest. Never return their
        // stored content: it can contain a partial, source-backed answer.
        if (message.dependencyManifest == null && Array.isArray(message.citationsSummary) && !message.citationsSummary.length
          && Array.isArray(message.processingTrace) && message.processingTrace.some((node: any) => node?.id === 'request_failure' && node.status === 'failed')) {
          const failure = message.processingTrace.find((node: any) => node?.id === 'request_failure');
          messages[index] = { ...message, content: /deadline|timeout|timed out/i.test(String(failure.summary))
            ? '知识检索超时，请重试。' : '本次问答处理失败，请重试。', citationsSummary: null, processingTrace: null } as any;
          continue;
        }
        const key = JSON.stringify(message.dependencyManifest);
        if (!checks.has(key)) checks.set(key, await validateEvidenceDependencies(userId, message.dependencyManifest));
        if (!checks.get(key)) messages[index] = { ...message, content: '该回答的来源已失效或您已无权访问。', citationsSummary: null, processingTrace: null, dependencyManifest: null } as any;
      }
    }
    // dependencyManifest 只服务端证据校验使用；trace JSON 可达百 KB/条，
    // 且只有展开“调用链”时才需要。列表接口按需用
    // GET /conversations/:conversationId/messages/:messageId/trace 单条拉取。
    const activeRun = await this.prisma.chatRun.findFirst({ where: { conversationId: id, userId, status: 'running' },
      orderBy: { startedAt: 'desc' }, select: { id: true, stage: true } });
    const safeMessages = messages.map(({ dependencyManifest: _drop, processingTrace: _traceDrop, ...message }: any) => message);
    const lastLoaded = messages[0];
    return {
      ...conversation,
      messages: safeMessages,
      activeRun: activeRun ? { runId: activeRun.id, conversationId: id, status: 'running', stage: activeRun.stage } : null,
      // R-3: 翻页元数据（超长会话按 nextCursor 取下一窗口；老客户端可忽略）。
      hasMore,
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
