import { Module } from '@nestjs/common';
import { RaptorService } from './raptor.service';

@Module({
  providers: [RaptorService],
  exports: [RaptorService],
})
export class RaptorModule {}
