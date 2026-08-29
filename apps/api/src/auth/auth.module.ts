import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionController } from './session.controller';
import { PermissionModule } from '../permission/permission.module';

@Module({
  imports: [PermissionModule],
  controllers: [AuthController, SessionController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
