# 答辩录 · Rebuttal Reader

一个面向个人学习的 Rebuttal 阅读器：把初始 Review、Author Response、Reviewer Follow-up、Meta-review 和最终决定还原到同一条因果链中。

第一版刻意采用“手动触发更新”：

- 没有后台常驻爬虫；
- Re² / ReviewRebuttal 作为冷启动来源；
- OpenReview 适配器只导入 `readers` 包含 `everyone` 的公开 Note；
- 派生数据和 OpenReview 原始来源分别标注；
- 缺失评分保留为缺失，不猜测。

## 本地运行

需要 Node.js 22.13 或更高版本。

```bash
npm install
npm run dev
```

打开终端显示的本地地址即可。

## 手动更新

刷新内置的 6 个精选 Re² 案例：

```bash
npm run update:data
```

忽略本地缓存、重新下载测试集：

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

- `data/re2.generated.json`：Re² 冷启动案例；
- `data/openreview.generated.json`：OpenReview 手动导入结果；
- `config/venues.json`：不同 venue 的 invitation 名称适配；
- `scripts/update-re2.mjs`：Re² 更新与规范化；
- `scripts/update-openreview.mjs`：OpenReview 公开权限检查与导入。

## 验证

```bash
npm test
```

测试会检查站点构建、页面关键结构、公开权限闸门，以及 Review → Author Response → Reviewer Follow-up 的归一化结果。
