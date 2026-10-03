#!/usr/bin/env python3
"""
A dead-end SMTP server on 127.0.0.1:2526 for the capture instance.

It accepts every message and DISCARDS it (only the envelope and subject go to smtp_sink.log), so the
server believes email works — which is what un-greys Cleanup's notice-first flow — while nothing can
ever leave this machine. No TLS, no auth, loopback only. Invented @example.test recipients anyway.
"""
import asyncio, os, re, time

LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "smtp_sink.log")

async def handle(reader, writer):
    def send(s): writer.write((s + "\r\n").encode())
    send("220 capture-sink ESMTP"); await writer.drain()
    rcpt, subj, in_data = [], "", False
    while True:
        line = await reader.readline()
        if not line: break
        s = line.decode(errors="replace").rstrip("\r\n")
        if in_data:
            if s == ".":
                in_data = False
                with open(LOG, "a") as f: f.write(f"{time.strftime('%H:%M:%S')} to={','.join(rcpt)} subject={subj!r} (discarded)\n")
                rcpt, subj = [], ""
                send("250 discarded")
            elif not subj and s.lower().startswith("subject:"):
                subj = s[8:].strip()
            continue
        cmd = s[:4].upper()
        if cmd in ("EHLO", "HELO"): send("250 capture-sink")
        elif cmd == "MAIL": send("250 ok")
        elif cmd == "RCPT": rcpt.append(re.sub(r"(?i)^rcpt to:\s*", "", s)); send("250 ok")
        elif cmd == "DATA": in_data = True; send("354 go ahead")
        elif cmd == "RSET": rcpt, subj = [], ""; send("250 ok")
        elif cmd == "QUIT": send("221 bye"); await writer.drain(); break
        else: send("250 ok")
        await writer.drain()
    writer.close()

async def main():
    srv = await asyncio.start_server(handle, "127.0.0.1", 2526)
    async with srv: await srv.serve_forever()

asyncio.run(main())
