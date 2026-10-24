# Deploy

Bot chạy dưới dạng systemd user service trên máy chủ. Code lấy từ git, secret đẩy qua SSH (ADR-0003).

## Lần đầu trên máy chạy

```bash
git clone https://github.com/minhdevtry/ticket.git ~/apps/ticket
cd ~/apps/ticket && bun install --production
```

## Đẩy secret từ máy maintainer

```bash
deploy/push-secrets.sh <ssh-host> apps/tieulinh/.env tieulinh
# → <ssh-host>:~/.config/ticket/tieulinh.env (chmod 600)
```

## Cập nhật code

```bash
ssh <ssh-host> 'cd ~/apps/ticket && git pull --ff-only && bun install --production && systemctl --user restart <unit>'
```
