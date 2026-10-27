#!/usr/bin/env python3
"""
scripts/telegram-driver.py — Bộ điều khiển Telegram Client (Telethon)
cho kịch bản kiểm thử E2E tự động.

Chạy tương tác với bot Telegram qua phiên Telethon:
  - verify: Kiểm tra tính hợp lệ của session string.
  - send: Gửi tin nhắn tới bot.
  - read: Đọc tin nhắn mới nhất trong chat với bot.
  - wait-reply: Chờ tin phản hồi mới từ bot.
  - click: Bấm inline button trên tin nhắn của bot.

Tuyệt đối không lưu token hay session string trong mã nguồn.
Tự động nạp cấu hình từ biến môi trường hoặc file cấu hình an toàn.
"""

import argparse
import asyncio
import json
import os
import sys

try:
    from telethon import TelegramClient
    from telethon.sessions import StringSession
    from telethon.tl.custom.message import Message
    TELETHON_AVAILABLE = True
except ImportError:
    TELETHON_AVAILABLE = False


def load_env_file(path: str) -> dict:
    expanded = os.path.expanduser(path)
    if not os.path.exists(expanded):
        return {}
    res = {}
    with open(expanded, encoding="utf-8", errors="ignore") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            res[k.strip()] = v.strip().strip('"').strip("'")
    return res


def get_telegram_credentials(custom_env_file: str = None) -> dict:
    env_data = {}
    candidate_files = [
        custom_env_file,
        os.path.expanduser("~/.config/ticket/telegram.env"),
        os.path.expanduser("~/Downloads/test/telegram-mcp/.env"),
    ]
    for cfile in candidate_files:
        if cfile and os.path.exists(os.path.expanduser(cfile)):
            file_env = load_env_file(cfile)
            for k, v in file_env.items():
                if k not in env_data:
                    env_data[k] = v

    # Biến môi trường hệ thống có độ ưu tiên cao nhất
    api_id = os.environ.get("TELEGRAM_API_ID") or env_data.get("TELEGRAM_API_ID")
    api_hash = os.environ.get("TELEGRAM_API_HASH") or env_data.get("TELEGRAM_API_HASH")
    session_str = (
        os.environ.get("TELEGRAM_SESSION_STRING")
        or os.environ.get("TELEGRAM_SESSION_STRING_TE_MINHDN3")
        or env_data.get("TELEGRAM_SESSION_STRING")
        or env_data.get("TELEGRAM_SESSION_STRING_TE_MINHDN3")
    )
    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN") or env_data.get("TELEGRAM_BOT_TOKEN")

    return {
        "api_id": int(api_id) if api_id and api_id.isdigit() else None,
        "api_hash": api_hash,
        "session_string": session_str,
        "bot_token": bot_token,
    }


def output_json(data: dict):
    print(json.dumps(data, ensure_ascii=False))


def serialize_message(m: "Message") -> dict:
    buttons = []
    if getattr(m, "buttons", None):
        for row in m.buttons:
            row_btns = []
            for btn in row:
                row_btns.append({
                    "text": getattr(btn, "text", ""),
                    "data": btn.data.decode("utf-8", errors="ignore") if getattr(btn, "data", None) else None,
                    "url": getattr(btn, "url", None),
                })
            buttons.append(row_btns)

    return {
        "id": m.id,
        "out": bool(m.out),
        "text": m.message or "",
        "date": m.date.isoformat() if getattr(m, "date", None) else None,
        "buttons": buttons,
    }


async def action_verify(client: "TelegramClient"):
    me = await client.get_me()
    return {
        "ok": True,
        "user": {
            "id": me.id,
            "username": me.username,
            "first_name": me.first_name,
            "is_bot": bool(getattr(me, "bot", False)),
        }
    }


async def action_send(client: "TelegramClient", target: str, message: str):
    ent = await client.get_entity(target)
    sent = await client.send_message(ent, message)
    return {
        "ok": True,
        "messageId": sent.id,
        "text": sent.message,
    }


async def action_read(client: "TelegramClient", target: str, limit: int = 10):
    ent = await client.get_entity(target)
    msgs = await client.get_messages(ent, limit=limit)
    return {
        "ok": True,
        "messages": [serialize_message(m) for m in reversed(msgs)],
    }


async def action_wait_reply(client: "TelegramClient", target: str, since_id: int, timeout_sec: int = 45):
    ent = await client.get_entity(target)
    poll_interval = 2
    cycles = max(1, timeout_sec // poll_interval)
    for _ in range(cycles):
        await asyncio.sleep(poll_interval)
        msgs = await client.get_messages(ent, limit=5)
        for m in msgs:
            if m.id > since_id and not m.out and (m.message or m.buttons):
                return {
                    "ok": True,
                    "message": serialize_message(m),
                }
    return {
        "ok": False,
        "error": f"Timeout {timeout_sec}s chờ phản hồi từ {target} sau tin id={since_id}",
    }


async def action_click(client: "TelegramClient", target: str, message_id: int, button_text: str = None, button_index: int = None):
    ent = await client.get_entity(target)
    msg = await client.get_messages(ent, ids=message_id)
    if not msg:
        return {"ok": False, "error": f"Không tìm thấy tin nhắn id={message_id}"}

    if not getattr(msg, "buttons", None):
        return {"ok": False, "error": f"Tin nhắn id={message_id} không có nút bấm inline"}

    clicked_text = None
    if button_text:
        low_target = button_text.lower().strip()
        for row in msg.buttons:
            for btn in row:
                if low_target in btn.text.lower():
                    await btn.click()
                    clicked_text = btn.text
                    break
            if clicked_text:
                break
        if not clicked_text:
            return {"ok": False, "error": f"Không tìm thấy nút chứa chữ '{button_text}'"}
    elif button_index is not None:
        flat_buttons = [btn for row in msg.buttons for btn in row]
        if button_index < 0 or button_index >= len(flat_buttons):
            return {"ok": False, "error": f"Chỉ số nút {button_index} vượt ngoài phạm vi (0-{len(flat_buttons)-1})"}
        btn = flat_buttons[button_index]
        await btn.click()
        clicked_text = btn.text
    else:
        # Mặc định bấm nút đầu tiên
        await msg.click(0)
        clicked_text = msg.buttons[0][0].text

    return {
        "ok": True,
        "clicked": clicked_text,
    }


async def main():
    parser = argparse.ArgumentParser(description="Telegram driver for scripted E2E testing")
    parser.add_argument("action", choices=["verify", "send", "read", "wait-reply", "click"])
    parser.add_argument("--target", default="@test_ticket123_bot", help="Target bot username")
    parser.add_argument("--message", help="Message text to send")
    parser.add_argument("--limit", type=int, default=10, help="Number of messages to read")
    parser.add_argument("--since-id", type=int, default=0, help="Message ID to wait after")
    parser.add_argument("--timeout", type=int, default=45, help="Timeout in seconds")
    parser.add_argument("--message-id", type=int, help="Message ID containing button to click")
    parser.add_argument("--button-text", help="Text on button to click")
    parser.add_argument("--button-index", type=int, help="Index of button to click")
    parser.add_argument("--env-file", help="Path to custom env file")

    args = parser.parse_args()

    if not TELETHON_AVAILABLE:
        output_json({
            "ok": False,
            "error": "Telethon library is not installed in this Python environment.",
            "type": "ImportError",
        })
        sys.exit(1)

    creds = get_telegram_credentials(args.env_file)
    if not creds["api_id"] or not creds["api_hash"] or not creds["session_string"]:
        output_json({
            "ok": False,
            "error": "Thiếu thông tin đăng nhập Telegram (TELEGRAM_API_ID, TELEGRAM_API_HASH, hoặc TELEGRAM_SESSION_STRING)",
            "type": "MissingCredentials",
        })
        sys.exit(1)

    client = TelegramClient(
        StringSession(creds["session_string"]),
        creds["api_id"],
        creds["api_hash"],
    )

    try:
        await client.connect()
        if not await client.is_user_authorized():
            output_json({
                "ok": False,
                "error": "Telegram session không authorized (có thể session string đã hết hạn hoặc bị thu hồi)",
                "type": "UnauthorizedSession",
            })
            sys.exit(1)

        res = None
        if args.action == "verify":
            res = await action_verify(client)
        elif args.action == "send":
            if not args.message:
                output_json({"ok": False, "error": "Thiếu tham số --message"})
                sys.exit(1)
            res = await action_send(client, args.target, args.message)
        elif args.action == "read":
            res = await action_read(client, args.target, args.limit)
        elif args.action == "wait-reply":
            res = await action_wait_reply(client, args.target, args.since_id, args.timeout)
        elif args.action == "click":
            if not args.message_id:
                output_json({"ok": False, "error": "Thiếu tham số --message-id"})
                sys.exit(1)
            res = await action_click(client, args.target, args.message_id, args.button_text, args.button_index)

        output_json(res or {"ok": False, "error": "Hành động không xác định"})
        if res and not res.get("ok"):
            sys.exit(1)

    except Exception as e:
        output_json({
            "ok": False,
            "error": str(e),
            "type": type(e).__name__,
        })
        sys.exit(1)
    finally:
        try:
            await client.disconnect()
        except Exception:
            pass


if __name__ == "__main__":
    asyncio.run(main())
