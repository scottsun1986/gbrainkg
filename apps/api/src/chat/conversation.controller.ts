import { Body, Controller, Get, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AuthService } from '../auth/auth.service';

@Controller('api/v1/conversations')
export class ConversationController {
  private readonly prisma = new PrismaClient();

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

  @Post(':conversationId/messages/:messageId/feedback')
  async feedback(@Req() req: any, @Param('conversationId') conversationId: string, @Param('messageId') messageId: string, @Body() body: any) {
    const userId = await this.authService.userIdFromRequest(req);
    const message = await this.prisma.message.findFirst({ where: { id: messageId, conversationId, conversation: { userId }, role: 'assistant' } });
    if (!message) throw new NotFoundException('Message not found.');
    const feedback = ['useful', 'not_useful'].includes(body?.feedback) ? body.feedback : null;
    return this.prisma.message.update({ where: { id: messageId }, data: { feedback } });
  }
}
