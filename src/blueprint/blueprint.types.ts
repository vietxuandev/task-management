export interface DailyAttendanceItem {
  dyTpCd: string;
  [key: string]: unknown;
}

export interface LeaveRequest {
  lveDt: string;
  stsNm: string;
  lveTpNm: string;
}

export interface DailyAttendanceData {
  listDailyAttendance: DailyAttendanceItem[];
  listLeaveRequest: LeaveRequest[];
}

export interface DailyAttendanceResponse {
  data: DailyAttendanceData;
}

export const DayTypeCode = {
  BUSINESS: "B",
} as const;
