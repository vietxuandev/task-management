import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import * as Joi from 'joi';

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        JIRA_BASE_URL: Joi.string().uri().required(),
        JIRA_USER_EMAIL: Joi.string().email().required(),
        JIRA_API_TOKEN: Joi.string().required(),
        JIRA_PROJECT_KEY: Joi.string().required(),
        JIRA_ASSIGNEE_ACCOUNT_ID: Joi.string().required(),
        TELEGRAM_BOT_TOKEN: Joi.string().required(),
        TELEGRAM_CHAT_ID: Joi.string().required(),
        MORNING_CRON: Joi.string().default('0 8 * * 1-5'),
        EVENING_CRON: Joi.string().default('0 17 * * 1-5'),
        TIMEZONE: Joi.string().default('Asia/Ho_Chi_Minh'),
        DEFAULT_LOG_HOURS: Joi.number().default(7),
        BLUEPRINT_URL: Joi.string().uri().optional().allow(''),
        BLUEPRINT_USERNAME: Joi.string().optional().allow(''),
        BLUEPRINT_PASSWORD: Joi.string().optional().allow(''),
        PUNCH_IN_START: Joi.string().default('08:00'),
        PUNCH_IN_END: Joi.string().default('08:20'),
        PUNCH_OUT_START: Joi.string().default('17:40'),
        PUNCH_OUT_END: Joi.string().default('18:00'),
      }),
      validationOptions: {
        allowUnknown: true,
        abortEarly: true,
      },
    }),
  ],
})
export class ConfigModule {}
