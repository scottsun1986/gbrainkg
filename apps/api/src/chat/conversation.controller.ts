import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { getPrismaClient } from '../prisma';
import { AuthService } from '../auth/auth.service';
import { AuthGuard } from '../auth/auth.guard';

@UseGuards(AuthGuard)
@Controller('api/v1/conversations')
export class ConversationController {
  private readonly prisma = getPrismaClient();

  constructor(private readonly authService: AuthService) {}

  @Get()
  async list(@Req() req: any) {
    const userId = await this.authService.userIdFromRequest(req);
    return this.prisma.conversation.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 100 });
  }

  @Get(':id')
  async get(@Req() req: any, @Param('id') id: string) {
    const userId = await this.authService.userIdFromRequest(req);
    const conversation = await this.prisma.conversation.findFirst({ where: { id, userId }, include: { messages: { orderBy: { createdAt: 'asc' } } } });
    if (!conversation) throw new NotFoundException('Conversation not found.');
    return conversation;
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
      select: { id: true, role: true, latencyMs: true, citationsSummary: true, processingTrace: true, createdAt: true },
    });
    if (!message) throw new NotFoundException('Message not found.');
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
