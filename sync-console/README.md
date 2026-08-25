# Shopify Sync Console

本地可视化工具，封装同级 `custom-data-sync` 下的同步脚本，用于在子站点之间同步素材与自定义数据。

> **完整操作教程：** `[操作教程.md](./操作教程.md)`

## 启动

```bash
node sync-console/server.mjs
```

浏览器打开：[http://127.0.0.1:8787](http://127.0.0.1:8787)

可选环境变量：

- `SYNC_CONSOLE_PORT`（默认 `8787`）
- `SYNC_CONSOLE_HOST`（默认 `127.0.0.1`）

## 凭证模型（仅 Admin API Token）

每个店铺只需要：

1. 显示名称
2. 店铺域名（`*.myshopify.com`）
3. Admin API access token（`shpat_` / `shpca_` / `shpua_` 等）

不再在界面填写 Client ID / Client Secret。

### 本地保存位置

- `sync-console/data/stores.json`
- `sync-console/data/selection.json`

已 gitignore，不要提交 token。

### `.env`（可选，用于导入）

```env
SOURCE_STORE=source.myshopify.com
SOURCE_ACCESS_TOKEN=shpat_xxx

TARGET_STORE=target.myshopify.com
TARGET_ACCESS_TOKEN=shpat_xxx
```

统一使用 `*_ACCESS_TOKEN`。旧别名 `SOURCE_TOKEN` / `TARGET_TOKEN` 仍可被导入/CLI 识别，但建议改成 `*_ACCESS_TOKEN`。

界面支持：

1. 新增 / 编辑 / 删除多个店铺（Token 模式）
2. 下拉选择 Source / Target
3. 一键交换源目标
4. 从 `custom-data-sync/.env` 导入店铺

任务运行时会按所选店铺注入 `SOURCE_ACCESS_TOKEN` / `TARGET_ACCESS_TOKEN`。

## 功能

- 勾选同步模块：Metaobject / Metafield / Menu / Page / Blog Article / Collection / Product / Template 图片 / Template 视频
- Page 默认同步 handle=`about-us`（可改），或勾选一次性同步源站全部页面
- Blog Article 默认同步 handle=`test`（可改）；勾选「一次性同步全部」则拉取源站所有文章逐条同步；若目标站缺少同 handle 的 Blog，会先创建 Blog
- Collection 默认同步 handle=`robot-vacuums`（可改）；智能集合同步规则，手动集合按 product handle 映射成员；也可一次性同步全部
- Product 支持一次填多个数字 ID，或勾选一次性同步源站全部产品
- Menu 填写 handle，或勾选一次性同步源站全部菜单
- 选择 Templates：可填写本机 `templates` 目录路径并扫描；也可粘贴额外 JSON 绝对路径（工具不必放在主题包内）
- Dry run / Live
- 实时日志（SSE）
- 任务结束后静默写入 `custom-data-sync/reports/job-*.json`（界面不展示，出问题时可打开文件查看步骤和日志尾部）



## CLI：单独同步页面

```bash
cd custom-data-sync
node sync-page.mjs about-us --dry-run
node sync-page.mjs about-us
node sync-page.mjs --all --dry-run
node sync-page.mjs --all
```

需要源站 `read_content`、目标站 `write_content`（建议目标站也开 `read_content` 以便按 handle 更新）。`--all` 会分页拉取源站全部页面并按序同步，单条失败会继续，最后汇总。

## CLI：单独同步 Blog 文章

```bash
cd custom-data-sync
node sync-article.mjs test --dry-run
node sync-article.mjs test
node sync-article.mjs --all --dry-run
node sync-article.mjs --all
```

同样需要 `read_content` / `write_content`。文章会落到与源站相同 handle 的 Blog 下。`--all` 会分页拉取源站全部文章并按序同步，单篇失败会继续，最后汇总。

## CLI：单独同步 Collection

```bash
cd custom-data-sync
node sync-collection.mjs robot-vacuums --dry-run
node sync-collection.mjs robot-vacuums
node sync-collection.mjs --all --dry-run
node sync-collection.mjs --all
```

需要源站 `read_products`，目标站 `write_products`（建议也开 `read_products`）。手动集合只会加入目标站已存在的同 handle 产品。若要自动发布到 Online Store，目标站还需 `read_publications` + `write_publications`；缺少时会跳过发布并继续完成创建/更新。`--all` 会分页拉取源站全部集合并按序同步，单条失败会继续，最后汇总。

## CLI：Template 图片 / 视频

可指定任意本机主题 `templates` 目录，或直接传 JSON 绝对路径：

```bash
cd custom-data-sync

# 指定目录 + 文件名
node sync-template-files.mjs --dir="E:\MyTheme\templates" product.foo.json --dry-run
node sync-template-videos.mjs --dir="E:\MyTheme\templates" product.foo.json --dry-run

# 直接传绝对路径
node sync-template-files.mjs "E:\MyTheme\templates\product.foo.json" --dry-run
```

也可设置环境变量 `TEMPLATES_DIR`。同步台界面支持填写目录并「扫描目录」。

## 安全

- 默认只监听 `127.0.0.1`
- Token 只存在本地 `data/`，接口只返回是否已配置，不回传明文
- 同一时间只允许一个任务



## 说明

Page / Blog Article / Collection / Menu / Product 均可单个同步，或使用 `--all` 一次同步源站全部。