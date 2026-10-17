# WeRead Auto Reader (微信读书网页版全自动循环助手)

[![Version](https://img.shields.io/badge/version-v1.9.0-blue.svg)](https://github.com/MandyWednesday/weread-auto-reader)
[![Platform](https://img.shields.io/badge/platform-Tampermonkey-green.svg)](https://www.tampermonkey.net/)
[![License](https://img.shields.io/badge/license-MIT-orange.svg)](LICENSE)
[![Pair-Programmed With](https://img.shields.io/badge/pair--programmed%20with-Google%20Antigravity-8e7cc3.svg)](https://deepmind.google)

专为微信读书（WeRead）网页版设计的高可靠自动化阅读与时长统计 UserScript。旨在解决长时间挂机场景下由于 SPA 预加载 DOM 造成的误判、浏览器后台节流导致的计时漂移、以及大部头书籍读完后无法自动重置循环的核心痛点。

---

## 🛠️ 技术背景与核心挑战 (Engineering Challenges)

在微信读书网页端（Vue SPA 架构）实现长期无人值守的自动化阅读，面临以下三个底层机制挑战：

### 1. SPA 预渲染机制与“伪末页”误判 (Virtual DOM Traps)
* **机制分析**：微信读书在阅读器页面初始化时，便将横屏封底组件（`.horizontal_reader_back_cover_wrapper`）挂载于 DOM 树中，内部包含静态文本“读完了”或“全书完”。官方通过 Vue 的 `v-show` 指令在父容器上注入 `display: none`。
* **传统缺陷**：市面脚本若仅通过 `document.querySelector` 查找文本或类名，会在第一页即命中该隐藏节点，导致单页翻页后立即误判全书完结。
* **解决方案**：引入多层物理几何校验：
  - 检查元素渲染链上下文（`offsetParent !== null`）；
  - 严格计算屏幕绝对视口几何矩形（`getBoundingClientRect()` 尺寸 $\ge 50\text{px}$ 且坐标位于可视窗口 $[0, \text{innerHeight}]$ 范围内）；
  - 辅以轮次翻页安全阈值屏障与 2.5 秒延时二次物理状态复核。

### 2. Chromium 标签页后台节流与物理时钟对齐 (Timer Throttling & Clock Drift)
* **机制分析**：基于 Chromium 的现代浏览器（Edge、Chrome）实施了激进的 *Page Lifecycle API*。当标签页处于非活动状态或被遮挡时，`setInterval` / `setTimeout` 调度精度会被强制降频至 1 分钟甚至数分钟一次，造成累计时长严重缩水。
* **解决方案**：
  - **Web Audio 活跃通道保活**：在页面初始化时创建一个微量静音的 `AudioContext` 振荡器（Oscillator），使浏览器内核将该页面标记为活跃多媒体播放上下文，从而完全豁免后台定时器降频限制；
  - **绝对物理时间戳差值核算**：废除传统的简单累加器，改用物理时钟 `Date.now() - lastTickTimestamp` 差值计算，确保哪怕遭遇系统短暂休眠，恢复后的时长与实际物理流逝时间分秒对齐。

### 3. 全书完自动循环重置路由 (Infinite Loop Routing)
* **机制分析**：传统脚本读完最后一章后停滞在末页卡片，无法实现 7×24 小时无人值守。
* **解决方案**：通过提取当前书籍的唯一 Hash 标识，在确凿捕获全书完结信号后，先模拟官方目录原生路由组件跳转；若 SPA 状态未及时变动，则降级为底层 URL 替换策略（`location.replace`），自动跳回第 1 章正文并重置状态机，实现无限循环。

---

## 📐 运行架构图 (Architecture)

```text
               [ 初始化 / 加载书籍 ]
                        │
                        ▼
            [ Web Audio 静音保活通道激活 ]
                        │
                        ▼
           [ 物理时钟调度引擎 (25s - 45s) ]
                        │
                        ▼
             [ 派发单页键盘事件 ArrowRight ]
                        │
                        ▼
            [ 延迟 1.5s 触发物理视口检测 ]
                        │
       ┌────────────────┴────────────────┐
       ▼                                 ▼
[ 未读完 / 正常正文 ]             [ 捕获完结卡片信号 ]
       │                                 │
       │                                 ▼
       │                    [ 2.5s 物理几何二次复核 ]
       │                                 │
       │                  ┌──────────────┴──────────────┐
       │                  ▼                             ▼
       │             [ 复核未通过 ]               [ 确认到达全书终点 ]
       │                  │                             │
       │                  │                             ▼
       │                  │                 [ 执行目录原生/底层直跳 ]
       │                  │                             │
       │                  │                             ▼
       └──────────────────┴───────────────► [ 重置计数，进入下一轮循环 ]
```

---

## 🖥️ 单显示器环境运行策略

针对没有外接副屏的单显示器用户，推荐以下两种策略保持后台稳定运行：

1. **独立窗口 + 底层遮挡（推荐）**
   * 将微信读书标签页拉出为独立小窗口。
   * **请勿点击操作系统的“最小化”按钮（`-`）**。直接前台覆盖运行办公软件、游戏或视频软件即可。只要窗口未被显式最小化，Chromium 的渲染管线与 Web Audio 通道将保持全速工作。
2. **Windows 虚拟桌面隔离**
   * 使用快捷键 `Win` + `Tab` 新建“桌面 2”，将微信读书置于该桌面全屏运行。
   * 切换回“桌面 1”正常工作，两者互不干扰且无降频风险。

---

## 📦 安装与配置

1. **前置条件**：安装脚本管理器扩展（如 [Tampermonkey](https://www.tampermonkey.net/) 或 Violentmonkey）；
2. **导入脚本**：
   * 在脚本管理器中新建脚本；
   * 复制本仓库中的 [`weread_auto_reader.user.js`](weread_auto_reader.user.js) 源码并保存（`Ctrl + S`）；
3. **开始使用**：
   * 打开 [微信读书网页版](https://weread.qq.com/) 进入任意书籍阅读页；
   * 右下角将自动弹出悬浮控制面板，实时展示翻页倒计时、物理累计时长、总翻页数及当前循环轮次。

---

## 🤝 致谢与开发说明 (Credits & Attribution)

* **开发者**：[@MandyWednesday](https://github.com/MandyWednesday)
* **辅助开发与结对编程**：本项目在架构设计、DOM 逆向工程分析、Chromium 节流机制规避方案及核心代码实现上，深度采用 **Google DeepMind Antigravity** 进行结对编程（Pair-Programming）与联合调试。

---

## 📄 开源许可证

本项目遵循 [MIT License](LICENSE) 许可协议。
