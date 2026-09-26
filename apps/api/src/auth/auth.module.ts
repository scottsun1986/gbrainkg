import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionController } from './session.controller';
import { UserCredentialController } from './user-credential.controller';
import { UserCredentialService } from './user-credential.service';
import { MfaController } from './mfa.controller';
import { MfaService } from './mfa.service';
import { OidcController } from './oidc.controller';
import { OidcService } from './oidc.service';
import { PermissionModule } from '../permission/permission.module';

@Module({
  imports: [PermissionModule],
  controllers: [
    AuthController,
    SessionController,
    UserCredentialController,
    MfaController,
    OidcController,
  ],
  providers: [AuthService, UserCredentialService, MfaService, OidcService],
  exports: [AuthService, UserCredentialService, MfaService, OidcService],
})
export class AuthModule {}

