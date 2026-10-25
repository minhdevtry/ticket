# Nhắn bot Tiểu Linh bằng tài khoản Telegram của người dùng (chỉ dùng cho test E2E, cần sự đồng ý của chủ tài khoản).
# python tg-bot.py send "<text>" [wait] | reply <msg_id> "<text>" [wait] | photo <file> "<caption>" [wait] |  python bot.py click "<nút>" [wait]  |  python bot.py read [n]
import asyncio, sys, json
from dotenv import dotenv_values
from telethon import TelegramClient
from telethon.sessions import StringSession
import os
env = dotenv_values(os.environ.get("TG_MCP_ENV", ".env"))
BOT = os.environ.get("TG_BOT", "vhticket_bot")
def fmt(m):
    btn = [[b.text for b in row] for row in (m.buttons or [])]
    who = "USER" if m.out else "BOT"
    return f"[{m.id} {m.date:%H:%M:%S} {who}] {(m.text or '')[:900]}" + (f"\n   NÚT: {btn}" if btn else "")
async def main():
    c = TelegramClient(StringSession(env["TELEGRAM_SESSION_STRING"]), int(env["TELEGRAM_API_ID"]), env["TELEGRAM_API_HASH"])
    await c.connect()
    cmd = sys.argv[1]
    last = (await c.get_messages(BOT, limit=1))
    last_id = last[0].id if last else 0
    if cmd == "send":
        await c.send_message(BOT, sys.argv[2])
    elif cmd == "reply":
        # python tg-bot.py reply <msg_id> "<text>" [wait] — trả lời (Reply) đúng tin của bot
        await c.send_message(BOT, sys.argv[3], reply_to=int(sys.argv[2]))
        sys.argv.pop(2)
    elif cmd == "photo":
        # python tg-bot.py photo <file> "<chú thích>" [wait] — gửi ảnh kèm chú thích
        await c.send_file(BOT, sys.argv[2], caption=sys.argv[3])
        sys.argv.pop(2)
    elif cmd == "click":
        target = sys.argv[2]
        for m in await c.get_messages(BOT, limit=8):
            if m.buttons and any(target == b.text for row in m.buttons for b in row):
                await m.click(text=target); break
        else:
            print("KHÔNG THẤY NÚT", target)
    if cmd in ("send", "click", "reply", "photo"):
        wait = int(sys.argv[3]) if len(sys.argv) > 3 else 45
        await asyncio.sleep(wait)
        msgs = [m async for m in c.iter_messages(BOT, min_id=last_id - 1 if cmd == "click" else last_id)]
        for m in reversed(msgs): print(fmt(m))
    else:
        n = int(sys.argv[2]) if len(sys.argv) > 2 else 6
        for m in reversed(await c.get_messages(BOT, limit=n)): print(fmt(m))
    await c.disconnect()
asyncio.run(main())
