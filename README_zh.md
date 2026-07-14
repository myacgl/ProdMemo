# ProdMemo

[English](README.md) | 简体中文

ProdMemo 是一个非官方的 WorldQuant BRAIN Chrome 扩展。它使用 IndexedDB 保存已提交 Alpha 及其 PnL，在浏览器本地计算 Self Correlation 和 Power Pool Correlation，并缓存平台返回的 Production Correlation。

## 功能

### Alpha 详情页 Correlation

- 统一的 **ProdMemo** 卡片显示最近一次本地 Self Corr、本地 PPA Corr 和平台 Prod Corr 结果。
- **Calculate Local Corr** 会先按需同步新提交的 Alpha，再计算本地 Self Corr 和 PPA Corr。
- **Calculate All Corr** 会先刷新平台的 **Prod Correlation**，再执行相同的本地计算。
- 每个 Alpha 的最新计算结果都会保存，再次打开该 Alpha 页面时会自动显示。
- PPA 对比池仅包含相同 Region，并具有 `POWER_POOL:POWER_POOL_ELIGIBLE` classification 的 Alpha。
- Self Corr 对比池会排除 Power Pool Eligible Alpha。

### 已提交 Alpha 和 PnL 同步

- Popup 中的 **Full Submitted Alpha + PnL Sync** 会获取全部已提交 Alpha 及其 PnL。
- Alpha 列表每页最多获取 100 条。
- PnL 使用限制并发、预热请求和最终重试，尽量避免遗漏。
- 同步过程显示进度、成功数和失败数，并可使用同一个按钮停止。
- 每次执行本地 Corr 计算前，会通过增量同步检查新提交的 Alpha。

### Production Correlation 缓存

- 自动拦截平台返回的 Prod Corr 并保存。
- 在未提交 Alpha 列表中，用 **Max Corr** 替换 **Book Size**，显示已保存的 Self、PPA、Prod Corr 中的最高值。
- Popup 支持导入和导出 Prod Corr 数据。

### 本地数据

ProdMemo 使用名为 `ProdMemoDB` 的 IndexedDB 数据库，分别保存：

- 已提交 Alpha 的元数据；
- Alpha PnL 时间序列；
- 最新的本地 Self/PPA Corr 结果；
- 平台 Production Correlation 结果。

Popup 只显示 Prod Corr、已提交 Alpha 和 PnL 的记录数量，不加载或展示完整 Prod Corr 列表。

## 安装

1. 下载或克隆本项目。
2. 在 Chrome 中打开 `chrome://extensions/`。
3. 开启右上角的**开发者模式**。
4. 点击**加载已解压的扩展程序**。
5. 选择 `ProdMemo` 目录。

Alpha 和 PnL 请求使用当前 WQB 登录会话，因此同步时必须打开一个已登录的 `*.worldquantbrain.com` 页面。

## 从 v1 升级

Chrome 扩展的数据按照扩展 ID 隔离。为了保留 v1 的 Prod Corr 缓存，应将新版本文件覆盖到原先加载的目录，然后在 `chrome://extensions/` 中重新加载已有扩展。

如果从另一个目录重新“加载已解压的扩展程序”，Chrome 通常会生成不同的扩展 ID，新扩展无法直接读取旧扩展的数据。

在相同扩展 ID 下首次启动 v2 时，ProdMemo 会把 `chrome.storage.local` 中格式有效的 `prod_memo_{alphaId}` 旧记录复制到新的 IndexedDB Prod Corr 表中，原始记录不会被删除。

如果扩展 ID 已经发生变化，请从旧扩展导出 Prod Corr JSON，再通过新扩展的 Popup 导入。升级或清理浏览器数据前，建议先导出备份。

## 使用方法

### 初始化同步

1. 登录并打开 WorldQuant BRAIN 页面。
2. 打开 ProdMemo Popup。
3. 点击 **Full Submitted Alpha + PnL Sync**。
4. 在 Alpha 和 PnL 两个阶段完成前保持 WQB 页面打开。

当 WQB 扩展历史 PnL 时间范围，例如更新 `endDate` 后，可再次执行全量同步。

### 计算 Correlation

1. 打开一个 Alpha 详情页，等待原生 Correlation 模块出现。
2. 点击 **Calculate Local Corr**，仅计算本地 Self Corr 和 PPA Corr。
3. 点击 **Calculate All Corr**，一次完成平台 Prod Corr 刷新和两项本地计算。

### 导入与导出

Popup 使用兼容旧版本的 JSON 格式导入和导出 Prod Corr：

```json
{
  "alphaId": {
    "timestamp": 1760000000000,
    "result": {
      "max": 0.7012,
      "min": -0.2456
    }
  }
}
```

## 项目结构

| 文件 | 用途 |
| --- | --- |
| `manifest.json` | Manifest V3 扩展配置 |
| `inject.js` | WQB 页面 API 拦截及登录态同步请求 |
| `content.js` | 页面按钮、统一 Corr 卡片和列表增强 |
| `background.js` | IndexedDB、旧数据迁移及消息处理 |
| `corrWorker.js` | 本地 Correlation 计算 |
| `popup.html`、`popup.js` | 同步和数据管理界面 |
| `styles.css` | 页面注入样式 |

## 隐私与安全

- 所有缓存和计算结果都保存在当前浏览器配置中。
- ProdMemo 不使用外部服务器，也不会向第三方发送数据。
- 扩展只在 WorldQuant BRAIN 域名下运行。
- 清除浏览器配置或 IndexedDB 会永久删除未导出的本地数据。

## 浏览器兼容性

- Chrome：支持
- 其他 Chromium 浏览器：预期可用，但未持续测试
- Firefox：不支持

## 开发

修改代码后，在 `chrome://extensions/` 中重新加载 ProdMemo，再刷新 WQB 页面。调试时可在页面控制台搜索 `[ProdMemo]` 日志。

开发与测试清单见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 已知限制

- 同步过程中必须保持已登录的 WQB 页面打开。
- 平台 API 限流或临时返回空 PnL 时，同步耗时可能增加。
- 本地 Corr 是浏览器端复刻；如果 WQB 修改计算规则或底层数据，结果可能存在细微差异。
- 解压加载的扩展数据与 Chrome 扩展 ID 绑定。

## 更新记录

### v2.0.1（2026-07-14）

- 本地 Self Corr 对比池排除 Power Pool Eligible Alpha。
- 旧规则生成的 Self Corr 缓存不再作为最新结果显示。

### v2.0.0（2026-07-10）

- 将 Prod Corr 的正式存储和数据管理迁移至 IndexedDB。
- 安全迁移有效的旧版 Prod Corr 数据，同时保留原始记录。
- 新增已提交 Alpha 的全量与增量同步。
- 新增带并发限制、预热、重试、进度和停止功能的 PnL 同步。
- 新增本地 Self Corr 和同 Region Power Pool Corr 计算。
- 新增合并后的 Self/PPA/Prod 卡片，并自动恢复最近一次结果。
- 新增 **Calculate Local Corr** 和 **Calculate All Corr** 页面操作。

### v1.0.0（2026-01-13）

- 新增 Production Correlation 捕获和详情页显示。
- 新增 Alpha 列表 Max Corr 列。
- 新增 JSON 导出和 Corr 数值颜色提示。

## 许可证

采用 MIT License，详情见 `LICENSE`。

## 免责声明

ProdMemo 与 WorldQuant LLC 无隶属或认可关系，请自行判断并承担使用风险。
