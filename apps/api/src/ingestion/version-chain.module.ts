import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { VersionChainService } from './version-chain.service';
import { DocumentVersionController } from './document-version.controller';

@Module({
  imports: [AuthModule],
  providers: [VersionChainService],
  controllers: [DocumentVersionController],
  exports: [VersionChainService],
})
export class VersionChainModule {}
