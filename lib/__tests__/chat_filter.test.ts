/**
 * Which chats may trade. Both delivery paths share this, because they used to
 * disagree: the bot webhook filtered and the listener's /api/ingest did not.
 * A bot only receives updates from chats it was added to, but the listener signs
 * in as the USER and sees every group they belong to - so the missing check meant
 * anything signal-shaped in ANY group was traded.
 */
import { describe, expect, it } from "vitest";
import { chatAllowed } from "../telegram";

const chat = {
  id: -1003870734820,
  username: "moneygroup",
  title: "賺錢錢",
};

describe("chatAllowed", () => {
  it("accepts everything when nothing is configured", () => {
    expect(chatAllowed(chat, [])).toBe(true);
  });

  it("matches on numeric id, @username or group title", () => {
    expect(chatAllowed(chat, ["-1003870734820"])).toBe(true);
    expect(chatAllowed(chat, ["@moneygroup"])).toBe(true);
    expect(chatAllowed(chat, ["MoneyGroup"])).toBe(true);
    expect(chatAllowed(chat, ["賺錢錢"])).toBe(true);
  });

  it("rejects a chat that is not listed", () => {
    // the reported bug: other groups' signals were being traded
    expect(chatAllowed(chat, ["-5144194633"])).toBe(false);
    expect(chatAllowed(chat, ["someothergroup"])).toBe(false);
  });

  it("ignores blank entries rather than treating them as a wildcard", () => {
    expect(chatAllowed(chat, ["", "  "])).toBe(false);
    expect(chatAllowed(chat, ["", "賺錢錢"])).toBe(true);
  });

  it("still matches when the title is missing from the delivery", () => {
    // the listener only learned to send titles later; ids must keep working
    expect(chatAllowed({ id: -1003870734820 }, ["-1003870734820"])).toBe(true);
    expect(chatAllowed({ id: -1003870734820 }, ["賺錢錢"])).toBe(false);
  });
});
