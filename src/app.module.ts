import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { ConfigModule } from "./config/config.module";
import { JiraModule } from "./jira/jira.module";
import { SessionModule } from "./session/session.module";
import { TelegramModule } from "./telegram/telegram.module";
import { SchedulerModule } from "./scheduler/scheduler.module";
import { BlueprintModule } from "./blueprint/blueprint.module";
import { AppController } from "./app.controller";

@Module({
  imports: [
    ConfigModule,
    ScheduleModule.forRoot(),
    JiraModule,
    SessionModule,
    TelegramModule,
    SchedulerModule,
    BlueprintModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
