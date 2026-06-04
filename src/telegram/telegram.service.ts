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
import { SubTask, JiraTransition } from "../jira/jira.types";

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
        link_preview_options: { is_disabled: true },
      } as any);
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
      const todaySeconds = await this.jiraService.getTodayWorklogTotal();

      if (incomplete.length === 0) {
        const msg =
          "🎉 All sub-tasks are done! Great work today!\n\n" +
          this.formatDailyProgress(todaySeconds);
        await this.sendOrReply(ctx, msg);
        return;
      }

      const message =
        this.buildEveningMessage(incomplete) +
        "\n" +
        this.formatDailyProgress(todaySeconds);
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
      { link_preview_options: { is_disabled: true } } as any,
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
    } else if (step === "AWAIT_STATUS_CHANGE") {
      await this.handleStatusChange(ctx, input, session);
    } else if (step === "AWAIT_CONTINUE_STATUS_CHANGE") {
      await this.handleContinueStatusChange(ctx, input, session);
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
      { link_preview_options: { is_disabled: true } } as any,
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
      { link_preview_options: { is_disabled: true } } as any,
    );

    // Fetch available transitions and ask user to pick one
    const transitions = await this.jiraService.getTransitions(key);
    const validTransitions = transitions.filter((t) => t.to);

    if (validTransitions.length === 0) {
      await ctx.reply("No status transitions available for this ticket.");
      this.sessionService.clearSession(this.chatId);
      return;
    }

    session.data["transitions"] = validTransitions;
    session.step = "AWAIT_STATUS_CHANGE";
    this.sessionService.setSession(this.chatId, session);

    const transitionsList = validTransitions
      .map((t, i) => `  <b>${i + 1}.</b> ${t.to.name}`)
      .join("\n");

    await ctx.replyWithHTML(
      `Do you want to change the status? Available:\n${transitionsList}\n\n<i>Reply with a number, or "no" to skip.</i>`,
      { link_preview_options: { is_disabled: true } } as any,
    );
  }

  private async handleStatusChange(
    ctx: Context,
    input: string,
    session: NonNullable<ReturnType<SessionService["getSession"]>>,
  ): Promise<void> {
    const key = session.data["selectedKey"] as string;
    const transitions = session.data["transitions"] as JiraTransition[];

    const answer = input.toLowerCase().trim();
    if (answer === "no") {
      await ctx.reply("👍 Good work!");
      this.sessionService.clearSession(this.chatId);
      return;
    }

    const num = parseInt(input, 10);
    if (isNaN(num) || num < 1 || num > transitions.length) {
      await ctx.reply(
        `Please reply with a number between 1 and ${transitions.length}, or "no".`,
      );
      return;
    }

    const selected = transitions[num - 1]!;
    const targetStatus = selected.to.name;

    await this.jiraService.transitionIssue(key, targetStatus);
    await ctx.replyWithHTML(
      `✅ ${this.formatTicketLink(key)} → <b>${targetStatus}</b>`,
      { link_preview_options: { is_disabled: true } } as any,
    );

    if (targetStatus.toLowerCase() === "done") {
      await ctx.reply("🎉 Ticket is Done! Great work!");
      this.sessionService.clearSession(this.chatId);
    } else {
      session.step = "AWAIT_CONTINUE_STATUS_CHANGE";
      this.sessionService.setSession(this.chatId, session);
      await ctx.reply(
        'Do you want to continue changing status? Reply "yes" or "no".',
      );
    }
  }

  private async handleContinueStatusChange(
    ctx: Context,
    input: string,
    session: NonNullable<ReturnType<SessionService["getSession"]>>,
  ): Promise<void> {
    const answer = input.toLowerCase().trim();
    const key = session.data["selectedKey"] as string;

    if (answer === "yes") {
      const transitions = await this.jiraService.getTransitions(key);
      const validTransitions = transitions.filter((t) => t.to);

      if (validTransitions.length === 0) {
        await ctx.reply("No status transitions available for this ticket.");
        this.sessionService.clearSession(this.chatId);
        return;
      }

      session.data["transitions"] = validTransitions;
      session.step = "AWAIT_STATUS_CHANGE";
      this.sessionService.setSession(this.chatId, session);

      const transitionsList = validTransitions
        .map((t, i) => `  <b>${i + 1}.</b> ${t.to.name}`)
        .join("\n");

      await ctx.replyWithHTML(
        `Available transitions:\n${transitionsList}\n\n<i>Reply with a number, or "no" to skip.</i>`,
        { link_preview_options: { is_disabled: true } } as any,
      );
    } else if (answer === "no") {
      await ctx.reply("👍 Good work!");
      this.sessionService.clearSession(this.chatId);
    } else {
      await ctx.reply('Please reply "yes" or "no".');
    }
  }

  // ── helpers ──

  private async sendOrReply(
    ctx: Context | undefined,
    text: string,
  ): Promise<void> {
    if (ctx) {
      await ctx.replyWithHTML(text, {
        link_preview_options: { is_disabled: true },
      } as any);
    } else {
      await this.sendMessage(text);
    }
  }

  private buildMorningMessage(inProgress: SubTask[], todo: SubTask[]): string {
    let msg = "<b>🌅 Good morning! Here's your daily update:</b>\n";

    if (inProgress.length > 0) {
      msg += "\n<b>🔄 In Progress:</b>\n";
      for (const t of inProgress) {
        msg += this.formatTicketLine(t, null, false);
      }
    } else {
      msg += "\n<b>🔄 In Progress:</b> (none)\n";
    }

    if (todo.length > 0) {
      msg += "\n<b>📋 To Do:</b>\n";
      for (let i = 0; i < todo.length; i++) {
        msg += this.formatTicketLine(todo[i]!, i + 1, false);
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
      msg += this.formatTicketLine(subTasks[i]!, i + 1, true);
    }

    msg += '\n<i>Reply with a number to log time, or "skip" to skip.</i>';
    return msg;
  }

  private formatTicketLine(
    t: SubTask,
    num: number | null,
    showStatus: boolean,
  ): string {
    const parentInfo =
      t.parent
        ? ` (<a href="${this.jiraBaseUrl}/browse/${t.parent.key}">👆 ${t.parent.key}</a>)`
        : "";
    const prefix =
      num !== null
        ? `  <b>${num}.</b>`
        : "  -";

    const est = JiraService.formatTime(t.timeoriginalestimate);
    const logged = JiraService.formatTime(t.timespent);
    const left = JiraService.formatTime(t.timeestimate);
    const statsLine = `    ⏱ Est: ${est} | ✅ Logged: ${logged} | ⏳ Left: ${left}`;

    const progressLine = this.formatProgress(
      t.timespent,
      t.timeoriginalestimate,
      showStatus,
    );

    return `${prefix} <a href="${this.jiraBaseUrl}/browse/${t.key}">${t.key}</a>${parentInfo} — ${t.summary}\n${statsLine}${progressLine}\n\n`;
  }

  private formatProgress(
    spent: number | null,
    estimate: number | null,
    showStatus: boolean,
  ): string {
    if (!estimate || estimate === 0) return "";
    const effectiveSpent = spent ?? 0;
    const ratio = Math.min(effectiveSpent / estimate, 1);
    const pct = Math.round(ratio * 100);
    const filled = Math.round(ratio * 8);
    const empty = 8 - filled;
    const bar = "▓".repeat(filled) + "░".repeat(empty);
    const emoji = showStatus ? ` ${this.formatStatusEmoji(pct)}` : "";
    return `\n    ${bar} ${pct}%${emoji}`;
  }

  private formatStatusEmoji(pct: number): string {
    if (pct >= 100) return "✅";
    if (pct >= 75) return "🟢";
    if (pct >= 50) return "🟡";
    if (pct >= 25) return "🟠";
    return "🔴";
  }

  private formatDailyProgress(todaySeconds: number): string {
    const dailyTarget = 7 * 3600; // 7h in seconds
    const ratio = Math.min(todaySeconds / dailyTarget, 1);
    const pct = Math.round(ratio * 100);
    const filled = Math.round(ratio * 8);
    const empty = 8 - filled;
    const bar = "▓".repeat(filled) + "░".repeat(empty);
    return `<b>📊 Today:</b> ${bar} ${pct}% | ${JiraService.formatTime(todaySeconds)} / 7h`;
  }

  private formatTicketLink(key: string): string {
    return `<a href="${this.jiraBaseUrl}/browse/${key}">${key}</a>`;
  }

  getBot(): Telegraf {
    return this.bot;
  }
}
