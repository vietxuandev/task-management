import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios, { AxiosInstance } from "axios";
import { SubTask, JiraTransition, WorklogResult } from "./jira.types";

@Injectable()
export class JiraService {
  private readonly logger = new Logger(JiraService.name);
  private readonly client: AxiosInstance;
  private readonly baseUrl: string;
  private readonly projectKey: string;
  private readonly accountId: string;
  private readonly timezone: string;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = this.config.getOrThrow<string>("JIRA_BASE_URL");
    this.projectKey = this.config.getOrThrow<string>("JIRA_PROJECT_KEY");
    this.accountId = this.config.getOrThrow<string>("JIRA_ASSIGNEE_ACCOUNT_ID");
    this.timezone = this.config.getOrThrow<string>("TIMEZONE");

    const email = this.config.getOrThrow<string>("JIRA_USER_EMAIL");
    const token = this.config.getOrThrow<string>("JIRA_API_TOKEN");
    const auth = Buffer.from(`${email}:${token}`).toString("base64");

    this.client = axios.create({
      baseURL: `${this.baseUrl}/rest/api/3`,
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
    });

    this.logger.log("JiraService initialized");
  }

  async getMySubTasks(): Promise<SubTask[]> {
    const jql = `project = "${this.projectKey}" AND issuetype in subTaskIssueTypes() AND sprint in openSprints() AND assignee = "${this.accountId}" AND statusCategory != Done ORDER BY updated DESC`;
    const fields =
      "key,summary,status,timeoriginalestimate,timespent,timeestimate,parent";

    const { data } = await this.client.post<{
      issues: Array<{
        key: string;
        fields: {
          summary: string;
          status: { name: string };
          timeoriginalestimate: number | null;
          timespent: number | null;
          timeestimate: number | null;
          parent: { key: string; fields: { summary: string } } | null;
        };
      }>;
    }>("/search/jql", {
      jql,
      fields: fields.split(","),
      maxResults: 100,
    });

    this.logger.log(`Found ${data.issues.length} sub-tasks`);

    return data.issues.map((issue) => ({
      key: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status.name,
      timeoriginalestimate: issue.fields.timeoriginalestimate,
      timespent: issue.fields.timespent,
      timeestimate: issue.fields.timeestimate,
      parent: issue.fields.parent
        ? {
            key: issue.fields.parent.key,
            summary: issue.fields.parent.fields.summary,
          }
        : null,
    }));
  }

  async getSubTaskDetails(issueKey: string): Promise<SubTask> {
    const fields =
      "key,summary,status,timeoriginalestimate,timespent,timeestimate,parent";

    const { data } = await this.client.get<{
      key: string;
      fields: {
        summary: string;
        status: { name: string };
        timeoriginalestimate: number | null;
        timespent: number | null;
        timeestimate: number | null;
        parent: { key: string; fields: { summary: string } } | null;
      };
    }>(`/issue/${issueKey}?fields=${encodeURIComponent(fields)}`);

    return {
      key: data.key,
      summary: data.fields.summary,
      status: data.fields.status.name,
      timeoriginalestimate: data.fields.timeoriginalestimate,
      timespent: data.fields.timespent,
      timeestimate: data.fields.timeestimate,
      parent: data.fields.parent
        ? {
            key: data.fields.parent.key,
            summary: data.fields.parent.fields.summary,
          }
        : null,
    };
  }

  async getTransitions(issueKey: string): Promise<JiraTransition[]> {
    const { data } = await this.client.get<{
      transitions: JiraTransition[];
    }>(`/issue/${issueKey}/transitions`);

    return data.transitions;
  }

  async transitionIssue(
    issueKey: string,
    targetStatusName: string,
  ): Promise<void> {
    const transitions = await this.getTransitions(issueKey);

    // Match by destination status name first, then by transition name
    const target =
      transitions.find(
        (t) => t.to?.name.toLowerCase() === targetStatusName.toLowerCase(),
      ) ??
      transitions.find(
        (t) => t.name.toLowerCase() === targetStatusName.toLowerCase(),
      );

    if (!target) {
      const list = transitions
        .map((t) => `${t.name}${t.to ? ` → ${t.to.name}` : ""}`)
        .join(", ");
      throw new Error(
        `Transition to "${targetStatusName}" not found for ${issueKey}. Available: ${list}`,
      );
    }

    await this.client.post(`/issue/${issueKey}/transitions`, {
      transition: { id: target.id },
    });

    this.logger.log(
      `Transitioned ${issueKey} to "${targetStatusName}" via "${target.name}"`,
    );
  }

  async logWork(
    issueKey: string,
    timeSpentSeconds: number,
    comment: string,
  ): Promise<WorklogResult> {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: this.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
      hour12: false,
    });

    // Format: "YYYY-MM-DDTHH:mm:ss.SSS+0700"
    const parts = formatter.formatToParts(now);
    const dateStr = `${parts.find((p) => p.type === "year")?.value}-${parts.find((p) => p.type === "month")?.value}-${parts.find((p) => p.type === "day")?.value}`;
    const timeStr = `${parts.find((p) => p.type === "hour")?.value}:${parts.find((p) => p.type === "minute")?.value}:${parts.find((p) => p.type === "second")?.value}.${parts.find((p) => p.type === "fractionalSecond")?.value}`;

    // Get timezone offset for the configured timezone
    const tzDate = new Date(
      now.toLocaleString("en-US", { timeZone: this.timezone }),
    );
    const offsetMinutes = -tzDate.getTimezoneOffset();
    // Actually we need offset for the target timezone, not the local one
    // Simpler: use the timezone offset string directly
    const offsetHours = Math.floor(Math.abs(offsetMinutes) / 60)
      .toString()
      .padStart(2, "0");
    const offsetMins = (Math.abs(offsetMinutes) % 60)
      .toString()
      .padStart(2, "0");
    const offsetSign = offsetMinutes >= 0 ? "+" : "-";
    const offsetStr = `${offsetSign}${offsetHours}${offsetMins}`;

    const started = `${dateStr}T${timeStr}${offsetStr}`;

    const { data } = await this.client.post<WorklogResult>(
      `/issue/${issueKey}/worklog`,
      {
        timeSpent: JiraService.formatTime(timeSpentSeconds),
        started,
        comment: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: comment }],
            },
          ],
        },
      },
    );

    this.logger.log(
      `Logged ${JiraService.formatTime(timeSpentSeconds)} to ${issueKey}`,
    );
    return data;
  }

  static formatTime(seconds: number | null): string {
    if (seconds == null || seconds === 0) return "0h";
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds % 3600) / 60);
    if (hours === 0) return `${minutes}m`;
    if (minutes === 0) return `${hours}h`;
    return `${hours}h ${minutes}m`;
  }

  static isEstimateExceeded(
    estimate: number | null,
    spent: number | null,
    newLogSeconds: number,
  ): boolean {
    if (estimate == null) return false;
    const totalSpent = (spent ?? 0) + newLogSeconds;
    return totalSpent >= estimate;
  }
}
