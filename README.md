# Jira Telegram Time-Tracking Assistant

A NestJS service that sends morning/evening check-ins via Telegram and lets you start, log time, and complete Jira sub-tasks through chat.

## How It Works

- **Morning (weekdays 8 AM)**: Lists your In Progress and To Do sub-tasks. Reply with a ticket key to start one.
- **Evening (weekdays 5 PM)**: Lists all incomplete sub-tasks. Reply with a number to log hours, optionally mark as Done.

All operations target **sub-tasks only** (issuetype = Sub-task).

## Setup

### 1. Prerequisites

- Node.js 22+
- A Jira Cloud account with API access
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))

### 2. Get Your Jira API Token

1. Go to https://id.atlassian.com/manage-profile/security/api-tokens
2. Click "Create API token"
3. Copy the token

### 3. Get Your Jira Account ID

1. Go to `https://oneline.atlassian.net/rest/api/3/myself`
2. Copy the `accountId` field

### 4. Create a Telegram Bot & Get Chat ID

1. Message [@BotFather](https://t.me/BotFather) and use `/newbot`
2. Copy the bot token
3. Start a chat with your bot and send a message
4. Visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
5. Copy the `chat.id` from the response

### 5. Configure Environment

```bash
cp .env.example .env
```

Fill in your `.env`:

| Variable | Description |
|---|---|
| `JIRA_BASE_URL` | Your Jira Cloud URL |
| `JIRA_USER_EMAIL` | Your Jira account email |
| `JIRA_API_TOKEN` | API token from step 2 |
| `JIRA_PROJECT_KEY` | Project key (e.g. `PROJ`) |
| `JIRA_ASSIGNEE_ACCOUNT_ID` | Account ID from step 3 |
| `TELEGRAM_BOT_TOKEN` | Bot token from step 4 |
| `TELEGRAM_CHAT_ID` | Chat ID from step 4 |
| `MORNING_CRON` | Cron for morning check-in (default: `0 8 * * 1-5`) |
| `EVENING_CRON` | Cron for evening check-in (default: `0 17 * * 1-5`) |
| `TIMEZONE` | Timezone (default: `Asia/Ho_Chi_Minh`) |
| `DEFAULT_LOG_HOURS` | Default hours when user sends blank (default: `7`) |

### 6. Run Locally

```bash
npm install
npm run start:dev
```

### 7. Run with Docker

```bash
docker build -t jira-telegram-assistant .
docker run --env-file .env -p 3000:3000 jira-telegram-assistant
```

## Health Check

```
GET /health → { "status": "ok", "timestamp": "..." }
```
