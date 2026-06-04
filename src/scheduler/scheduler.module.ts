import { Module } from "@nestjs/common";
import { SchedulerService } from "./scheduler.service";
import { TelegramModule } from "../telegram/telegram.module";
import { BlueprintModule } from "../blueprint/blueprint.module";

@Module({
  imports: [TelegramModule, BlueprintModule],
  providers: [SchedulerService],
})
export class SchedulerModule {}
