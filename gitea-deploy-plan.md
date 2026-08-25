# Gitea 安装部署方案 — volc-ark (14.103.23.160)

目标：一套 Gitea 同时搞定
  1. Git 仓库托管（push/pull）
  2. 项目管理（Issues / Milestones / Labels / Project Boards 看板 / PR / Wiki）
  3. 自动化部署（Gitea Actions + act_runner host 模式，免 docker）

服务器现状核对：veLinux(dnf系) 4C/7.5G/40G，nginx 已跑(80)，
taiwei 网关 8688，10000-10002 已占用。Gitea 用 3000 端口，数据库用 SQLite（免装 MySQL/PostgreSQL）。

## 第一步：装 Gitea（单二进制 + SQLite，内存约 300-500MB）

```bash
# 1. 建用户（不用 root 跑）
useradd -r -m -s /bin/bash gitea

# 2. 下载二进制（服务器 GitHub 直连免代理，也可用国内镜像 dl.gitea.cn）
V=1.23.8
wget -O /tmp/gitea https://dl.gitea.com/gitea/${V}/gitea-${V}-linux-amd64
# 国内镜像备选：https://dl.gitea.cn/gitea/${V}/gitea-${V}-linux-amd64
install -o gitea -g gitea -m 755 /tmp/gitea /usr/local/bin/gitea

# 3. 目录结构
mkdir -p /var/lib/gitea/{custom,data,log}
chown -R gitea:gitea /var/lib/gitea
chmod -R 750 /var/lib/gitea

# 4. systemd 服务
cat > /etc/systemd/system/gitea.service <<'EOF'
[Unit]
Description=Gitea (Git with a cup of tea)
After=network.target

[Service]
Restart=always
User=gitea
Group=gitea
WorkingDirectory=/var/lib/gitea/
ExecStart=/usr/local/bin/gitea web --config /etc/gitea/app.ini
RestartSec=2s
Type=simple

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now gitea

# 5. 首次访问 http://14.103.23.160:3000 完成安装表单：
#    数据库 = SQLite；路径 /var/lib/gitea/data/gitea.db
#    站点URL = http://14.103.23.160:3000/  （后面接了 nginx 再改成公网地址）
```

## 第二步：挂到现有 nginx（80 端口，子路径 /gitea/）

```bash
# /etc/nginx/conf.d/gitea.conf（注意：这里的 location 带 server 块，可放 conf.d）
cat > /etc/nginx/conf.d/gitea.conf <<'EOF'
server {
    listen 80;
    server_name 14.103.23.160;
    location /gitea/ {
        proxy_pass http://127.0.0.1:3000/;   # 尾斜杠=剥 /gitea 前缀
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF
nginx -t && nginx -s reload
# 之后 app.ini 里 ROOT_URL 改成 http://14.103.23.160/gitea/ 并重启 gitea
```

## 第三步：项目管理开箱即用

仓库页右上即可用：Issues（问题单）、Milestones（里程碑）、Labels、Projects（看板：
To Do / In Progress / Done 拖拽）、Pull Requests、Wiki。单人/小团队够用，无需额外装。

## 第四步：自动化部署 — act_runner（host 模式，免 docker）

关键点：这台没装 docker，用 host 模式让 job 直接在宿主机跑。

```bash
# 1. 建 runner 用户（与 gitea 分开；host 模式会以该用户执行仓库代码，别用 root）
useradd -r -m -s /bin/bash gitea-runner

# 2. 下载 act_runner（服务器 GitHub 直连）
RV=1.23.1   # 与 Gitea 版本配套，具体版本看 https://gitea.com/gitea/act_runner/releases
wget -O /tmp/act_runner https://gitea.com/gitea/act_runner/releases/download/v${RV}/act_runner-${RV}-linux-amd64
install -o gitea-runner -g gitea-runner -m 755 /tmp/act_runner /usr/local/bin/act_runner

# 3. 在 Gitea 网页生成注册令牌：
#    管理后台(登录admin) → Actions → Runners → Create new runner → 复制注册令牌 <TOKEN>

# 4. 注册（--instance 用公网 ROOT_URL，不要用 127.0.0.1）
sudo -u gitea-runner act_runner register \
  --instance http://14.103.23.160/gitea/ \
  --token <TOKEN> \
  --no-interactive \
  --labels ubuntu-latest:host   # host 模式关键标签

# 5. 启动并守护
sudo -u gitea-runner act_runner daemon   # 先手动跑一次确认注册成功
# 确认后写 systemd 服务（User=gitea-runner，ExecStart=/usr/local/bin/act_runner daemon）
```

## 第五步：写自动部署 workflow（例）

前端/后端项目根目录建 `.gitea/workflows/deploy.yml`：

```yaml
name: deploy
on: [push]                       # push 即触发；也可加 branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest       # 对应上面 host 标签
    steps:
      - uses: actions/checkout@v4
      # 前端：build 后 rsync 到 nginx 站点目录
      - run: |
          npm ci && npm run build
          rsync -a --delete dist/ /var/www/myapp/
          systemctl reload nginx   # 或直接 nginx -s reload
      # 后端：build + 按端口杀旧进程重启
      - run: |
          npm ci && npm run build
          PID=$(ss -tlnp | grep :10010 | grep -oE "pid=[0-9]+" | cut -d= -f2)
          [ -n "$PID" ] && kill $PID && sleep 1
          nohup node dist/main.js > /tmp/myapp.log 2>&1 &
```

## 注意事项 / 后续可选项

- 内存占用实测约 300-500MB，7.5G 无压力；act_runner host 模式下 job 直接占宿主机资源，
  同一时间别并发太多 job。
- 备份：`gitea dump` 一条命令打包数据库+仓库+配置（建议配 cron 定时跑）。
- 可选项：GitHub 仓库镜像（Import）拉进来；或用 Webhook 把 taiwei 的 GitHub 仓库同步过来。
## 实装记录(2026-08-19 已装通, 与上文有出入处以此为准)

实际装机参数、踩坑与偏差,供复装参考:

1. Gitea 版本 1.23.8;systemd ExecStart 必须加 `--work-path /var/lib/gitea`,
   否则 Gitea 默认把数据目录建到二进制所在目录(/usr/local/bin/data),
   报 `mkdir /usr/local/bin/data: permission denied`。
2. 创建 admin 用户用 CLI(装了 INSTALL_LOCK 后网页装不了):
   `sudo -u gitea /usr/local/bin/gitea --config /etc/gitea/app.ini --work-path /var/lib/gitea admin user create --username admin --password <pw> --admin`
   (admin 密码已存 /root/.gitea_admin_pw;API token 存 /root/.gitea_api_tok)
3. act_runner 版本 0.2.11。注册时用 `sudo -u <user> -H bash -c "cd ~ && ..."`,
   否则 `cd /root` 继承 pwd 导致 `.runner` 写不进目标家目录(permission denied)。
4. 重要偏差:本机天气部署需要写 /root/workspace + 杀进程重启(root 才能做),
   gitea-runner 非特权用户跑 job 会 `cd: /root/workspace: Permission denied`。
   → 实际改为 root 运行 act_runner(systemd User=root, WorkingDirectory=/root/.act_runner)。
   仓库可信(自有项目)时可用;若跑不可信代码应退回非特权用户 + sudo 白名单。
5. Gitea Actions secret 名不允许下划线:`GITEA_TOKEN`/`gitea_token` 都报
   "invalid secret name",无下划线的 `GIT_TOKEN` 可用。workflow 里引用 secrets.GIT_TOKEN。
6. 加 gitea.conf(server_name=IP)后,Host=IP 的 /taiwei/... 请求被该 server 块截走返回 404
   (原 taiwei.conf 是 server_name _ 才 include 了 projects-locations)。
   修复:gitea.conf 里也 `include /etc/nginx/taiwei-projects-locations.conf;`。
7. Gitea MCP:官方 1.23 无内置 MCP 端点,用 MushroomFleet/gitea-mcp(Node)装 /opt/gitea-mcp,
   配入 taiwei /root/.taiwei/mcp.json(stdio, node build/index.js, env 带 GITEA_INSTANCES)。
   两坑:a) tsconfig 开了 incremental,删 build 目录后须同时删 tsconfig.tsbuildinfo 否则不重编译;
   b) pino 默认写 stdout 会污染 MCP stdio 协议,须 `pino(..., pino.destination(2))` 改走 stderr。
   taiwei 重启后日志见 "Gitea MCP Server started successfully" 即接入成功。
8. 天气项目已入库 admin/weather-app(private),push→main 自动部署前端+后端已实测成功
   (run#2 success,10002 服务重启,nginx 反代 /taiwei/8c6976e5/weather-app/ 200)。
9. 实测内存:Gitea 357MB + act_runner 20MB,空闲很省;job 运行期才临时吃内存。
10. 遗留:旧 gitea-runner(uid 990)与 root-runner 两个 runner 并存,可后台删旧的(非必须)。
