import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionController } from './session.controller';
import { UserCredentialController } from './user-credential.controller';
import { UserCredentialService } from './user-credential.service';
import { PermissionModule } from '../permission/permission.module';

@Module({
  imports: [PermissionModule],
  controllers: [AuthController, SessionController, UserCredentialController],
  providers: [AuthService, UserCredentialService],
  exports: [AuthService, UserCredentialService],
})
export class AuthModule {}

