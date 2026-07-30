# 答辩录 · Rebuttal Reader

一个面向个人学习的 Rebuttal 阅读器：把初始 Review、Author Response、Reviewer Follow-up、Meta-review 和最终决定还原到同一条因果链中。

项目刻意采用“手动触发更新”：

- 没有后台常驻爬虫；
- Re² / ReviewRebuttal 作为全量主索引；
- OpenReview 适配器只导入 `readers` 包含 `everyone` 的公开 Note；
- 派生数据和 OpenReview 原始来源分别标注；
- 缺失评分保留为缺失，不猜测。

当前全量模式会索引 Re² 发布的所有 rebuttal 对话。浏览器先加载轻量目录，
点开论文时再按原始 JSON 的安全字节区间读取该篇内容，因此不会一次下载近
1GB 的正文。论文标题、作者和摘要在点开时从公开的初投稿 Markdown 包按需解析；
如果源记录缺失，页面会明确显示 Reviewer 主题标题或 OpenReview ID。

## 本地运行

需要 Node.js 22.13 或更高版本。

```bash
npm install
npm run dev
```

打开终端显示的本地地址即可。

## 手动更新

拉取并生成完整 Re² 索引：

```bash
npm run update:data
```

第一次会下载约 1GB 的公开原始 JSON 和论文包目录，之后默认复用本地缓存。
忽略缓存、重新下载全量数据：

```bash
npm run update:data -- --refresh
```

导入一个公开的 OpenReview Forum：

```bash
npm run update:openreview -- --forum 7QfLW-XZTl
```

按 venue 小批量导入：

```bash
npm run update:openreview -- --venue ICLR.cc/2023/Conference --limit 50
```

OpenReview 偶尔会要求挑战验证。完成 OpenReview 网站验证后重试；如果你有合法的 API token，也可以通过本地 `OPENREVIEW_TOKEN` 环境变量提供。不要把 token 写入仓库。

## 数据文件

- `public/data/re2/index.json`：完整 Re² 轻量目录与按篇读取范围；
- `data/re2.generated.json`：目录元数据与公开索引入口；
- `data/openreview.generated.json`：OpenReview 手动导入结果；
- `config/venues.json`：不同 venue 的 invitation 名称适配；
- `scripts/update-re2.mjs`：Re² 更新与规范化；
- `scripts/update-openreview.mjs`：OpenReview 公开权限检查与导入。

## 验证

```bash
npm test
```

测试会检查站点构建、页面关键结构、公开权限闸门，以及 Review → Author Response → Reviewer Follow-up 的归一化结果。
