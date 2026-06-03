import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HttpService } from "@nestjs/axios";
import axios, { CreateAxiosDefaults } from "axios";
import { wrapper } from "axios-cookiejar-support";
import { format, getDate, startOfMonth } from "date-fns";
import { toZonedTime } from "date-fns-tz";
import { CookieJar } from "tough-cookie";
import { DayTypeCode } from "./blueprint.types";
import type {
  DailyAttendanceData,
  DailyAttendanceResponse,
} from "./blueprint.types";

@Injectable()
export class BlueprintService {
  private readonly logger = new Logger(BlueprintService.name);
  private sessionCache: string | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly httpService: HttpService,
  ) {}

  async getSessionId(): Promise<string> {
    if (this.sessionCache) return this.sessionCache;

    const baseUrl = this.config.getOrThrow<string>("BLUEPRINT_URL");
    const username = this.config.getOrThrow<string>("BLUEPRINT_USERNAME");
    const password = this.config.getOrThrow<string>("BLUEPRINT_PASSWORD");

    const jar = new CookieJar();
    const client = wrapper(
      axios.create({ jar, maxRedirects: 5 } as CreateAxiosDefaults),
    );

    // Step 1
    await client.get(baseUrl);

    // Step 2
    const res2 = await client.get(`${baseUrl}/sso/login`, {
      maxRedirects: 0,
      validateStatus: (s) => s === 302,
    });
    const keycloakUrl = res2.headers["location"] as string;

    // Step 3
    const res3 = await client.get(keycloakUrl);
    const loginUrl = this.extractLoginUrl(res3.data as string);

    // Step 4
    const body = `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&credentialId=`;
    const res4 = await client.post(loginUrl, body, {
      maxRedirects: 0,
      validateStatus: (s) => s === 302,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const callbackUrl = res4.headers["location"] as string;

    // Step 5
    await client.get(callbackUrl);

    const cookies = await jar.getCookies(baseUrl);
    const sessionCookie = cookies.find((c) => c.key === "JSESSIONID");

    if (!sessionCookie) {
      throw new Error("No JSESSIONID found in cookie jar after OAuth flow");
    }

    this.sessionCache = sessionCookie.value;
    this.logger.log("Blueprint session established");
    return this.sessionCache;
  }

  async fetchDailyAttendance(retry = 3): Promise<DailyAttendanceData | null> {
    const baseUrl = this.config.getOrThrow<string>("BLUEPRINT_URL");
    const sessionId = await this.getSessionId();

    const now = toZonedTime(new Date(), "Asia/Ho_Chi_Minh");
    const wrkDt = format(startOfMonth(now), "yyyyMMdd");

    for (let attempt = 1; attempt <= retry; attempt++) {
      const { status, data } =
        await this.httpService.axiosRef.post<DailyAttendanceResponse>(
          `${baseUrl}/api/checkInOut/searchDailyAttendanceCheckInOut`,
          {
            wrkDt,
            fmtD: "",
            wrkT: "",
            timeZone: 420,
            checkMonthFlg: "Y",
          },
          {
            headers: { Cookie: `JSESSIONID=${sessionId}` },
            validateStatus: () => true,
          },
        );

      if (status === 401) {
        this.sessionCache = null;
        if (attempt < retry) {
          await this.getSessionId();
          continue;
        }
      }

      return data?.data ?? null;
    }

    return null;
  }

  shouldSkipPunch(data: DailyAttendanceData): boolean {
    const timezone = "Asia/Ho_Chi_Minh";
    const now = toZonedTime(new Date(), timezone);
    const currentDate = getDate(now);
    const todayStr = format(now, "MM/dd/yyyy");

    const isOnLeave = data.listLeaveRequest.some(
      (l) =>
        l.lveDt === todayStr &&
        l.stsNm === "Approved" &&
        l.lveTpNm === "Annual Vacation",
    );

    const isBusinessDay =
      data.listDailyAttendance[currentDate - 1]?.dyTpCd ===
      DayTypeCode.BUSINESS;

    return isOnLeave || !isBusinessDay;
  }

  async punch(retry = 3): Promise<number> {
    const baseUrl = this.config.getOrThrow<string>("BLUEPRINT_URL");

    const attendance = await this.fetchDailyAttendance();
    if (attendance && this.shouldSkipPunch(attendance)) {
      this.logger.log("Punch skipped: leave or non-business day");
      return 0;
    }

    for (let attempt = 1; attempt <= retry; attempt++) {
      const sessionId = await this.getSessionId();

      const { status, data } = await this.httpService.axiosRef.post(
        `${baseUrl}/api/checkInOut/insert`,
        {},
        {
          headers: { Cookie: `JSESSIONID=${sessionId}` },
          validateStatus: () => true,
        },
      );

      if (status === 401) {
        this.sessionCache = null;
        if (attempt < retry) continue;
        throw new Error("Blueprint punch failed: unauthorized after retries");
      }

      if (status < 200 || status >= 300) {
        throw new Error(
          `Blueprint punch failed: HTTP ${status} — ${JSON.stringify(data)}`,
        );
      }

      const result = data as number;
      this.logger.log(`Blueprint punch successful, result: ${result}`);
      return result;
    }

    throw new Error("Blueprint punch failed after all retries");
  }

  // ── private helpers ──

  private extractLoginUrl(html: string): string {
    const match = html.match(/https:\/\/.*?"/);
    if (!match) {
      throw new Error("Could not extract login URL from Keycloak page");
    }
    return match[0].slice(0, -1).replace(/&amp;/g, "&");
  }
}
