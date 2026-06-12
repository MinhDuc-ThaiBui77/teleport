# Triển khai Teleport (bản custom) lên Production bằng Docker

Hướng dẫn dựng **một cụm Teleport mới** (auth + proxy + GUI request custom) chạy
trong Docker trên máy production. Viết cho người **chưa quen Docker** — làm theo
từng bước.

> GUI request/approve custom đã được **biên dịch thẳng vào binary `teleport`**
> (build tag `webassets_embed`). Nên image chỉ cần đúng binary là có sẵn giao diện.

---

## 0. Bối cảnh & mô hình

- Máy PoC `10.120.10.35` chỉ để thử nghiệm — **bỏ đi**, không mang dữ liệu sang.
- Production = **cụm mới**: lần đầu khởi động, Teleport tự sinh **CA mới** (con dấu
  gốc). Từ lúc đó, thư mục `/var/lib/teleport` (nằm trong Docker **volume**) là
  thứ quý nhất — **phải sao lưu** (xem bước 7).

Mô hình hoạt động:

```
        ┌─────────────────────────────┐
        │   Container "teleport"       │   <- bộ não: auth + proxy + GUI
        │   image: teleport-custom     │
        │   volume: /var/lib/teleport  │   <- CA + role/user/request (GIỮ)
        └──────────────┬──────────────┘
                       │ (node agent dial về qua reverse tunnel)
     ┌─────────────────┼─────────────────┐
   server A          server B          server C        <- server thật của công ty
  (node agent)      (node agent)      (node agent)        mỗi con gắn nhãn access-id
```

- Mỗi server thật chạy **node agent**, gắn nhãn `access-id: <tên-server>`.
- Mỗi server có **một role** `ssh-access-<tên-server>` nhắm đúng nhãn đó.
- **User thường** giữ role `ssh-requester` (chỉ được *xin* quyền, không có SSH sẵn).
- **Admin/approver** giữ role `ssh-approver` (duyệt/từ chối + End session).

---

## 1. Build image (làm 1 lần, trên máy Linux amd64 có Docker)

Hai sự thật cần nhớ trước:

- Binary `teleport` **bắt buộc CGO** (vài chỗ trong code chỉ có bản Linux-cgo,
  không có fallback) → nó **luôn phụ thuộc glibc**, không build "static" để hết
  phụ thuộc được.
- **Quy tắc glibc:** nơi binary *chạy* phải có glibc **≥** nơi binary được *build*
  (glibc tương thích ngược, không tương thích xuôi). Khi chạy trong Docker, "nơi
  chạy" = glibc của **base image runtime**, không phải của host.

Vì máy build của bác là Ubuntu 24 (glibc 2.39), chọn **một trong hai đường**:

> **Trường hợp của bác (khuyên Đường B):** control plane chạy Ubuntu 22, **nhưng
> có node CentOS 7** (bare-metal). Một binary **glibc 2.17** dùng được cho *cả*
> control plane (trong Docker) lẫn node CentOS 7 (bare-metal) → build 1 lần, khỏi
> làm 2 bản, version khớp tuyệt đối. Chỉ chọn Đường A nếu **cả cụm không có server
> CentOS 7 / Linux cũ nào**.

### Đường A — cả cụm KHÔNG có server CentOS 7 / Linux cũ nào

Build binary trên máy bác rồi để base image runtime **khớp** glibc 2.39:

```bash
# từ thư mục gốc repo — build đủ binary + GUI
make WEBASSETS_SKIP_BUILD=0 RDPCLIENT_SKIP_BUILD=1 full   # -> build/teleport, build/tctl, build/tsh
#   (RDPCLIENT_SKIP_BUILD=1 bỏ desktop/RDP server-side cho gọn; GUI vẫn build đầy đủ)

# base runtime khớp glibc của máy build (Ubuntu 24 -> ubuntu:24.04)
docker build -f docker/Dockerfile --build-arg RUNTIME_BASE=ubuntu:24.04 -t teleport-custom:v1 .
```

Đường này **không** chạy được nếu host prod có kernel quá cũ (vd CentOS 7, kernel
3.10) — khi đó dùng Đường B.

### Đường B — có server CentOS 7 / muốn "build 1 lần, chạy mọi nơi" (khuyên dùng cho bác)

Build binary trên **glibc 2.17** để portable tối đa (chạy được trên gần như mọi
Linux + mọi base image). Repo **đã có sẵn buildbox CentOS 7** đúng cho việc này —
đây cũng chính là một bản dựng Docker nhiều tầng do Teleport làm sẵn và bảo trì,
nên dùng nó thay vì tự viết Dockerfile build (tự viết sẽ phải giải lại đống khó:
mirror CentOS EOL, devtoolset-12, tự build openssl/libfido2... rất dễ fail):

```bash
cd build.assets
make build-centos7-assets          # MỘT LẦN: dựng image phụ thuộc (chậm)
make build-binaries ARCH=amd64     # build trong buildbox CentOS7 -> binary glibc 2.17 (xem thư mục build/)
cd ..

# base mặc định debian:12-slim (glibc 2.36) là OK vì binary chỉ cần glibc >= 2.17
docker build -f docker/Dockerfile -t teleport-custom:v1 .
```

> Phải chạy trên máy Linux **amd64** có Docker (không cross-compile). Nếu kéo được
> sẵn image `ghcr.io/gravitational/teleport-buildbox-centos7:teleport19-amd64` thì
> đỡ phải `build-centos7-assets`. Target/cờ có thể khác chút theo bản — xem
> `build.assets/Makefile` (target `build-binaries` / `release-amd64`).

Đặt tag theo phiên bản (`:v1`, `:v2`...) để dễ rollback.

## 2. Mang image sang máy production

Không cần dựng server registry — xuất ra 1 file rồi copy:

```bash
# trên máy build:
docker save teleport-custom:v1 | gzip > teleport-custom-v1.tgz
#   -> scp/copy file này sang máy prod

# trên máy prod (đã cài Docker):
docker load < teleport-custom-v1.tgz
```

> Nếu công ty có Docker registry (Harbor/GitLab/...) thì `docker push` / `docker pull`
> tiện hơn. File `.tgz` là cách đơn giản nhất khi chưa có registry.

## 3. Cấu hình

Copy cả thư mục **`docker/`** và **`custom-access-request/`** sang máy prod (đặt
cùng một thư mục cha, để các đường dẫn `../custom-access-request/...` ở dưới đúng).
Tạo file config thật từ mẫu:

```bash
cd docker
cp teleport.yaml.example teleport.yaml
# sửa 2 chỗ trong teleport.yaml:
#   - public_addr : DNS/IP của máy prod (browser + node phải gọi tới được)
#   - cluster_name: đặt 1 lần, KHÔNG đổi về sau
```

## 4. Khởi động cụm

```bash
TELEPORT_TAG=v1 docker compose up -d     # bật container ở chế độ nền
docker logs -f teleport                  # xem log; Ctrl+C để thoát xem log
```

Mở trình duyệt vào `https://<public_addr>:3080` — sẽ thấy trang đăng nhập Teleport.
(Cert tự ký sẽ bị trình duyệt cảnh báo — xem mục TLS ở cuối.)

## 5. Nạp role + tạo user admin

`tctl` đã nằm sẵn trong image, gọi qua `docker exec`:

```bash
# nạp 3 role (đường dẫn tính từ trong docker/, repo nằm ở thư mục cha)
docker exec -i teleport tctl create -f - < ../custom-access-request/roles/ssh-requester.yaml
docker exec -i teleport tctl create -f - < ../custom-access-request/roles/ssh-approver.yaml

# tạo admin kiêm approver (lệnh in ra 1 link đăng ký — mở link để đặt mật khẩu + OTP)
docker exec teleport tctl users add admin --roles=editor,access,ssh-approver

# tạo 1 user thường để test luồng xin quyền
docker exec teleport tctl users add user1 --roles=access,ssh-requester
```

## 6. Đưa server thật vào cụm (enroll node)

> ⚠️ **Node chạy bare-metal (systemd) TRÊN CHÍNH server — KHÔNG bọc Docker.**
> Lý do: user SSH "vào server" là để vào **OS thật** của máy đó. Nếu node nằm trong
> container thì phiên SSH lại rơi vào *bên trong container*, không phải host →
> vô nghĩa. (Chạy node trong Docker chỉ hợp khi node đại diện cho một *ứng dụng
> container*, không phải cái host vật lý.)

Làm **lặp lại cho từng server**. Ví dụ server tên `web1`.

**6a. Đưa binary `teleport` lên server**

Node dùng **cùng binary** với control plane (để khớp version tuyệt đối — bản v19
custom của bác chưa có gói official tương ứng). Lấy `build/teleport` (bản
**glibc 2.17** từ Đường B) copy vào server:

```bash
# từ MÁY BUILD, copy binary sang server:
scp build/teleport root@web1:/usr/local/bin/teleport
```

Server CentOS 7 chạy được vì binary là glibc 2.17, và binary từ buildbox **đã sẵn
PAM** nên login host theo policy vẫn hoạt động.

**6b. Xin token (chạy ở MÁY CONTROL PLANE):**

```bash
docker exec teleport tctl tokens add --type=node --ttl=1h
```

**6c. Cấu hình + chạy node (chạy TRÊN server web1):**

```bash
teleport node configure \
  --token=<TOKEN-vừa-in> \
  --proxy=<public_addr>:3080 \
  --labels=access-id=web1 \
  --output=file:///etc/teleport.yaml

# tạo service systemd rồi bật (Teleport có helper sinh sẵn unit):
teleport install systemd | tee /etc/systemd/system/teleport.service
systemctl enable --now teleport
#   (muốn test nhanh trước khi làm service: teleport start -c /etc/teleport.yaml)
```

(Cờ lệnh khác chút theo phiên bản? chạy `teleport node configure --help`.)

**6d. Tạo role cho đúng server đó (chạy ở MÁY CONTROL PLANE)** — copy template,
đổi tên + nhãn + login:

```bash
cd docker    # nơi đã copy docker/ và custom-access-request/ ở thư mục cha
cp ../custom-access-request/roles/ssh-access-server-template.yaml ssh-access-web1.yaml
#   sửa: metadata.name = ssh-access-web1
#        node_labels.access-id = 'web1'
#        logins = ['ubuntu']   (login OS cho phép trên server đó)
docker exec -i teleport tctl create -f - < ssh-access-web1.yaml
```

Xong: user1 vào GUI sẽ thấy "web1" để xin quyền → admin duyệt → user1 bấm
**Use access** để SSH vào web1 trong thời hạn `max_session_ttl`.

## 7. Sao lưu (QUAN TRỌNG — đây là bảo hiểm cho cả cụm)

Từ lúc cụm chạy thật, `/var/lib/teleport` (volume) là CA + toàn bộ dữ liệu. Mất nó
= mất cụm. Dùng `backup.sh` kèm trong thư mục này:

```bash
# chạy thử 1 lần
VOLUME=docker_teleport-data OUT_DIR=/var/backups/teleport ./backup.sh

# đặt lịch cron 2h sáng mỗi ngày (crontab -e):
0 2 * * *  VOLUME=docker_teleport-data OUT_DIR=/var/backups/teleport /path/to/docker/backup.sh
```

> Tên volume thường là `<tên-thư-mục>_teleport-data` (mặc định `docker_teleport-data`).
> Kiểm tra bằng `docker volume ls`. Copy các file `.tgz` sang nơi khác máy (NAS,
> S3...) để phòng cả ổ đĩa máy prod hỏng.

---

## Lệnh vận hành hằng ngày

```bash
docker logs -f teleport                       # xem log
docker compose ps                             # trạng thái container
docker exec teleport tctl status              # thông tin cụm + CA
docker exec teleport tctl get nodes           # các server đã enroll
docker exec teleport tctl requests ls         # các request đang chờ
docker exec teleport tctl requests approve <id>   # duyệt bằng CLI (ngoài GUI)
docker exec teleport tctl lock ls             # các lock "End session"
docker exec teleport tctl rm locks/ssh-access-revoke-<requestID>   # gỡ kẹt 1 user
docker compose restart teleport               # khởi động lại
docker compose down                           # tắt (SIGQUIT -> drain mềm)
```

Nâng cấp phiên bản: build image tag mới (`:v2`) → copy sang → đổi `TELEPORT_TAG=v2`
→ `docker compose up -d`. Volume giữ nguyên nên CA/dữ liệu không mất. Lỡ có lỗi thì
đổi lại `:v1` là rollback.

## Lưu ý & lỗi hay gặp

- **SQLite = chỉ 1 container.** Đừng chạy 2 bản auth trên cùng volume. Muốn HA
  (nhiều bản) phải đổi backend sang etcd/dynamo — ngoài phạm vi quy mô này.
- **`cluster_name` đặt 1 lần**, không đổi sau khi cụm đã chạy.
- **`public_addr`** phải gọi được từ cả browser (cổng 3080) lẫn node agent (reverse
  tunnel 3024). Dùng `network_mode: host` (đã set trong compose) cho đơn giản nhất.
- **Sao lưu nhất quán:** tar volume khi container đang chạy thường OK, nhưng muốn
  chắc chắn 100% thì `docker compose stop` trước khi sao lưu (downtime ngắn) rồi
  `up -d` lại — làm định kỳ (vd hằng tuần).
- **TLS/cert:** mặc định cert tự ký → browser cảnh báo. Muốn cert thật: điền
  `https_keypairs` (cert có sẵn) hoặc `acme` (Let's Encrypt, cần DNS công khai +
  cổng 443) trong `teleport.yaml`, và mount thư mục cert vào container nếu dùng
  file (bỏ comment dòng `./certs` trong `docker-compose.yml`).
