# agy-mini-bar（极简 Token 底栏）

一个轻量、简约、零外部依赖的 **Google Antigravity** 原生插件，固定在聊天输入框正下方，以极简单行实时展示你最关心的核心指标：

```text
⏱ 15轮 255步 · 64.4 tok/s   🗄️ 总计 21.4M · 缓存命中 98%   ◔ 26%   ⚡ 5h 95% · 周 61%   中
```

## ✨ 特性

* **极简位置**：直接贴合在聊天输入框正下方（约 `26px` 高），不占顶栏、不挤侧边栏。
* **零侵入 & 零依赖**：不修改官方 `app.asar`，完全不与客户端汉化包冲突；纯 Node.js 内置模块（`node:sqlite` + `WebSocket`），无需 `npm install`。
* **全部读取真实数据**：
  * **轮步与速度**：当前对话轮/步数 + 最近一次请求端到端速度；悬停浮窗同时展示 **纯吐字速度（`output / streaming`）**、**端到端速度（`output / (ttft + streaming)`）**、TTFT 首字延迟与流式耗时。
  * **累计消耗与缓存**：本会话累计总 Token 消耗与实时缓存命中率；悬停查看输入/缓存/思考/输出明细。
  * **真实上下文占用**：动态读取模型实际下发上限（如 `512K`），超过 `75%` 变黄、`90%` 变红；悬停展示四色进度条与 `首轮 / 读取 / 思考 / 回复` 拆分。
  * **模型剩余额度**：自动匹配当前所选模型对应的额度池（`5h` 与 `每周`），悬停查看全部额度池与精确重置倒计时。
* **纯正中/英双语**：默认简体中文，点击行末 `中 / EN` 一键切换，仅作用于插件自身。
* **中文路径友好**：安装脚本自动识别非 ASCII 路径并配置直启，无黑框弹窗。

---

## 🚀 安装（Windows）

### 1. 克隆仓库
```powershell
git clone https://github.com/longtimecar/agy-mini-bar.git
cd agy-mini-bar
```

### 2. 运行安装脚本
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```
脚本会自动将插件安装到 `%USERPROFILE%\.gemini\config\plugins\agy-mini-bar`。

### 3. 开启调试端口并启用插件
底栏通过本地调试端口挂载到输入框下方，请确保 Antigravity 快捷方式目标末尾带有：
```text
--remote-debugging-port=0
```
随后：
1. **完全退出** Antigravity 并从带参数的快捷方式重新打开。
2. 在 Antigravity 的 **Plugins（插件）** 面板启用 **极简 Token 底栏（`agy-mini-bar`）** 即可。

---

## 🗑️ 卸载
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
```

## 🧪 测试
```powershell
node --test test/metrics_reader.test.mjs
```

## 📄 License
[MIT](./LICENSE)
