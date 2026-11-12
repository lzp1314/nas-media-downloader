# NAS影视下载器

<p align="center">
  <img src="docs/banner.png" alt="NAS影视下载器" width="880" />
</p>

<p align="center">
  在浏览器里输入片名，从你自己配置的数据源检索，点一下直接下到 NAS 指定文件夹。
</p>

<p align="center">
  <img src="docs/shot-results.png" alt="搜索结果" width="880" />
</p>

## 功能

- **一个框搞定**：输入片名自动搜索，不用按回车，也不用记网址
- **多来源聚合**：同名影片自动合并成一条，资源按 `4K / 蓝光 / 1080P / 720P` 分档，重复磁力自动去重
- **磁力直下**：内置 aria2，DHT / PEX / LPD 全开，自动加载 tracker，支持断点续传
- **选集下载**：磁力或 .torrent 种子可以先列出里面的文件，勾哪集下哪集，合集不用整包下
- **只做种子 / 磁力**：网盘分享需先在你自己的网盘客户端转存，本项目不解析、不下载网盘资源
- **多存储库**：支持挂载多块盘，按「库 → 分类文件夹」两级选择；电影默认落「电影」、剧集落「电视剧」、动漫落「动漫」，也能进任意子目录或就地新建
- **目录白名单**：只能写进容器挂载的目录，没法越权写到系统盘
- **任务管理**：进度、速度、剩余时间、连接数，支持暂停 / 继续 / 删除（可连同文件一起删）
- **可选引擎**：默认 aria2，也能接自己的 qBittorrent
- **轻量**：零 npm 依赖，单容器，x86 与 ARM 都能跑

<p align="center">
  <img src="docs/shot-home.png" alt="首页" width="440" />
  <img src="docs/shot-download.png" alt="选择保存目录" width="440" />
</p>

## 部署

### 1. 建项目目录

推荐 clone 仓库 —— 只是为了拿到 `docker-compose.yml` 和 `config/*.example.json`，**不需要用源码构建镜像**：

```bash
git clone https://github.com/lzp1314/nas-media-downloader.git /vol1/1000/docker/nas-media-downloader
cd /vol1/1000/docker/nas-media-downloader
```

不用 git 也行：在 NAS 上新建一个空目录，把第 2 节的 YAML 存成 `docker-compose.yml`，再建一个空的 `config/` 子目录（第 3 节要往里写 `sites.json`）。

> `./config:/config` 这个卷会让 Docker 自动建出 `config/` 目录，但**镜像里不含任何示例配置文件**（`.dockerignore` 排除了整个 `config/`）。只写 compose、不准备 config 的话，第 3 节的 `cp config/sites.example.json` 会找不到文件；这种情况直接照模板手写 `config/sites.json` 即可。

### 2. 改配置

把下面这段**整段复制**成 NAS 项目目录里的 `docker-compose.yml`（这是完整文件，不是节选；clone 下来的目录里已有一份，直接覆盖即可）：

```yaml
services:
  nas-media-downloader:
    image: ghcr.io/lzp1314/nas-media-downloader:latest
    # 想从源码构建：注释掉上面 image 行，启用下面这行
    # build: .
    container_name: nas-media-downloader
    restart: unless-stopped
    network_mode: host
    environment:
      - TZ=Asia/Shanghai
      - PORT=9696              # Web 界面端口
      - BT_PORT=51413          # BT 监听端口，与其他 BT 软件冲突时改成 51414
      - ENABLE_DHT6=1          # 有 IPv6 时开启 IPv6 DHT
      - PUID=1000              # 下载文件属主，SSH 执行 id 查看
      - PGID=1000
      # 必须显式写：Web 与 aria2 靠它对齐 RPC token，删掉会显示引擎离线
      - ARIA2_SECRET=nas_media_downloader_rpc
      # 留空则局域网免密；账号密码到「设置 → 访问账号」里设，立即生效
      - ACCESS_PASSWORD=
      # aria2 兜底下载目录，必须指向下面真实挂载的某个库
      - DOWNLOADS_DIR=/media/影视
    volumes:
      # 左边换成 NAS 上的真实路径，右边是界面显示的库名，右边保持不动
      - /vol1/1000/影视:/media/影视
      # 多一块盘就再加一行，例如：
      # - /vol4/1000/影视资源:/media/影视资源
      - ./config:/config
```

按自己情况只改三处：`volumes` 左边的媒体路径、`DOWNLOADS_DIR`（跟着第一个库的名字走）、`PUID` / `PGID`。加新盘只要在 `volumes` 里再追加一行映射，程序会自动把它识别成一个库；`MEDIA_ROOT` 默认 `/media`，不用单独写。

两点注意：

- `ARIA2_SECRET` 别删。容器内的 aria2 有默认密钥，而 Web 端读的是这个环境变量，不显式写一行两边 token 就对不上，设置页会显示下载引擎离线。
- `ACCESS_PASSWORD` 留空即可，装好后到「设置 → 访问账号」里设登录账号和密码，面板设置优先、改完立即生效，不用改 YAML 也不用重建容器。

容器使用宿主网络，不再需要 `ports:` 映射；host 模式让容器共享 NAS 的网络栈与 IPv6 能力，BT 监听端口无需 NAT。

`/media` 下的每个一级目录就是一个存储库，界面上按「库 → 分类文件夹」两级选择，加新的盘只要再加一行 volumes。

### 3. 片源配置（资源 A / 资源 B）

> 这一步必须由**实际使用人自己完成**：本项目是一个空壳，仓库和镜像里没有任何资源站地址、片库、账号或资源内容，也不提供、不推荐、不协助寻找任何站点。填什么地址、是否有权访问、是否符合当地法律，都由你自行判断并承担后果。

**步骤**

1. 在 NAS 的 compose 目录里，把示例复制成自己的配置（如果按上面「不用 git」的方式建目录，直接照下方模板新建 `config/sites.json` 即可）：

   ```bash
   cp config/sites.example.json config/sites.json
   ```

2. 编辑 `config/sites.json`，按下面模板填 `sourceA`（资源 A）和 `sourceB`（资源 B）。两者可以只填一个，留空的那个会自动跳过，界面显示「未接入」，不会报错。
3. 保存后重启容器（`docker compose restart`）；不重启也行，配置按文件修改时间自动热加载。
4. 打开「设置 → 片源接入」，看资源库 A / 资源库 B 是否显示已接入。地址只存在本机，不会回显到页面上。
5. `config/sites.json` 已被 `.gitignore` 与 `.dockerignore` 排除，**不会提交到仓库、不会打进镜像**，只留在你自己的 NAS 上。

**模板**（下面全部是占位符，不代表任何真实站点）

```json
{
  "_说明": [
    "以下地址、ID、身份标识均为占位符，请替换为你自己有权使用的服务信息。",
    "sourceA 与 sourceB 可只配其中一个；留空即视为未接入。",
    "也可改用环境变量：SITE_A_BASE / SITE_A_MIRRORS / SITE_A_APP_ID / SITE_A_IDENTITY、SITE_B_SITE / SITE_B_API / SITE_B_SEARCH。",
    "本文件不进仓库、不进镜像；配置内容不会回显到前端页面。"
  ],
  "sourceA": {
    "baseUrl": "https://your-source-a.example",
    "mirrors": [],
    "appId": "<your-app-id>",
    "identity": "<your-identity>"
  },
  "sourceB": {
    "siteUrl": "https://your-source-b.example",
    "apiUrl": "https://your-source-b.example/api",
    "searchUrl": "https://your-source-b.example/search"
  }
}
```

| 分组 | 字段 | 含义 |
|---|---|---|
| A | `baseUrl` | 服务根地址；`mirrors` 可填备用地址数组，按顺序尝试 |
| A | `appId` | 调用接口时附带的 `app_id` |
| A | `identity` | 调用接口时附带的身份标识，只保存在本机配置里 |
| B | `siteUrl` | 站点首页地址，用于生成页面链接与请求头 |
| B | `apiUrl` | 该站接口根地址 |
| B | `searchUrl` | 站内搜索的提交地址 |

需要注意：`sourceA` / `sourceB` 是本项目按**固定接口协议**写好的适配器，不是通用网页解析器。例如 A 会在 `baseUrl` 后拼 `/prod/api/v1/...` 并附带 `app_id`、`identity`，B 走的是另一套约定。这里要填的是符合该接口约定的服务；随便填一个普通网站首页，程序不会报错，只会一直显示未接入或搜不到结果。本项目不适配任意网站。

如你配置的数据源按其自身条款需要登录，请登录**你自己有权使用的账号**；凭据只保存在本机 `config/` 目录，软件不保存密码，也不上传到任何服务器。

其它可选配置（磁力搜索源、首页推荐词）分别是 `config/` 下的 `magnet-sources.example.json`、`hot-sources.example.json`，同样复制成不带 `.example` 的文件再填写，都不进仓库、不进镜像。磁力搜索源也可以在「设置 → 片源接入」里添加：填站点首页或带 `{kw}` 的搜索地址 → 点「测试当前地址」→ 点「添加」，程序会自己找入口；每行可开关、测试、移除。

### 4. 启动

```bash
docker compose up -d
```

默认直接拉取 GitHub 自动构建的镜像（`ghcr.io/lzp1314/nas-media-downloader:latest`，x86 / ARM 双架构），NAS 上不需要装 Node、也不用源码构建；第 1 步 clone 只是为了拿到 compose 和示例配置。

想自己从源码构建：把 `docker-compose.yml` 里的 `image:` 行注释掉、取消 `build: .` 的注释，再执行 `docker compose up -d --build`。

打开 `http://NAS的IP:9696`。

群晖 / 飞牛也可以走图形界面：Docker → Compose → 新建项目 → 把第 2 节的 YAML 粘进去（或指向已有的 `docker-compose.yml`），并确认项目目录里已经建好 `config/`。

### 更新

```bash
# 方式一：拉新镜像（推荐，几秒钟）
docker compose pull && docker compose up -d

# 方式二：SSH 里更新源码并本地构建
git pull && docker compose up -d --build
```

每次推送到 GitHub 的 `main` 分支，Actions 会自动构建并发布新镜像；配置和数据都在 `config/` 与媒体目录的卷里，更新不丢。

## 端口

| 端口 | 协议 | 用途 | 必需 |
|---|---|---|---|
| 9696 | TCP | Web 界面（`PORT` 可改） | 是 |
| 51413 | TCP | BT 监听（`BT_PORT` 可改） | 强烈建议 |
| 51413 | UDP | DHT 监听 | 强烈建议 |

宿主网络模式下容器直接监听 NAS 本机端口，无需在 Docker 里再做映射；路由器 / 防火墙按上表放行即可。

**下载速度主要取决于 51413 有没有放通。** host 网络下 compose 里没有 `ports:` 映射，容器直接监听 NAS 的 51413；需要在 NAS 防火墙放行该端口（TCP + UDP），如果 NAS 在路由器后面、希望外部 peer 能主动连入，再在路由器上把 51413 TCP/UDP 转发到 NAS 内网 IP。**只转发 BT 端口，不要把 Web 9696 直接暴露到公网**；确实需要外网访问 Web，请自行配置 HTTPS 反向代理与访问控制。没放通也能下，但只能连到主动连进来的 peer，速度会明显差一截。

<p align="center">
  <img src="docs/shot-tasks.png" alt="下载任务" width="880" />
</p>

## 使用

1. 首页输入片名（中文即可），停顿一下自动搜索；也可以直接点「正在热播」里的推荐词，分剧集 / 电影 / 动漫三组，点一下就搜（推荐词来自本机片库与片单配置，取不到时会隐藏）
2. 点搜索结果，右侧弹出该片所有来源的资源，按清晰度分组
3. 点「下载」，选保存文件夹 —— 会按影片类型自动帮你选好
4. 只想下某一集：点资源上的「选集」，或首页的「粘贴磁力链接」；勾好集数（可按集号筛选，如 `28` 或 `1-12`）再选目录。网盘分享链接请先在网盘官方客户端转存，本项目不解析也不下载
5. 在「任务」里看进度，下完直接出现在你的媒体库里

首次使用建议先去「设置」：

- 如你配置的数据源按其自身条款需要登录，登录你自己有权使用的账号；凭据只保存在本机配置里
- 需要本地片库的片源，可点一次「开始同步」建索引作为兜底（平时优先走站内实时搜索）

<p align="center">
  <img src="docs/shot-settings.png" alt="设置" width="520" />
</p>

## 配置项

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8080` | Web 端口。**compose 里必须显式写 `PORT=9696`**，删掉这行会退回 8080，`http://NAS的IP:9696` 就打不开 |
| `BT_PORT` | `51413` | BT / DHT 监听端口，host 模式下直接占用宿主端口；与其他 BT 软件冲突时改成 51414 |
| `ENABLE_DHT6` | `false` | 设为 `1` 开启 IPv6 DHT（NAS 有 IPv6 时） |
| `PUID` / `PGID` | `1000` | 下载文件的属主，需和媒体目录一致；SSH 执行 `id` 查看 |
| `MEDIA_ROOT` | `/media` | 自动发现存储库的根目录，其下每个一级目录算一个库 |
| `DOWNLOADS_DIR` | `/downloads` | aria2 的兜底下载目录；**必须指向 volumes 里真实挂载的某个库**（compose 里写 `/media/影视`），否则文件会写进容器层、重启丢失 |
| `DOWNLOADS_DIRS` | 空 | 手动指定库列表，如 `影视=/media/影视,影视资源=/media/影视资源`；设置后优先于自动发现。注意与上一行是两个不同变量 |
| `ARIA2_SECRET` | 空 | aria2 RPC 密钥；**必须在 compose 里显式写一行**，否则 Web 与容器内的 aria2 token 对不上，设置页会显示引擎离线 |
| `ACCESS_PASSWORD` | 空 | 访问密码的初始值/兜底；也可在「设置 → 访问账号」（独立导航项）里设置登录账号和密码，面板设置优先、改完立即生效。暴露到公网时务必设置 |
| `TORRENT_META_TIMEOUT` | `70000` | 读取种子内文件列表的最长等待时间（毫秒），冷门资源可调大 |
| `TZ` | `Asia/Shanghai` | 时区 |

存储库白名单：容器只允许写入已挂载的媒体目录及其子目录。要新增可写目录，在 compose 的 `volumes` 里追加一行映射即可，无需改代码；界面上也能随时「新建子文件夹」。

## 目录结构

```
nas-media-downloader/
├─ .github/workflows/          推送后自动构建镜像发布到 ghcr.io
├─ Dockerfile / docker-compose.yml
├─ config/
│  ├─ sites.example.json      片源配置示例（提交）
│  ├─ magnet-sources.example.json  磁力搜索源配置示例
│  ├─ hot-sources.example.json  首页热播推荐设置示例（可选）
│  └─ sites.json / magnet-sources.json  你自己的配置（已 gitignore）
├─ docker/
│  ├─ entrypoint.sh           启动 aria2 与 Web 服务
│  └─ trackers-default.txt    内置 tracker 列表（离线兜底）
├─ server/
│  ├─ index.js                HTTP 路由与接口
│  ├─ settings.js             配置读写与目录白名单
│  ├─ indexer.js              本地片库索引
│  ├─ engine/                 下载引擎适配（aria2 / qBittorrent）
│  ├─ sources/                片源适配层
│  └─ lib/                    聚合与工具函数
└─ public/                    前端页面（原生 JS，无构建步骤）
```

## 常见问题

| 现象 | 处理 |
|---|---|
| 页面打不开 | `docker logs nas-media-downloader` 看是否端口占用；另外确认 compose 里写了 `PORT=9696`（不写会退回 8080） |
| 设置里引擎显示离线 | aria2c 没起来，看容器启动日志；或切到 qBittorrent；也可能是 compose 漏写了 `ARIA2_SECRET` |
| 提示「资源库未接入」 | 出厂就是空壳，**未接入是正常状态，不是故障**。想用就按第 3 节填好 `config/sites.json`；不填也能用首页「粘贴磁力链接」手动下载 |
| 填了片源还是搜不到 | 确认填的是符合本项目接口约定的服务（见第 3 节说明），普通网站首页不会被解析；可在「设置 → 片源接入」看接入状态 |
| 下载一直是 0 速度 | 51413 没放通，或该资源本身没有做种者 |
| 搜不到片 | 换个片名，或在设置里同步一次片库 |
| 想用 qBittorrent 下载 | 「设置 → 常规与下载 → 下载引擎」里把「分流方式」选成「自动分流（推荐）」或「全部走 qBittorrent」，在出现的 qBittorrent 输入框里填地址（如 `http://127.0.0.1:8080`）、用户名、密码，点「保存并测试」；填了账号密码才算接入 |
| 忘记登录密码 / 连错 5 次被锁 | 连错 5 次锁 5 分钟，等一会儿或重启容器即可清空计数（计数只在内存里）。忘记密码：停容器 → 编辑 `config/settings.json`，删掉 `auth` 整段（**别删整个文件**，会连引擎、目录和登录态一起丢）→ 重启；compose 里 `ACCESS_PASSWORD` 为空则免密进入，填了就用那个密码登录 → 到「设置 → 访问账号」重设 |
| 点下载提示无权限 | 目录不在白名单内，先在 compose 里映射该目录 |
| 权限不对、文件改不了 | `PUID/PGID` 与该目录属主不一致，用 `ls -nd 目录` 查 |
| 媒体库里看不到片 | 下拉框选错库了，两个盘都挂上后重新选一次目录 |
| 「选集」一直转圈或提示取不到 | 这个种子暂时没人做种提供元数据，稍后重试，或直接用「下载」整包下 |
| 粘了网盘链接提示不支持 | 网盘资源必须先在网盘官方客户端转存；本项目只下载磁力与种子，不解析、不下载网盘分享 |

## 说明

**本项目是一个不含任何内容的空壳工具。** 仓库与镜像里没有资源站地址、没有可检索的片库数据、没有账号、没有磁力链接、没有网盘资源；项目不托管、不分发任何作品内容，也不内置任何站点或作品链接。程序在出厂状态下不会连接任何第三方内容服务；所有可检索的数据源，都必须由**实际使用人自己准备、自己判断合法性、自己填写**到 `config/` 下的配置文件里。作者不提供、不推荐、不协助寻找任何站点或资源。

软件只在你自己的设备上完成「读取你配置的数据源 → 把下载任务交给本机下载引擎 → 把文件写入你指定的目录」这几件事。配置、凭据、任务记录和下载文件都保存在本机，不会主动向作者或任何未由你配置的服务器发送数据。

## 免责声明

- 本项目按「现状」提供，仅作为通用的本地文件下载与任务管理工具，**不含任何作品内容**，不对任何第三方内容的合法性、准确性、可用性作背书或担保，也不构成对任何站点、服务或资源的推荐。
- 依据《中华人民共和国著作权法》《信息网络传播权保护条例》，通过信息网络向公众提供作品，或将作品置于信息网络中使公众可在个人选定的时间和地点获得，通常需取得权利人许可；依据《中华人民共和国民法典》第一千一百九十五条及《最高人民法院关于审理侵害信息网络传播权民事纠纷案件适用法律若干问题的规定》，教唆、帮助他人实施侵权亦可能承担相应责任。使用者应自行确认其配置的数据源、所下载内容及使用方式已获合法授权，或属于法律允许的合理使用等情形，并自行承担由此产生的判断后果。
- 本项目不提供、也不得被用于规避权利人为保护作品所采取的技术措施（《信息网络传播权保护条例》第十二条）；不得用于以营利为目的的传播、分发或公开提供。使用者还应遵守《中华人民共和国网络安全法》《中华人民共和国数据安全法》《中华人民共和国个人信息保护法》及所在地区其他适用法律法规，并遵守所接入服务自身的用户协议与访问规则。
- **责任归属**：本软件不托管、不存储、不审查、不传输任何第三方内容；作者不是网络服务提供者，不参与使用者的数据源配置与使用决策，也不掌握任何使用者的配置与数据。因自行配置数据源、访问第三方服务、下载或使用内容而产生的民事、行政乃至刑事责任，均由实际使用人自行承担；给他人造成损失的，由实际使用人负责。本声明不排除法律另有规定的强制性责任。
- 权利人如认为某一具体使用行为侵害其合法权益，请直接向该行为的实施者或实际提供内容的服务方主张权利；本项目不含任何内容，也无法定位或处理具体使用行为。
- 如你不同意上述内容，或所在地区不允许部署、使用此类工具，请不要下载、安装或使用本软件。
