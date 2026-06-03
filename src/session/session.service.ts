import { Injectable, Logger } from '@nestjs/common';
import { SessionState } from '../jira/jira.types';

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private readonly sessions = new Map<string, SessionState>();

  setSession(chatId: string, session: SessionState): void {
    this.sessions.set(chatId, session);
    this.logger.log(`Session set for ${chatId}: type=${session.type} step=${session.step}`);
  }

  getSession(chatId: string): SessionState | undefined {
    const session = this.sessions.get(chatId);
    if (session && this.isExpired(session)) {
      this.sessions.delete(chatId);
      this.logger.log(`Expired session cleared for ${chatId}`);
      return undefined;
    }
    return session;
  }

  clearSession(chatId: string): void {
    this.sessions.delete(chatId);
    this.logger.log(`Session cleared for ${chatId}`);
  }

  private isExpired(session: SessionState): boolean {
    return new Date() > session.expiresAt;
  }
}
