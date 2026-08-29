import { Global, Module } from '@nestjs/common';
import { ModelConfigService } from './model-config.service';

@Global()
@Module({ providers: [ModelConfigService], exports: [ModelConfigService] })
export class ModelConfigModule {}
