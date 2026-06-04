import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Telegraf, Context } from "telegraf";
import { SessionService } from "../session/session.service";
import { JiraService } from "../jira/jira.service";
import { BlueprintService } from "../blueprint/blueprint.service";
import { SubTask } from "../jira/jira.types";

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private readonly bot: Telegraf;
  private readonly chatId: string;
  private readonly defaultLogHours: number;
  private readonly jiraBaseUrl: string;

  constructor(
    private readonly config: ConfigService,
    private readonly sessionService: SessionService,
    private readonly jiraService: JiraService,
    private readonly blueprintService: BlueprintService,
  ) {
    const token = this.config.getOrThrow<string>("TELEGRAM_BOT_TOKEN");
    this.chatId = this.config.getOrThrow<string>("TELEGRAM_CHAT_ID");
    this.defaultLogHours = this.config.get<number>("DEFAULT_LOG_HOURS") ?? 7;
    this.jiraBaseUrl = this.config.getOrThrow<string>("JIRA_BASE_URL");
    this.bot = new Telegraf(token);
  }

  async onModuleInit(): Promise<void> {
    this.bot.telegram
      .setMyCommands([
        { command: "checkin", description: "Trigger morning check-in manually" },
        { command: "checkout", description: "Trigger evening check-in manually" },
        { command: "punch", description: "Manual Blueprint punch" },
      ])
      .catch((err) => this.logger.error("Failed to set bot commands", err));

    this.bot.command("checkin", (ctx) => this.triggerMorningCheckIn(ctx));
    this.bot.command("checkout", (ctx) => this.triggerEveningCheckIn(ctx));
    this.bot.command("punch", (ctx) => this.handleManualPunch(ctx));

    this.bot.use(async (ctx: Context, next) => {
      if (ctx.message && "text" in ctx.message) {
        await this.handleMessage(ctx);
      }
      await next();
    });

    this.bot
      .launch()
      .then(() => this.logger.log("Telegram bot launched"))
      .catch((err) => this.logger.error("Failed to launch Telegram bot", err));
  }

  async onModuleDestroy(): Promise<void> {
    this.bot.stop();
    this.logger.log("Telegram bot stopped");
  }

  async sendMessage(text: string): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(this.chatId, text, {
        parse_mode: "HTML",
      });
      this.logger.log("Message sent to Telegram");
    } catch (error) {
      this.logger.error("Failed to send Telegram message", error);
    }
  }

  // ── /checkin command + morning cron ──

  async triggerMorningCheckIn(ctx?: Context): Promise<void> {
    this.logger.log("Running morning check-in");
    try {
      const subTasks = await this.jiraService.getMySubTasks();

      const inProgress = subTasks.filter((t) => t.status === "In Progress");
      const todo = subTasks.filter((t) => t.status !== "In Progress");

      const message = this.buildMorningMessage(inProgress, todo);
      await this.sendOrReply(ctx, message);

      const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
      this.sessionService.setSession(this.chatId, {
        type: "morning",
        step: "AWAIT_TICKET",
        data: { todo },
        expiresAt,
      });

      this.logger.log("Morning check-in sent");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error("Morning check-in failed", error);
      await this.sendOrReply(ctx, `❌ Morning check-in error: ${msg}`);
    }
  }

  // ── /checkout command + evening cron ──

  async triggerEveningCheckIn(ctx?: Context): Promise<void> {
    this.logger.log("Running evening check-in");
    try {
      const subTasks = await this.jiraService.getMySubTasks();
      const incomplete = subTasks.filter((t) => t.status !== "Done");

      if (incomplete.length === 0) {
        await this.sendOrReply(
          ctx,
          "🎉 All sub-tasks are done! Great work today!",
        );
        return;
      }

      const message = this.buildEveningMessage(incomplete);
      await this.sendOrReply(ctx, message);

      const expiresAt = new Date(Date.now() + 3 * 60 * 60 * 1000);
      this.sessionService.setSession(this.chatId, {
        type: "evening",
        step: "AWAIT_TICKET_SELECTION",
        data: { subTasks: incomplete },
        expiresAt,
      });

      this.logger.log("Evening check-in sent");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error("Evening check-in failed", error);
      await this.sendOrReply(ctx, `❌ Evening check-in error: ${msg}`);
    }
  }

  // ── /punch command ──

  async handleManualPunch(ctx: Context): Promise<void> {
    this.logger.log("Manual punch triggered");
    try {
      const result = await this.blueprintService.punch();
      if (result === 0) {
        await ctx.reply("⏭ Punch skipped (leave or holiday today)");
      } else {
        const now = new Date();
        const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
        await ctx.reply(`✅ Punched successfully at ${time}!`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error("Manual punch failed", error);
      await ctx.reply(`❌ Punch failed: ${msg}`);
    }
  }

  // ── text message handler ──

  private async handleMessage(ctx: Context): Promise<void> {
    const message = ctx.message;
    if (!message || !("text" in message)) return;

    const fromChatId = String(message.chat.id);
    const text = message.text.trim();

    if (fromChatId !== this.chatId) {
      this.logger.warn(
        `Ignoring message from unauthorized chat: ${fromChatId}`,
      );
      return;
    }

    const session = this.sessionService.getSession(this.chatId);
    if (!session) {
      await ctx.reply(
        "No active session. Wait for the morning/evening check-in.",
      );
      return;
    }

    try {
      if (session.type === "morning") {
        await this.handleMorningReply(ctx, text, session);
      } else {
        await this.handleEveningReply(ctx, text, session);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("Jira error in message handler", error);
      await ctx.reply(`❌ Jira error: ${message}`);
    }
  }

  private async handleMorningReply(
    ctx: Context,
    text: string,
    session: NonNullable<ReturnType<SessionService["getSession"]>>,
  ): Promise<void> {
    if (session.step !== "AWAIT_TICKET") return;

    const todo = session.data["todo"] as SubTask[];
    const input = text.trim();

    if (input.toLowerCase() === "skip") {
      await ctx.reply("👍 Have a productive day!");
      this.sessionService.clearSession(this.chatId);
      return;
    }

    const num = parseInt(input, 10);
    if (isNaN(num) || num < 1 || num > todo.length) {
      await ctx.reply(
        `❌ Please reply with a number between 1 and ${todo.length}, or "skip".`,
      );
      return;
    }

    const selected = todo[num - 1]!;
    await this.jiraService.transitionIssue(selected.key, "In Progress");
    await ctx.replyWithHTML(
      `✅ ${this.formatTicketLink(selected.key)} is now In Progress!`,
    );

    this.sessionService.clearSession(this.chatId);
  }

  private async handleEveningReply(
    ctx: Context,
    text: string,
    session: NonNullable<ReturnType<SessionService["getSession"]>>,
  ): Promise<void> {
    const step = session.step;
    const input = text.trim();

    if (input.toLowerCase() === "skip") {
      await ctx.reply("👍 Have a good evening!");
      this.sessionService.clearSession(this.chatId);
      return;
    }

    if (step === "AWAIT_TICKET_SELECTION") {
      await this.handleTicketSelection(ctx, input, session);
    } else if (step === "AWAIT_HOURS") {
      await this.handleHours(ctx, input, session);
    } else if (step === "AWAIT_DONE_CONFIRM") {
      await this.handleDoneConfirm(ctx, input, session);
    }
  }

  private async handleTicketSelection(
    ctx: Context,
    input: string,
    session: NonNullable<ReturnType<SessionService["getSession"]>>,
  ): Promise<void> {
    const subTasks = session.data["subTasks"] as SubTask[];
    const num = parseInt(input, 10);

    if (isNaN(num) || num < 1 || num > subTasks.length) {
      await ctx.reply(
        `Please reply with a number between 1 and ${subTasks.length}.`,
      );
      return;
    }

    const selected = subTasks[num - 1]!;
    session.data["selectedKey"] = selected.key;
    session.step = "AWAIT_HOURS";
    this.sessionService.setSession(this.chatId, session);

    await ctx.replyWithHTML(
      `How many hours for ${this.formatTicketLink(selected.key)} ${selected.summary}? (Default: ${this.defaultLogHours}h)`,
    );
  }

  private async handleHours(
    ctx: Context,
    input: string,
    session: NonNullable<ReturnType<SessionService["getSession"]>>,
  ): Promise<void> {
    const key = session.data["selectedKey"] as string;
    const hoursStr = input.trim();
    let hours = this.defaultLogHours;

    if (hoursStr !== "") {
      const parsed = parseFloat(hoursStr);
      if (isNaN(parsed) || parsed <= 0) {
        await ctx.reply("Please enter a valid number of hours.");
        return;
      }
      hours = parsed;
    }

    const seconds = Math.round(hours * 3600);
    await this.jiraService.logWork(key, seconds, "Daily work log");
    await ctx.replyWithHTML(
      `✅ Logged ${JiraService.formatTime(seconds)} to ${this.formatTicketLink(key)}`,
    );

    const details = await this.jiraService.getSubTaskDetails(key);
    if (
      JiraService.isEstimateExceeded(
        details.timeoriginalestimate,
        details.timespent,
        0,
      )
    ) {
      session.step = "AWAIT_DONE_CONFIRM";
      this.sessionService.setSession(this.chatId, session);
      await ctx.reply('Mark as Done? Reply "yes" or "no"');
    } else {
      this.sessionService.clearSession(this.chatId);
    }
  }

  private async handleDoneConfirm(
    ctx: Context,
    input: string,
    session: NonNullable<ReturnType<SessionService["getSession"]>>,
  ): Promise<void> {
    const key = session.data["selectedKey"] as string;
    const answer = input.toLowerCase().trim();

    if (answer === "yes") {
      await this.jiraService.transitionIssue(key, "Done");
      await ctx.replyWithHTML(
        `✅ ${this.formatTicketLink(key)} marked as Done!`,
      );
    } else if (answer === "no") {
      await ctx.reply("👍 Good work!");
    } else {
      await ctx.reply('Please reply "yes" or "no".');
      return;
    }

    this.sessionService.clearSession(this.chatId);
  }

  // ── helpers ──

  private async sendOrReply(
    ctx: Context | undefined,
    text: string,
  ): Promise<void> {
    if (ctx) {
      await ctx.replyWithHTML(text);
    } else {
      await this.sendMessage(text);
    }
  }

  private buildMorningMessage(inProgress: SubTask[], todo: SubTask[]): string {
    let msg = "<b>🌅 Good morning! Here's your daily update:</b>\n";

    if (inProgress.length > 0) {
      msg += "\n<b>🔄 In Progress:</b>\n";
      for (const t of inProgress) {
        msg += this.formatTicketLine(t, null);
      }
    } else {
      msg += "\n<b>🔄 In Progress:</b> (none)\n";
    }

    if (todo.length > 0) {
      msg += "\n<b>📋 To Do:</b>\n";
      for (let i = 0; i < todo.length; i++) {
        msg += this.formatTicketLine(todo[i]!, i + 1);
      }
    } else {
      msg += "\n<b>📋 To Do:</b> (none)\n";
    }

    msg += '\n<i>Reply with a number to start a ticket, or "skip" to skip.</i>';
    return msg;
  }

  private buildEveningMessage(subTasks: SubTask[]): string {
    let msg = "<b>🌙 Evening check-in! Log your time:</b>\n\n";

    for (let i = 0; i < subTasks.length; i++) {
      msg += this.formatTicketLine(subTasks[i]!, i + 1);
    }

    msg += '\n<i>Reply with a number to log time, or "skip" to skip.</i>';
    return msg;
  }

  private formatTicketLine(t: SubTask, num: number | null): string {
    const estimate = JiraService.formatTime(t.timeoriginalestimate);
    const logged = JiraService.formatTime(t.timespent);
    const remaining = JiraService.formatTime(t.timeestimate);
    const parentInfo = t.parent
      ? ` (👆 ${this.formatTicketLink(t.parent.key)})`
      : "";
    const prefix =
      num !== null
        ? `  <b>${num}.</b>`
        : "  •";
    return `${prefix} <b>${this.formatTicketLink(t.key)}</b>${parentInfo} — ${t.summary}\n      Est: ${estimate} | Logged: ${logged} | Remaining: ${remaining}\n\n`;
  }

  private formatTicketLink(key: string): string {
    return `<a href="${this.jiraBaseUrl}/browse/${key}">${key}</a>`;
  }

  getBot(): Telegraf {
    return this.bot;
  }
}
