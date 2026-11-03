# Flashpay 刷机包赞助与资源交付

Next.js 16 / React / Prisma 6.19.3 / SQLite 的单实例应用。无需访客注册：自主确认赞助后取得同一资源入口；不接入支付 API，不核验到账。后台仅一个配置管理员，记录和统计均为「自报赞助金额」。

支持 Docker 部署，镜像由 GitHub Actions 构建并发布到 `ghcr.io/chuensan/flashpay`。本仓库不是已上线声明；真实二维码、适用机型、代理与服务器部署仍需验收。内部需求、运行日志和验收截图不随公开仓库发布。

## Docker / GHCR

[公开仓库](https://github.com/ChuenSan/flashpay) · [构建记录](https://github.com/ChuenSan/flashpay/actions/workflows/docker.yml) · [容器镜像](https://github.com/ChuenSan/flashpay/pkgs/container/flashpay)

镜像面向 Linux amd64。推送 `main` 会发布 `latest` 和提交 SHA 标签，推送 `v*` 标签会发布对应版本；Pull Request 只构建和验证。构建使用仓库自带的 `GITHUB_TOKEN`，无需 Docker Hub 账号或额外发布密钥。

镜像已验证可以匿名拉取，无需 `docker login`。若将来另建 GHCR 包后遇到权限拒绝，可在[包设置](https://github.com/users/ChuenSan/packages/container/flashpay/settings)中核对 **Change visibility → Public**；仓库与镜像的可见性需要分别确认。

在部署服务器安装 Docker 和 Compose **2.30.0 或更新版本**，然后：

```sh
cp .env.example .env.docker
chmod 600 .env.docker
# 用编辑器填写 .env.docker，再启动
docker compose pull
docker compose up -d
```

填写 `APP_ORIGIN`、`ADMIN_USERNAME`、`ADMIN_PASSWORD_HASH`、`SESSION_SECRET`、`DOWNLOAD_URL`。Compose 以 `format: raw` 原样读取环境文件：密码哈希必须是**不带 `--dotenv` 的原始哈希**，不要加引号或 `\$` 转义；可通过本地 `npm run --silent admin:hash` 交互生成。数据库地址和代理头由 Compose 设置。环境文件仅在运行时注入，不进入镜像或 Actions。

容器以非 root 用户启动，自动执行 Prisma 迁移，数据库保存在 `flashpay-data` 命名卷；重建容器保留数据，`docker compose down -v` 会删除该卷。宿主机只开放 `127.0.0.1:3000`，必须配合 [nginx 模板](deploy/nginx.conf)配置真实域名、HTTPS，并覆盖 `X-Real-IP`。

更新时运行 `docker compose pull && docker compose up -d`；本地构建用 `docker compose build`。容器数据的备份和停机恢复需针对命名卷安排，现有 systemd 备份任务不会自动覆盖 Docker 卷。

## 本地快速开始

在仓库根目录操作，所有工具经 `./scripts/project-tool` 使用固定 Node。依赖已由主任务安装时跳过 `npm ci`；运行时缺失则先按[工具说明](docs/tooling.md)恢复：

```sh
./scripts/project-tool npm ci
./scripts/project-tool install -d -m 700 var var/data
./scripts/project-tool cp .env.example .env
./scripts/project-tool chmod 600 .env
./scripts/project-tool sh -c 'umask 077; ./scripts/project-tool npm run --silent admin:hash -- --dotenv > var/admin-password.env'
```

哈希脚本在 TTY 无回显读取密码；不要把密码放进命令参数、shell 变量或日志。非交互使用时从权限 0600 的私密文件重定向 stdin，不用 `echo 密码`。默认只输出后端 `hashPassword` 生成的原始哈希；`--dotenv` 输出已转义的 `ADMIN_PASSWORD_HASH=…` 行，没有默认用户名或密码。

用编辑器填写 `.env`，权限保持 0600：

- `APP_ORIGIN=http://127.0.0.1:3000`，`ADMIN_USERNAME` 自选。
- 将 `var/admin-password.env` 的整行复制到 `.env` 对应位置。`--dotenv` 已把每个 `$` 写成 `\$`；仅加单引号不能阻止 Next 变量展开。**systemd 环境文件必须用不带 `--dotenv` 生成的原始哈希**，不能复制这条转义行。
- `SESSION_SECRET` 独立生成高熵随机值，至少 32 字节，不能复用密码或备份口令。
- `DATABASE_URL=file:../var/data/flashpay.db`（相对于 Prisma schema）。
- `DOWNLOAD_URL` 手工配置真实资源地址，不用示例 URL，也不要放进 `NEXT_PUBLIC_*`。
- 本地直连 `TRUSTED_PROXY_IP_HEADER` 留空；生产强制 `x-real-ip`，只适用于应用仅 `127.0.0.1` 可达且 nginx 覆盖单个来源 IP 的部署。

可用下面的命令将随机 secret 写入私密临时文件，不打印到终端；配置后删除两个临时文件：

```sh
./scripts/project-tool python3 -c 'import os,secrets; f=os.open("var/session-secret",os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600); os.write(f,secrets.token_hex(32).encode()); os.close(f)'
./scripts/project-tool rm -- var/admin-password.env var/session-secret
./scripts/project-tool npm run db:generate
./scripts/project-tool sh -c 'umask 077; ./scripts/project-tool npm run db:migrate'
./scripts/project-tool npm run dev
```

打开 `http://127.0.0.1:3000`，后台 `/akak`。前台要求支持 Web Locks 的现代浏览器（生产 HTTPS）；初始化跨标签页串行，不支持时明确提示且不开放确认，避免恢复身份被并发覆盖。本地直连没有 socket IP，因此仅记录明确的 `unknown` 标记；真实 IP 验证必须使用受控覆盖头的本地/生产代理，不能把开发标记当真实地址。哈希改变后会话自动失效是**后端**职责，部署环境文件修改后需重启进程才能载入新配置。

## 安全运维

[部署、持久化、代理、日志、每日加密备份与离线恢复](docs/deployment.md)

- 仅单台持久化服务器、单实例，不用于无持久化磁盘的 Serverless。
- `scripts/backup.py` 用 Python 标准库 SQLite online backup，再通过 `deploy/backup-crypto.mjs` 用 Node 内置 AES-256-GCM 认证加密并验证；按最近 7 个 UTC 备份日期保留；独立清理 timer 和备份任务的退出清理不依赖密钥或新备份成功，无需 GPG 或新包。
- `scripts/restore.py` 强制检查应用服务停止，认证解密及完整性检查后原子恢复；非空库须显式 `--replace`。两脚本都须用 `--node` 指定可靠 Node 绝对路径；恢复后必须人工复核并重做期间删除操作。
- Docker 的生产 build 在 GitHub Actions 中执行，构建后验证数据库迁移和 HTTP 启动，再发布 GHCR 镜像。
- `.env`、备份口令、数据库、CSV、私密配置和真实凭据绝不提交、绝不放 `public/`。

## 检查与验证

```sh
./scripts/project-tool npm run typecheck
./scripts/project-tool npm run lint
./scripts/project-tool npm --prefix .pi/tools run format:check
```

`verify:api` 和 `verify:browser` 是会写入、删除自身测试确认的验证脚本，只能显式授权后对独立测试环境运行，不用于生产；参数见脚本文件头。浏览器验证需要本地 Chromium 路径，不自动下载或安装浏览器。测试记录不代表付款或网盘可用性。

运行依赖审计已无已知问题；开发工具链仍有 moderate 级传递依赖告警，不能用破坏兼容性的 `npm audit fix --force` 隐藏。`deepmerge-ts` 覆盖到 8.0.2 以修复 Prisma CLI 传递依赖告警，并已验证生成与迁移；后续升级需重新验收。内部实施记录和验收截图保存在本地 `.scratch/`，不随公开仓库发布。
