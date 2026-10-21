# WeRead Auto Reader (微信读书网页版自动翻页助手)

[![Version](https://img.shields.io/badge/version-v1.10.1-blue.svg)](https://github.com/MandyRalyeh/weread-auto-reader)
[![Platform](https://img.shields.io/badge/platform-Tampermonkey-green.svg)](https://www.tampermonkey.net/)
[![Greasy Fork](https://img.shields.io/badge/Greasy%20Fork-安装脚本-red.svg)](https://greasyfork.org/zh-CN/scripts/600765-%E5%BE%AE%E4%BF%A1%E8%AF%BB%E4%B9%A6%E7%BD%91%E9%A1%B5%E7%89%88-%E5%90%8E%E5%8F%B0%E6%97%A0%E6%84%9F%E8%87%AA%E5%8A%A8%E7%BF%BB%E9%A1%B5%E5%88%B7%E6%97%B6%E9%95%BF)
[![License](https://img.shields.io/badge/license-MIT-orange.svg)](LICENSE)
[![Changelog](https://img.shields.io/badge/changelog-CHANGELOG.md-lightgrey.svg)](CHANGELOG.md)

这是我使用 Antigravity 辅助开发的一个微信读书网页版（[weread.qq.com](https://weread.qq.com/)）自动翻页油猴脚本，主要用于自动化挂机阅读与时长累计。详细演进历史请查阅 [CHANGELOG.md](CHANGELOG.md)。

---

## 功能特性

- **全书读完后自动循环**：整本书阅读完毕后，自动识别末页并返回第一章重新开始，无需手动重置（无论是长篇挂机读完，还是手动翻到尾页即时测试，均可秒级识别并回跳）。
- **物理时钟对齐**：使用绝对时间戳（`Date.now()`）差值核算时长，避免浏览器后台运行时的定时器漂移。
- **后台防休眠**：通过微弱静音 Web Audio 保持标签页活跃状态，规避浏览器对后台标签页的定时器节流（Timer Throttling）。
- **视口物理几何核验**：基于屏幕坐标和元素物理渲染尺寸检测完结状态，避免前端预加载隐藏 DOM 造成误判。
- **自动容错与保活**：遇到网络异常自动尝试重试；每隔 90 分钟自动刷新页面释放内存，防止长时间挂机导致页面假死。
- **控制面板**：页面右下角显示轻量悬浮面板，展示翻页倒计时、当前轮次页数、累计总时长和循环次数。

---

## 技术难点与实现原理

在实现长时间自动化阅读的过程中，主要解决过以下几个技术细节：

### 1. 为什么不能通过“正文文本是否变化”来判断是否读完？
- **问题**：如果简单检测翻页前后页面文字是否一致，在遇到长篇书籍的前言、总目录、版权页或全屏地图插图时，连续翻页文字可能无变化或极少，容易被误判为已经翻到全书尽头。
- **实现**：放弃正文文本比对，转为针对微信读书底层末页容器节点进行定向检测。

### 2. 为什么刚翻一两页容易被误判为“全书完”？
- **问题**：微信读书前端会将包含“读完了”文案的封底卡片预先渲染在 DOM 树中（平时通过父容器的 `display: none` 隐藏）。如果仅在 DOM 中查找关键字或类名，会在正常阅读页面直接命中该隐藏元素，导致刚翻页就跳回开头。
- **实现**：建立多重视口物理几何核验机制（无需死板依赖页数缓冲，即刻测试也能秒级识别）：
  1. **物理挂载检查**：核验 `offsetParent !== null`，严格排除处于 `display: none` 或祖先隐藏容器中的节点；
  2. **物理渲染尺寸**：通过 `getBoundingClientRect()` 核验元素的实际渲染尺寸（宽高均大于 50px），排除未排版或尺寸为 0 的幽灵元素；
  3. **屏幕可视视口核验**：核验元素屏幕绝对坐标必须完整落在浏览器当前视口之内（`0 <= top/bottom <= innerHeight`, `0 <= left/right <= innerWidth`），排除屏幕外预加载负坐标卡片；
  4. **组件显隐样式过滤**：检查横屏封底组件 `.horizontal_reader_back_cover_wrapper` 的实时计算样式，确认未被 Vue `v-show` 隐藏；
  5. **状态二次物理复核**：首次检测到信号后延迟 2.5 秒再次复验，确认用户确实停留在末页且非快速划过，才正式执行首章跳转。

### 3. 为什么切换到后台后挂机时间会变慢？
- **问题**：Chromium 内核对非活动标签页有严格的降频限制，常规的 `setInterval` 会被延长至每分钟甚至更久才触发一次。
- **实现**：
  1. 使用绝对时间戳差值计算流逝时间，无论定时器何时唤醒，均能准确还原真实物理时间；
  2. 初始化一个静音的 `AudioContext` 振荡器，使浏览器将该标签页判定为活跃的媒体播放状态，从而免于后台降频。

### 4. 读完全书后如何可靠地重回第一章？
- **实现**：采用多重兜底跳转策略（全书库通用）：
  1. **优先原生目录跳转**：模拟点击阅读器目录按钮（☰），定位顶部书封或第一章节点触发微信读书前端的原生路由跳转；
  2. **动态起点记忆直跳**：在开局阅读时自动记忆当前书籍的起点 URL 与首章 Hash 并持久化存储，完结后优先直跳；
  3. **底层基础路由兜底**：若目录未展开且无缓存，直接重定向至书籍基础路由 `https://weread.qq.com/web/reader/${bookId}`，由微信读书前端底层路由自动重置回第一章正文，彻底杜绝跨书拼接导致的无效 URL 报错。

---

## 单显示器使用建议

如果你的电脑没有外接副屏，推荐使用以下方式挂机，避免窗口直接最小化被系统冻结：

- **方式一：小窗口置于底层（推荐）**  
  将微信读书单独拉出一个独立浏览器窗口（大小随意），**不要点击最小化按钮**，直接在前台打开其他工作软件或游戏，让微信读书窗口被自然遮挡在最底下即可。
- **方式二：Windows 虚拟桌面**  
  按快捷键 `Win + Tab` 新建一个虚拟桌面，将微信读书放在新桌面全屏运行，然后切回主桌面继续正常工作，互不干扰。

---

## 安装与使用

### 方式一：Greasy Fork 一键安装（推荐）
如果你已经安装了 Tampermonkey，可以直接前往官方脚本页一键安装：
👉 **[Greasy Fork 脚本安装页面](https://greasyfork.org/zh-CN/scripts/600765-%E5%BE%AE%E4%BF%A1%E8%AF%BB%E4%B9%A6%E7%BD%91%E9%A1%B5%E7%89%88-%E5%90%8E%E5%8F%B0%E6%97%A0%E6%84%9F%E8%87%AA%E5%8A%A8%E7%BF%BB%E9%A1%B5%E5%88%B7%E6%97%B6%E9%95%BF)**（点击绿色的“安装此脚本”即可）。

### 方式二：手动导入
1. 在浏览器中安装脚本管理器扩展（如 [Tampermonkey](https://www.tampermonkey.net/)）；
2. 打开油猴扩展管理面板，点击“添加新脚本”；
3. 将本项目中的 [`weread_auto_reader.user.js`](weread_auto_reader.user.js) 源码完整复制并保存；
4. 登录 [微信读书网页版](https://weread.qq.com/) 并进入任意书籍阅读界面，脚本即会自动启动。

---

## 说明与协议

- 本项目由我（Mandy）使用 Antigravity 辅助结对开发并维护。
- 遵循 [MIT License](LICENSE) 开源协议，欢迎自由使用与交流。
