# 答辩录 · Rebuttal Reader

一个面向个人学习的 Rebuttal 阅读器：把初始 Review、Author Response、Reviewer Follow-up、Meta-review 和最终决定还原到同一条因果链中。

在线版本：<https://rebuttal-reader.tart-morel-3407.chatgpt.site/>

项目刻意采用“手动触发更新”：

- 没有后台常驻爬虫；
- Re² / ReviewRebuttal 作为全量主索引；
- OpenReview 适配器只导入 `readers` 包含 `everyone` 的公开 Note；
- 派生数据和 OpenReview 原始来源分别标注；
- 缺失评分保留为缺失，不猜测。

当前全量模式会合并四类公开目录，并按 Forum ID 去重：

- Re²：覆盖较早年份的 45 个 OpenReview venue；
- OpenReview Raw：从 626,430 条公开 Note 中索引出 35,151 个含作者回复的
  Forum，覆盖 2018–2025；
- ReviewBench：补充 NeurIPS、ICML、TMLR、EMNLP、CoRL 和 COLM 等公开归档；
- ICLR 公共归档：补到 ICLR 2026，并保留每篇在远程 JSON 中的精确字节范围。

当前生成快照去重后包含 62,532 篇论文、286,659 条 Reviewer 线程。

浏览器只加载轻量目录。点开论文时，服务端才从公开数据文件的安全行区间读取
这一篇所需的 Review、Author Response 和决定字段；论文 PDF、OCR 全文和其他
论文的讨论都不会随列表一起下载。直接从 OpenReview API 补充的少量新 Forum
也按“一篇一个详情文件”保存，不会打进前端 JavaScript。

部署包不会保存 896MB 的 OpenReview Raw Parquet、1.36GB 的 ICLR 2026
原始 JSON 或 ReviewBench 的完整数据文件。历史目录还会按年份分片，目前最大
单片小于 9MB；全部目录原始约 57.4MB，gzip 估算约 6.3MB。源站与 CDN
负责正文读取和缓存。本地 `.cache/` 只用于生成 Re²
目录、不会提交或部署，删掉后也能在下次更新时重新生成。

## 本地运行

需要 Node.js 22.13 或更高版本。

```bash
npm install
npm run dev
```

打开终端显示的本地地址即可。

## 手动更新

拉取并生成全部公开目录：

```bash
npm run update:data
```

Re² 第一次会下载约 1GB 的公开原始 JSON 并在之后复用本地缓存；其他适配器
通过远程 Parquet 列读取或顺序字节扫描生成目录，不会把完整数据集保存到项目中。
只刷新 ReviewBench 公开目录：

```bash
npm run update:reviewbench
```

刷新 OpenReview Raw 历史公共目录：

```bash
npm run update:openreview-archive
```

刷新 ICLR 2026 公共讨论目录：

```bash
npm run update:iclr-archive
```

大文件扫描会在每个分块后写入断点；若网络或进程中断，可继续：

```bash
npm run update:iclr-archive -- --resume
```

导入一个公开的 OpenReview Forum：

```bash
npm run update:openreview -- --forum 7QfLW-XZTl
```

按 venue 导入所有公开 Forum：

```bash
npm run update:openreview -- --venue ICLR.cc/2026/Conference
```

扫描 registry 中配置的所有公开 venue：

```bash
npm run update:openreview -- --all
```

OpenReview 的批量接口可能要求已验证会话。更新者可以读取本地
`OPENREVIEW_TOKEN`，或临时读取 `OPENREVIEW_USERNAME` /
`OPENREVIEW_PASSWORD` 登录并取得短期 token。凭据只用于站长手动更新，
网站访客不需要 OpenReview 或 ChatGPT 登录。不要把凭据写入仓库。

## 数据文件

- `public/data/re2/index.json`：完整 Re² 轻量目录与按篇读取范围；
- `public/data/reviewbench/index.json`：多会议轻量目录与远程 Parquet 行指针；
- `public/data/openreview-archive/index.json`：历史公共目录分片清单；
- `public/data/openreview-archive/by-year/`：按年份切分的轻量 Forum 目录；
- `public/data/iclr-archive/index.json`：ICLR 公共讨论与远程 JSON 字节指针；
- `public/data/openreview/index.json`：OpenReview API 增量目录；
- `public/data/openreview/papers/`：按 Forum 分开的增量详情；
- `data/re2.generated.json`：目录元数据与公开索引入口；
- `data/openreview.generated.json`：OpenReview 增量目录元数据，不含正文；
- `config/venues.json`：不同 venue 的 invitation 名称适配；
- `scripts/update-re2.mjs`：Re² 更新与规范化；
- `scripts/update-reviewbench.mjs`：ReviewBench 全量轻量索引；
- `scripts/update-openreview-archive.mjs`：OpenReview Raw 公共 Note 目录；
- `scripts/update-iclr-archive.mjs`：ICLR 远程 JSON 字节索引；
- `scripts/update-openreview.mjs`：OpenReview 公开权限检查与导入。

## 验证

```bash
npm test
```

测试会检查站点构建、页面关键结构、公开权限闸门，以及 Review → Author Response → Reviewer Follow-up 的归一化结果。

## 备份与独立迁移

GitHub 仓库保存完整源码、轻量目录、数据更新脚本和构建配置，是站点的可恢复
副本。`.cache/`、依赖目录、构建产物、环境变量和凭据均不会提交。

从一台新机器恢复：

```bash
git clone https://github.com/Functionhx/rebuttal-reader.git
cd rebuttal-reader
npm ci
npm test
```

当前生产构建输出为 Cloudflare Worker 兼容的 vinext 应用，且不依赖 D1 或 R2。
如果现有托管地址不可用，可以在自己的 Cloudflare 账户中新建 Worker 项目，
连接本仓库并使用 `npm run build` 作为构建命令，再绑定自己的域名。

GitHub Pages 只能托管静态文件，不适合直接运行本项目：论文详情依赖
`/api/re2`、`/api/reviewbench`、`/api/openreview-archive` 和
`/api/iclr-archive` 四个按篇读取接口。仓库可以作为源码备份，但要得到完整的
备用网址，仍需部署到支持服务端函数或 Edge Worker 的平台。
