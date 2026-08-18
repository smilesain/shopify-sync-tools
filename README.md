# shopify-sync-tools

Shopify 子站点素材 / 自定义数据同步工具（可视化同步台 + CLI）。

## 目录结构

```text
shopify-sync-tools/
  sync-console/        # 可视化同步台（本地 Web UI）
  custom-data-sync/    # 底层同步脚本（Admin GraphQL）
  README.md
  .gitignore
```

## 快速开始

### 1. 环境

- 安装 [Node.js](https://nodejs.org/)（建议 18+）
- Clone 本仓库

### 2. 配置凭证（任选其一）

**方式 A：同步台界面添加店铺**（推荐）

启动后在页面「店铺配置」里填写：

- 显示名称
- 店铺域名（`*.myshopify.com`）
- Admin API access token（`shpat_…`）

**方式 B：**`.env` **导入**

```bash
cp custom-data-sync/.env.example custom-data-sync/.env
```

编辑 `custom-data-sync/.env` 填入 Source / Target Token，然后在同步台点击「从 .env 导入」。

> Token 只保存在本机，已被 `.gitignore` 忽略，**不要提交到 Git**。



### 3. 启动同步台

在仓库根目录执行：

```bash
node sync-console/server.mjs
```

浏览器打开：[http://127.0.0.1:8787](http://127.0.0.1:8787)

### 4. 使用建议

1. 确认 Source / Target 没有选反
2. 先勾选 **Dry run** 预览
3. 日志正常后再取消 Dry run 执行 Live

完整操作说明：

- [sync-console/操作教程.md](./sync-console/操作教程.md)
- [sync-console/README.md](./sync-console/README.md)



## 功能概览


| 模块                         | 说明                         |
| -------------------------- | -------------------------- |
| Metaobject / Metafield     | 同步定义（schema）               |
| Menu / Page / Blog Article | 按 handle；文章支持一次性同步全部       |
| Collection                 | 按 handle；智能规则 / 手动成员映射     |
| Product                    | 支持多个数字 ID                  |
| Template 图片 / 视频           | 填写本机主题 `templates` 目录后扫描同步 |


Template 媒体同步**不必**把本工具放进主题包内，在界面填写本机 `templates` 绝对路径即可。

## CLI（可选）

```bash
cd custom-data-sync

node sync-page.mjs about-us --dry-run
node sync-article.mjs --all --dry-run
node sync-collection.mjs robot-vacuums --dry-run
node sync-template-files.mjs --dir="E:\MyTheme\templates" product.foo.json --dry-run
```



## 安全

- 默认只监听 `127.0.0.1`
- `.env`、`sync-console/data/*.json` 不进 Git
- 每人在自己电脑启动一份

