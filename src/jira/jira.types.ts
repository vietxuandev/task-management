export interface SubTask {
  key: string;
  summary: string;
  status: string;
  timeoriginalestimate: number | null;
  timespent: number | null;
  timeestimate: number | null;
  parent: {
    key: string;
    summary: string;
  } | null;
}

export interface JiraTransition {
  id: string;
  name: string;
  to: {
    name: string;
  };
}

export interface WorklogResult {
  id: string;
  timeSpent: string;
}

export interface SessionState {
  type: 'morning' | 'evening';
  step: string;
  data: Record<string, unknown>;
  expiresAt: Date;
}
