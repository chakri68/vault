import { afterEach, describe, expect, it } from "vitest";
import { dateInputToIso, isoToDateInput, temporaryExpiry } from "@/components/upload/dates";
import { daysFromToday, formatDate, formatRelative, formatTime, istDateStamp } from "./format";

const realTz = process.env.TZ;
afterEach(() => { process.env.TZ = realTz; });

// The same assertions under three device clocks. IST everywhere means none of them may matter.
const ZONES = ["Asia/Kolkata", "America/Los_Angeles", "Pacific/Auckland"];

describe("dates are IST, whatever the device thinks", () => {
  for (const tz of ZONES) {
    it(`device clock in ${tz}`, () => {
      process.env.TZ = tz;

      // 18:45 UTC on the 18th is 00:15 on the 19th in India
      const late = "2026-09-18T18:45:00.000Z";
      expect(formatDate(late)).toBe("19 Sep 2026");
      expect(formatTime(late)).toBe("00:15");
      expect(istDateStamp(new Date(late))).toBe("2026-09-19");

      const now = new Date("2026-09-19T03:00:00.000Z"); // 08:30 IST, 19 Sep
      expect(daysFromToday(late, now)).toBe(0);
      // off India's clock, the time says whose clock it is
      expect(formatRelative(late, now)).toBe(tz === "Asia/Kolkata" ? "today, 00:15" : "today, 00:15 IST");
      expect(daysFromToday("2026-09-18T18:29:00.000Z", now)).toBe(-1); // 23:59 IST on the 18th
      expect(daysFromToday("2026-10-10T06:30:00.000Z", now)).toBe(21);

      // a date picked in a form comes back as the same day, and shows as that day
      const stored = dateInputToIso("2031-03-12")!;
      expect(stored).toBe("2031-03-12T06:30:00.000Z"); // noon IST
      expect(isoToDateInput(stored)).toBe("2031-03-12");
      expect(formatDate(stored)).toBe("12 Mar 2031");
      expect(formatDate("2031-03-12")).toBe("12 Mar 2031"); // a bare date, as older entries may hold

      // "delete on this date" means the end of that day in India
      expect(temporaryExpiry("date", "2026-09-20")).toBe("2026-09-20T18:29:59.000Z");
    });
  }
});
