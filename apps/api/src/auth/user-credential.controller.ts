import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { UserCredentialService } from './user-credential.service';

@UseGuards(AuthGuard)
@Controller()
export class UserCredentialController {
  constructor(
    private readonly userCredentialService: UserCredentialService,
    private readonly authService: AuthService,
  ) {}

  @Get('api/v1/user/credentials')
  async listCredentials(@Req() req: any) {
    const userId = await this.authService.userIdFromRequest(req);
    const data = await this.userCredentialService.getCredentials(userId);
    return {
      code: 200,
      msg: '操作成功',
      data,
    };
  }

  @Post('api/v1/user/credentials')
  async createCredential(
    @Req() req: any,
    @Body() body: { appId?: string; name?: string },
  ) {
    const userId = await this.authService.userIdFromRequest(req);
    const data = await this.userCredentialService.createCredential(userId, body || {});
    return {
      code: 200,
      msg: '凭证创建成功',
      data,
    };
  }

  @Put('api/v1/user/credentials/:id')
  async updateCredential(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { name?: string; status?: string; rotateSecret?: boolean },
  ) {
    const userId = await this.authService.userIdFromRequest(req);
    const data = await this.userCredentialService.updateCredential(userId, id, body || {});
    return {
      code: 200,
      msg: body?.rotateSecret ? '密钥重置成功' : '凭证更新成功',
      data,
    };
  }

  @Delete('api/v1/user/credentials/:id')
  async deleteCredential(@Req() req: any, @Param('id') id: string) {
    const userId = await this.authService.userIdFromRequest(req);
    const data = await this.userCredentialService.deleteCredential(userId, id);
    return {
      code: 200,
      msg: '凭证已删除',
      data,
    };
  }

  // Compatible endpoint with the reference openapi-spec-20260812.json
  @Post('api/open-api/credential/generate')
  async generateCredentialCompatible(
    @Req() req: any,
    @Query('appId') queryAppId?: string,
    @Body() body?: { appId?: string; name?: string },
  ) {
    const userId = await this.authService.userIdFromRequest(req);
    const appId = queryAppId || body?.appId;
    const name = body?.name || 'OpenAPI 服务凭证';
    const result = await this.userCredentialService.createCredential(userId, {
      appId,
      name,
    });
    return {
      code: 200,
      msg: '操作成功',
      data: {
        app_id: result.appId,
        app_secret: result.appSecret,
        note: result.note,
      },
    };
  }
}
