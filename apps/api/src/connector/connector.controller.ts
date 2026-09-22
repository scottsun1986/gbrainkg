import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { AuthService } from '../auth/auth.service';
import { PermissionService } from '../permission/permission.service';
import { ConnectorService } from './connector.service';
import { sourceTypeForKind } from './types';

@UseGuards(AuthGuard)
@Controller('api/v1/kbs/:kbId/connectors')
export class ConnectorController {
  constructor(
    private readonly connectorService: ConnectorService,
    private readonly permissionService: PermissionService,
    private readonly authService: AuthService,
  ) {}

  private async assertManager(req: any, kbId: string): Promise<string> {
    const userId: string =
      req.user?.id || (await this.authService.userIdFromRequest(req));
    const canManage = await this.permissionService.canManageKnowledgeBase(
      userId,
      kbId,
    );
    if (!canManage) {
      throw new ForbiddenException(
        'canManageKnowledgeBase required for connector operations',
      );
    }
    return userId;
  }

  private async assertSourceInKb(sourceId: string, kbId: string) {
    const source = await this.connectorService.getSource(sourceId);
    if (source.kbId !== kbId) {
      throw new ForbiddenException('connector does not belong to this kb');
    }
    return source;
  }

  @Post()
  async create(
    @Param('kbId') kbId: string,
    @Req() req: any,
    @Body()
    body: {
      kind?: string;
      name?: string;
      config?: Record<string, unknown>;
    },
  ) {
    await this.assertManager(req, kbId);
    const kind = String(body?.kind || '').trim();
    const name = String(body?.name || '').trim();
    if (!kind) throw new BadRequestException('kind is required');
    if (!name) throw new BadRequestException('name is required');
    const source = await this.connectorService.createSource({
      kbId,
      kind,
      name,
      config: body?.config || {},
    });
    return {
      source,
      sourceType: sourceTypeForKind(kind),
    };
  }

  @Get()
  async list(@Param('kbId') kbId: string, @Req() req: any) {
    await this.assertManager(req, kbId);
    return { sources: await this.connectorService.listSources(kbId) };
  }

  @Post(':id/sync')
  async sync(
    @Param('kbId') kbId: string,
    @Param('id') id: string,
    @Req() req: any,
  ) {
    await this.assertManager(req, kbId);
    await this.assertSourceInKb(id, kbId);
    return this.connectorService.sync(id);
  }

  @Get(':id/runs')
  async runs(
    @Param('kbId') kbId: string,
    @Param('id') id: string,
    @Req() req: any,
    @Query('limit') limit?: string,
  ) {
    await this.assertManager(req, kbId);
    await this.assertSourceInKb(id, kbId);
    const parsed = Number(limit || 20);
    return {
      runs: await this.connectorService.listRuns(
        id,
        Number.isFinite(parsed) ? parsed : 20,
      ),
    };
  }

  @Delete(':id')
  async remove(
    @Param('kbId') kbId: string,
    @Param('id') id: string,
    @Req() req: any,
  ) {
    await this.assertManager(req, kbId);
    await this.assertSourceInKb(id, kbId);
    return this.connectorService.deleteSource(id);
  }

  /** Webhook 入队：{externalId,title,content}。 */
  @Post(':id/ingest')
  async ingest(
    @Param('kbId') kbId: string,
    @Param('id') id: string,
    @Req() req: any,
    @Body() body: { externalId?: string; title?: string; content?: string },
  ) {
    await this.assertManager(req, kbId);
    const source = await this.assertSourceInKb(id, kbId);
    if (source.kind !== 'generic_webhook') {
      throw new BadRequestException('ingest is only available for generic_webhook');
    }
    try {
      const payload = this.connectorService.enqueueWebhook(id, {
        externalId: String(body?.externalId || ''),
        title: String(body?.title || ''),
        content: String(body?.content ?? ''),
      });
      return { queued: payload };
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : 'invalid webhook payload',
      );
    }
  }
}
