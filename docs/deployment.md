# 单实例生产部署与安全运维

本文是**部署模板与待验收操作手册，不是已经上线的声明**。基准为 [spec](../.scratch/sponsorship-delivery/spec.md)：Next.js 16、Prisma 6.19.3、SQLite、单台持久化服务器、单实例。禁止多实例同时写库或无持久化磁盘的 Serverless 部署。

所有命令从仓库根目录 `/opt/flashpay` 通过 `./scripts/project-tool` 执行。固定 Node 缺失时先参照[工具说明](tooling.md)恢复引导环境。本轮不跑 production build 或应用测试套件；下面的 build 是**部署阶段**的操作。

## 1. 前提、目录与权限

服务器需 Linux/systemd、nginx、Python 3（含标准库 sqlite3）、项目固定 Node，以及部署域名的有效生产 TLS 证书。备份使用 Node 内置 crypto，无需 GPG 或额外 npm/Python 包。不要申请或使用测试 HTTPS 证书冒充部署验证。依赖与固定 Node 由部署者预先准备；脚本不安装系统包。

| 位置（均需按实际挂载核对）        | 用途与权限                                                        |
| --------------------------------- | ----------------------------------------------------------------- |
| `/opt/flashpay`                   | 只读应用代码及固定运行时；部署者拥有，服务用户不得改代码          |
| `/opt/flashpay/.next/cache`       | 构建后创建，服务用户可写的运行缓存，不放数据库                    |
| `/var/lib/flashpay/flashpay.db`   | 明确的持久化 SQLite **源**；目录 0700、库文件 0600，flashpay 拥有 |
| `/var/backups/flashpay`           | 独立备份挂载/存储位置，目录 0700、文件 0600，flashpay 拥有        |
| `/etc/flashpay/backup.passphrase` | 独立备份加密口令文件，0600，flashpay 拥有                         |
| `/etc/flashpay/flashpay.env`      | 认证及应用配置，0600，root 拥有；systemd 管理器读取               |

创建无登录 shell 的 `flashpay` 系统用户/组（通过服务器账号管理流程）。示例初始化：

```sh
./scripts/project-tool sudo install -d -m 750 -o root -g flashpay /etc/flashpay
./scripts/project-tool sudo install -d -m 700 -o flashpay -g flashpay /var/lib/flashpay /var/backups/flashpay
./scripts/project-tool sudo install -m 600 -o root -g root .env.example /etc/flashpay/flashpay.env
```

`/var/backups` 只是模板路径名；**必须确认它实际位于独立持久化卷/存储上**，不能仅在同一故障磁盘另建文件夹就宣称异地备份。脚本验证路径分离但无法证明物理独立。父目录应由可信管理员控制，不允许其他用户替换目录/符号链接。

数据库源目录、备份目标目录、secret 目录必须分别独立，不互相包含。脚本要求绝对路径；拒绝 `public/`（含解析前后符号链接路径）、目标等于源、备份放在数据库目录内、公开目录恢复源、symlink 文件端点，以及不符合私密权限的输入。只接受操作者拥有的单硬链接 0600 文件，不会自动放宽权限。

这些私密文件、数据库/WAL/SHM、CSV 导出、恢复操作记录和真实密钥**不入仓库、不进静态目录、不打印内容**。`var/`、本机 `.env` 已被忽略，但 `/etc`、备份挂载及外部配置仍需人工保密管理。需要恢复的应用配置也应另行加密离线保管，认证仅保存哈希，不保存管理员明文密码；不要把唯一解密口令与唯一备份存放在一起。

## 2. 凭据与环境

用私密编辑器配置 `/etc/flashpay/flashpay.env`：

```sh
./scripts/project-tool sudoedit /etc/flashpay/flashpay.env
```

- `APP_ORIGIN`：真实生产 `https://公共部署域名`，严格没有路径、查询、片段或尾 `/`，不能是 localhost 或 IP。
- `ADMIN_USERNAME`：管理员自选，无默认账号。
- `ADMIN_PASSWORD_HASH`：必须调用现有后端 `src/lib/auth-password.ts` 的 `hashPassword`，不要另造哈希格式。
- `SESSION_SECRET`：至少 32 字节独立高熵随机材料；不可使用示例字符串、管理员密码或备份口令。
- `DATABASE_URL=file:/var/lib/flashpay/flashpay.db`：Prisma URL；备份/恢复参数则是 `/var/lib/flashpay/flashpay.db`，**不带 `file:`**。
- `DOWNLOAD_URL`：部署者从 spec §2 手工复制真实链接，作为初始/回退地址；这里和 `.env.example` 不填 example 下载链接。登录 `/akak` 可修改“下载链接”并保存到数据库，优先于环境变量，新的确认、重试和刷新恢复立即使用新地址；已打开的下载入口需刷新。设置随数据库备份和恢复。升级时执行新增迁移、生成 Prisma Client 并重启应用。不得写入 `NEXT_PUBLIC_*`、静态资源或初始客户端页面。
- `TRUSTED_PROXY_IP_HEADER=x-real-ip`：已与后端 config 对齐，production 强制配置；其安全性完全依赖第 4 节的隔离及覆盖边界。
- `NODE_ENV=production`：由应用 systemd unit 设置；后端强制 HTTPS，Cookie 应为 `Secure` / `HttpOnly` / `SameSite`。不得为了绕过验证而降为 development。

生成管理员密码哈希（TTY 不回显，输出文件不会打印到终端）：

```sh
./scripts/project-tool install -d -m 700 var
./scripts/project-tool sh -c 'umask 077; ./scripts/project-tool npm run --silent admin:hash > var/admin-password.raw'
```

将原始哈希填入 **systemd EnvironmentFile**，完成后删除临时文件。该文件不展开 `$`，原始 `scrypt$…` 可单引号包裹，**不要添加 `\$`**。不要 shell `source` 配置，不要将密码作为命令参数、环境变量或 shell 历史内容。

**Next `.env` 是另一种语法**：支持 `$` 展开，必须用 `\$`；仅单引号不能保证。开发环境可执行：

```sh
./scripts/project-tool sh -c 'umask 077; ./scripts/project-tool npm run --silent admin:hash -- --dotenv > var/admin-password.env'
```

它输出可直接放入 Next `.env` 的 `ADMIN_PASSWORD_HASH=…` 转义行。不要把该行复制到 systemd。非交互场景可用 `< /独立私密目录/password-file` 提供 stdin（0600，使用后删除），不接受密码参数；stdout 仅为哈希或赋值行，stderr 仅提示或固定错误。不要把这些文件送入 CI 日志/终端录屏。

下例直接创建两个秘密文件，不输出内容；已存在时拒绝覆盖。随机值用途彼此独立：

```sh
./scripts/project-tool sudo python3 - <<'PY'
import os, pwd, secrets
u = pwd.getpwnam('flashpay')
for path, uid, gid in [('/etc/flashpay/backup.passphrase', u.pw_uid, u.pw_gid),
                       ('/etc/flashpay/session-secret.pending', 0, 0)]:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(secrets.token_hex(32) + '\n')
        os.fchown(f.fileno(), uid, gid)
PY
```

将 `session-secret.pending` 的值用私密编辑器填入 env 后删除 pending。备份口令文件保留，必须有独立安全托管副本，至少 32 字节随机材料、单行、0600。丢失口令无法恢复；更换备份口令时须托管旧口令直到旧备份过期，不能直接覆盖唯一旧密钥。

```sh
./scripts/project-tool rm -- var/admin-password.raw
./scripts/project-tool sudo rm -- /etc/flashpay/session-secret.pending
```

改管理员哈希/用户名后重启服务以载入配置；后端凭据指纹验证应使**已有管理会话自动失效**，不是哈希 CLI 去操作 session 表。部署验收要实际验证这一点。更改 SESSION_SECRET 还会使浏览器恢复 cookie 等签名失效。

## 3. 构建、迁移与应用服务

发布维护窗口先停止旧应用和 backup timer；数据库迁移前做一次已验证的加密备份。首次空库无需先备份。不要把本地 `.env` 上传到生产代码目录；生产构建需要的环境也必须经同一个私密 EnvironmentFile 注入，不能在命令行内联秘密。

在部署者准备好的私密生产环境下执行（不以服务用户安装依赖）：

```sh
./scripts/project-tool npm ci
./scripts/project-tool npm run db:generate
./scripts/project-tool npm run build
```

可以用 systemd-run 给构建/迁移注入 EnvironmentFile，无需 shell 解析：

```sh
./scripts/project-tool sudo systemd-run --wait --pipe --collect --unit=flashpay-build --working-directory=/opt/flashpay --property=EnvironmentFile=/etc/flashpay/flashpay.env --setenv=NODE_ENV=production /opt/flashpay/scripts/project-tool npm run build
./scripts/project-tool sudo systemd-run --wait --pipe --collect --unit=flashpay-migrate --working-directory=/opt/flashpay --property=User=flashpay --property=Group=flashpay --property=UMask=0077 --property=EnvironmentFile=/etc/flashpay/flashpay.env /opt/flashpay/scripts/project-tool npm run db:migrate
```

选择一次 build 方式即可，不重复构建；临时构建 unit 默认由部署管理员运行，需私下审核构建输出不含秘密。首次迁移后核查库 0600、目录 0700。Prisma client、`.next` 和固定 `.tools/node` 必须保留在部署目录，不能只复制静态页面。构建后创建缓存并安装已审阅路径的模板：

```sh
./scripts/project-tool sudo install -d -m 700 -o flashpay -g flashpay /opt/flashpay/.next/cache
./scripts/project-tool sudo install -m 644 deploy/flashpay.service deploy/flashpay-backup.service deploy/flashpay-backup.timer deploy/flashpay-retention.service deploy/flashpay-retention.timer /etc/systemd/system/
./scripts/project-tool sudo systemctl daemon-reload
./scripts/project-tool sudo systemctl enable --now flashpay.service
```

`deploy/flashpay.service` 只启动一个 Next 进程，npm start 绑定 `127.0.0.1:3000`，不使用 cluster/PM2 多实例。网络防火墙不得公开 3000。代码只读；SQLite 可写持久化路径固定；服务沙箱禁止读取备份口令和备份目录。模板未解决本机不可信用户访问 loopback 的问题：主机须为可信单租户，不向不可信容器/用户开放 origin。

## 4. nginx、真实 IP 与日志

审阅 `deploy/nginx.conf` 后替换部署域名及证书路径，安装到发行版 nginx 的 `http {}` include 目录。**没有提供证书，也没有获取/验证任何测试或生产证书**。

```sh
./scripts/project-tool sudo nginx -t
./scripts/project-tool sudo systemctl reload nginx
```

信任链必须全部成立：

1. Next 仅监听 `127.0.0.1`；nginx 是唯一可达入口，公共端口仅 80/443。
2. 模板按 TCP peer 的 `$remote_addr` **覆盖** `X-Real-IP`，只传单个 IP。清空 `X-Forwarded-For`、`Forwarded`、`CF-Connecting-IP` 等，不使用 `$proxy_add_x_forwarded_for`。
3. 后端只通过 `TRUSTED_PROXY_IP_HEADER=x-real-ip` 信任这条边界，不自动信任任意来访转发头。
4. 检查 nginx `http {}` 没有继承 `real_ip_header` / `set_real_ip_from` 等重写规则。模板假设 nginx 直接面向访客；如加 CDN/LB，须另行审查受信网段、防绕过防火墙与头重写，不能照搬 `0.0.0.0/0` 信任规则。
5. 外部伪造 X-Real-IP/XFF 的确认测试必须证明后端只得到 nginx 覆盖的实际 peer；首页普通访问不得创建确认记录。

两个 server 及**每个 location 均 `access_log off`**。新增 location、默认站点、重定向、CDN/WAF/LB、宿主面板和日志采集器也必须审核，否则仍会留下普通访问 IP。nginx error log 也可能携带 IP/路径，模板送 `/dev/null`；应用 unit 丢弃 stdout/stderr，禁止请求 dump/APM 自动采集与 Prisma query debug。代价是诊断信息减少，改用服务状态、退出码、备份成功时间等无个人信息指标告警；需要排障时用合成数据隔离环境，不能临时开启真实请求日志。

代理关闭缓存和响应落盘，避免 CSV/敏感返回值进入代理缓存或 temp 文件。不要创建公开 CSV 文件或给备份目录设置 nginx alias/root。部署时确认安全 cookie、同源校验、后台鉴权、改密失效及每次 CSV 导出重新验密。

## 5. 每日加密备份

```sh
./scripts/project-tool sudo -u flashpay /opt/flashpay/scripts/project-tool python3 -B scripts/backup.py --node /opt/flashpay/.tools/node/bin/node --database /var/lib/flashpay/flashpay.db --backup-dir /var/backups/flashpay --passphrase-file /etc/flashpay/backup.passphrase
./scripts/project-tool sudo systemctl start flashpay-backup.service
./scripts/project-tool sudo systemctl enable --now flashpay-backup.timer flashpay-retention.timer
./scripts/project-tool sudo systemctl list-timers flashpay-backup.timer flashpay-retention.timer
```

手工备份和 unit 启动是两种验证入口，可任选；正式调度 UTC 每日 03:15，加最多 15 分钟抖动，`Persistent=true` 补跑错过的任务。SQLite online backup API 取得一致性快照（含已提交 WAL 数据），**不能直接 cp 运行中的库文件**。

加密由 `deploy/backup-crypto.mjs` 使用 Node 内置 **AES-256-GCM** 完成，不用无认证的 `openssl enc AES-CBC`。每次加密生成随机 16 字节 salt 和 12 字节 nonce；scrypt 固定 N=32768/r=8/p=1、32 字节派生密钥、64 MiB 内存上限。格式 v1 为 `FPAYBKP` 后接 NUL（8 字节 magic）+ 版本 1（1 字节）+ salt（16）+ nonce（12）+ 密文 + GCM tag（16）；整个 37 字节头作为 AAD。头、密文、tag 或口令错误均拒绝；不接受密文指定 KDF 参数，避免恶意资源成本。掌握密钥的人仍可生成合法备份，认证不等于签名，文件托管依然必须可信。

口令仅从独立 `--passphrase-file` 的 0600 文件读取，命令行只有路径，无明文口令；Node 再次校验文件权限，exclusive-create 输出 0600，认证失败删除临时输出。两脚本都要求 `--node /绝对/可信/node`，禁止使用组/其他用户可写的二进制；模板固定 `/opt/flashpay/.tools/node/bin/node`。可靠运行时及 `deploy/backup-crypto.mjs` 必须随部署保留，不能由应用用户改写。crypto 子进程不继承 NODE_OPTIONS/NODE_PATH 等加载钩子；运行时或 crypto helper 失败均拒绝，绝不回退明文。

流程：0700 临时工作目录 → 0600 SQLite 快照（仅快照转换为独立 DELETE journal 文件，不改源库 WAL 模式）→ integrity_check → 加密 → 再解密验证 GCM tag 与 SQLite 完整性 → 原子发布 → 清理超出最近 7 个 UTC 备份日期的管理文件。快照在加密前 VACUUM，移除历史删除的空闲页残留，不能只做 integrity_check。文件名为 `flashpay-YYYYMMDDTHHMMSSffffffZ.sqlite3.enc`，UTC；仅这个格式、所有者/权限匹配的常规单链接文件参加清理，不按任意文件 mtime，不触碰未管理文件/符号链接。不要人工将其他文件命名成管理格式。并发备份用目录锁互斥。

快照/解密临时明文始终限制权限，正常退出或异常会清理；强制断电/SIGKILL 可能遗留 `.flashpay-work-*` / `.flashpay-restore-*`，管理员在确认无维护进程后私下清理，绝不对未知文件通配删除。建议底层磁盘加密；普通 unlink 不是 SSD 安全擦除保证。

失败不伪报成功，但保留期限不能依赖备份成功：backup unit 的 `ExecStopPost` 会运行 `backup.py prune --backup-dir /var/backups/flashpay`，独立 retention timer 在 UTC 每日 00:00 执行同一清理，不需要源数据库、Node 或口令。按 UTC 日期保留今天及前 6 天，避免每日任务把刚过 7×24 小时的备份拖到第 8 天。清理仅删除工具管理且权限/所有者符合要求的文件，异常失败仍需告警。监控两个 timer、最近成功备份时间、空间和到期清理；服务器停机、存储离线等故障期间不能声称物理到期擦除有保证，恢复服务前须先完成到期清理。线上删除即时生效；独立/异地副本、配置副本也执行同一保留策略，不能额外无限期留存 QQ/IP。不得把原始数据库内容、QQ、IP 或解密结果写入运维日志。

### 既有数据库的删除残留升级

新写连接启用 SQLite `secure_delete=ON`，删除事务再次确认，并尝试提交后截断 WAL；有活跃读取时不强行删除 sidecar。旧版本可能已在空闲页留下 QQ/IP，升级时应先关闭公共入口、停应用及所有写入者，按私密权限保存必要加密备份，再执行：

```sh
./scripts/project-tool sudo -u flashpay /opt/flashpay/scripts/project-tool python3 -B scripts/backup.py sanitize-source --database /var/lib/flashpay/flashpay.db
```

该步骤仅用于停机维护，不在普通访客请求中 VACUUM；后续新快照也独立 VACUUM，不把旧残留再装入新备份。物理 SSD、文件系统快照及独立副本的销毁仍须遵守存储管理策略；SQLite 安全删除不是底层安全擦除证明。

## 6. 停机恢复（必须人工复核删除）

先关闭公共入口/置维护模式，停止 timer 与正在运行的 backup job，再停应用；防止部署器/其他管理员自动重启或手工进程写库。**脚本不会停止或启动应用**。服务检查不能识别管理员选错 unit 或未纳管 writer，因此必须核实只有这个单实例写库。

```sh
./scripts/project-tool sudo systemctl stop flashpay-backup.timer flashpay-retention.timer flashpay-backup.service flashpay-retention.service
./scripts/project-tool sudo systemctl stop flashpay.service
./scripts/project-tool sudo systemctl is-active flashpay.service
```

最后一条应为 inactive（退出码非零属预期）。`restore.py --service flashpay.service` 再次要求 loaded / inactive / dead / MainPID=0，未知、运行中、activating 或缺少 systemctl 均拒绝；安装前还会复查。不要提供跳过停机检查的参数。

确认目标父目录 0700、所有权正确。若有 `-wal` / `-shm` / `-journal`，脚本拒绝恢复，**不会擅自删除**；先把停止状态下的完整数据库文件组转移到独立私密事故目录并核查，再恢复。必要的恢复前副本也需加密、0600 并限期删除，不要当成无限期保留的旁路备份。

将下例输入文件名换成实际 UTC 备份名；不要原样执行占位名：

```sh
./scripts/project-tool sudo -u flashpay /opt/flashpay/scripts/project-tool python3 -B scripts/restore.py --node /opt/flashpay/.tools/node/bin/node --backup /var/backups/flashpay/flashpay-ACTUAL_UTC_TIMESTAMP.sqlite3.enc --database /var/lib/flashpay/flashpay.db --passphrase-file /etc/flashpay/backup.passphrase --service flashpay.service
```

目标不存在或为 0 字节可恢复；**非空数据库默认拒绝**。确实决定替换并已核查恢复前副本时，才在上述命令末尾加 `--replace`。用 flashpay 身份执行，使安装后的 0600 文件归应用所有，避免 root 创建的库导致服务无法读写。备份输入、目标、口令必须在独立私密目录，任何 `public/` 源都不接受。

恢复先在目标文件系统创建 0600 临时文件，要求 AES-256-GCM 认证解密成功及 `PRAGMA integrity_check = ok`，随后原子安装；认证/完整性/权限检查失败不替换原库。磁盘/fsync 等发布后的故障可能已经安装文件，失败后必须先核查状态，不要直接重试 `--replace`。

**保持公共入口关闭，必须完成：**

1. 核对恢复点、schema 与当前程序匹配、权限和持久化挂载。必要迁移只在备份及维护窗口后执行。
2. 轮换 SESSION_SECRET（必要时管理员哈希），避免从备份复活旧管理会话；注意这也会清除原浏览器解锁恢复能力。
3. 私下复核备份时点至停机期间的删除操作，重新删除相应记录，避免完整 QQ/IP 和公共名单重新出现；隐藏状态也需复核。可维护独立加密、最少记录 ID 的操作清单，不向普通日志复制 QQ/IP。
4. 如需后台执行复删，仅在公共入口仍关闭、可信管理通道下启动应用，完成后检查名单/统计/恢复入口，不得先对公众开放再补删。
5. 私下核查数据及权限，重新做加密备份，恢复 timer；全部验收后才开放入口。销毁临时导出/明文及事故副本，遵守七天保留规则。

```sh
./scripts/project-tool sudo systemctl start flashpay.service
./scripts/project-tool sudo systemctl start flashpay-backup.timer flashpay-retention.timer
```

不要把本节当作无人值守恢复流程。人工删除复核是上线前强制门槛。

## 7. 部署验收与本轮验证边界

待在真实服务器逐项记录，不预勾选完成：

- [ ] 确认真正使用 spec 对应的收款二维码，手机可识别；人工核实资源名称、适用机型、刷机风险和 B 站视频内容，不能凭空宣传。
- [ ] 初始 HTML、公开静态资源和客户端包不泄漏真实下载地址；确认保存后才解锁。
- [ ] production build 在部署阶段完成，迁移成功；重启服务/服务器后数据持久保留。
- [ ] APP_ORIGIN、TLS、Secure cookie、loopback 暴露面、伪造转发头覆盖、管理员改密会话失效、CSV 二次验密实际通过。
- [ ] 代理、默认站点、应用、CDN/采集系统无普通访客访问日志；完整 QQ/IP 仅在确认记录与私密备份内。
- [ ] 每日备份实际执行、备份为独立存储且 0700/0600、AES-256-GCM round-trip/tag 验证正确；错误口令/篡改密文不会替换目标。
- [ ] 用独立临时/演练库做停机恢复，验证非空拒绝/显式 replace、SQLite 完整性、人工复删与重启持久化；不得以生产真实库试验本脚本。

本机缺少 `gpg`，未安装系统包，采用可本地验证的 Node crypto 方案。已使用独立临时 SQLite WAL fixture 和随机临时 passphrase file 实跑加密备份/恢复：仅包含已提交数据、integrity_check、显式 replace、错误口令、salt/nonce/密文/tag 篡改、截断、已认证但非 SQLite 内容拒绝、权限与公开目录限制、旧版七天清理检查通过；本轮另补独立到期清理，不再将备份失败视为无限期保留依据，未访问 main 的真实数据库。哈希工具的 raw / `--dotenv` 输出已与后端模块校验，并经实际 Next env loader 验证 `$` 转义；伪 TTY 验证无回显、Unicode 退格与终端状态恢复，stdin 空值/多行/超长输入均拒绝。恢复检查使用受控 systemctl 状态 fixture，**不代表真实 systemd 停机已验收**。systemd/nginx/TLS、物理独立存储、真实二维码扫码与机型内容仍需部署验收，不能宣称已上线。
