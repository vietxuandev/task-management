import { Module } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { BlueprintModule } from '../blueprint/blueprint.module';

@Module({
  imports: [BlueprintModule],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
