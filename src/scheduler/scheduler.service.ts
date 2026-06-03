import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { TelegramService } from '../telegram/telegram.service';
import { BlueprintService } from '../blueprint/blueprint.service';

@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly telegramService: TelegramService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly blueprintService: BlueprintService,
  ) {}

  onModuleInit(): void {
    const morningCron = this.config.get<string>('MORNING_CRON') ?? '0 8 * * 1-5';
    const eveningCron = this.config.get<string>('EVENING_CRON') ?? '0 17 * * 1-5';
    const timezone = this.config.get<string>('TIMEZONE') ?? 'Asia/Ho_Chi_Minh';

    const morningJob = new CronJob(
      morningCron,
      () => { void this.telegramService.triggerMorningCheckIn(); },
      null,
      false,
      timezone,
    );

    const eveningJob = new CronJob(
      eveningCron,
      () => { void this.telegramService.triggerEveningCheckIn(); },
      null,
      false,
      timezone,
    );

    this.schedulerRegistry.addCronJob('morning-check-in', morningJob);
    this.schedulerRegistry.addCronJob('evening-check-in', eveningJob);

    morningJob.start();
    eveningJob.start();

    // Blueprint punch cron jobs
    const punchInCron = this.config.get<string>('BLUEPRINT_PUNCH_IN_CRON') ?? '10 8 * * 1-5';
    const punchOutCron = this.config.get<string>('BLUEPRINT_PUNCH_OUT_CRON') ?? '45 17 * * 1-5';

    const punchInJob = new CronJob(
      punchInCron,
      () => { void this.handleBlueprintPunchIn(); },
      null,
      false,
      timezone,
    );

    const punchOutJob = new CronJob(
      punchOutCron,
      () => { void this.handleBlueprintPunchOut(); },
      null,
      false,
      timezone,
    );

    this.schedulerRegistry.addCronJob('blueprint-punch-in', punchInJob);
    this.schedulerRegistry.addCronJob('blueprint-punch-out', punchOutJob);

    punchInJob.start();
    punchOutJob.start();

    this.logger.log(
      `Cron jobs registered — morning: "${morningCron}", evening: "${eveningCron}", punch-in: "${punchInCron}", punch-out: "${punchOutCron}", tz: ${timezone}`,
    );
  }

  async handleBlueprintPunchIn(): Promise<void> {
    try {
      const result = await this.blueprintService.punch();
      if (result === 0) {
        await this.telegramService.sendMessage('⏭ Punch in skipped (leave or holiday today)');
      } else {
        const now = new Date();
        const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        await this.telegramService.sendMessage(`✅ Punched in successfully at ${time}!`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error('Blueprint punch in failed', error);
      await this.telegramService.sendMessage(`❌ Punch in failed: ${msg}`);
    }
  }

  async handleBlueprintPunchOut(): Promise<void> {
    try {
      const result = await this.blueprintService.punch();
      if (result === 0) {
        await this.telegramService.sendMessage('⏭ Punch out skipped (leave or holiday today)');
      } else {
        const now = new Date();
        const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        await this.telegramService.sendMessage(`✅ Punched out successfully at ${time}!`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error('Blueprint punch out failed', error);
      await this.telegramService.sendMessage(`❌ Punch out failed: ${msg}`);
    }
  }
}
