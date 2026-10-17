// ==UserScript==
// @name         微信读书网页版 - 后台无感自动翻页刷时长
// @namespace    https://weread.qq.com/
// @version      1.10.0
// @description  专为副屏挂机刷阅读时长设计：全网书籍通用循环、严格物理几何视口核验杜绝预加载误判、双重延时物理复核、首章动态记忆与原生目录重定向、物理时钟对齐绝不缩水、静音音频防后台节流、精准单页翻页、跨刷新累计总时长、自动监控重试“加载失败”、定时整页刷新防卡死。
// @author       Mandy
// @license      MIT
// @match        https://weread.qq.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    const SCRIPT_VERSION = 'v1.10.0';
    console.log(`[微信读书助手 ${SCRIPT_VERSION}] 全书库通用适配+视口物理几何核验版已加载！当前页面:`, location.href);

    // ================= 配置参数 =================
    const CONFIG = {
        minDelay: 25,              // 每次翻页最小间隔（秒）
        maxDelay: 45,              // 每次翻页最大间隔（秒）
        autoStart: true,           // 进入阅读器是否自动开始
        autoReloadMinutes: 90      // 定时自动刷新页面周期（分钟），防假死与内存泄漏
    };

    // ================= 持久化存储管理 (localStorage) =================
    const STORAGE_KEYS = {
        TOTAL_SECONDS: 'weread_auto_total_seconds',
        TOTAL_PAGES: 'weread_auto_total_pages',
        LOOP_COUNT: 'weread_auto_loop_count',
        LAST_RELOAD: 'weread_auto_last_reload',
        IS_RUNNING: 'weread_auto_is_running',
        CLEANED_V190: 'weread_auto_cleaned_v190'
    };

    function getStorageInt(key, def = 0) {
        const val = localStorage.getItem(key);
        return val ? parseInt(val, 10) : def;
    }

    let totalSeconds = getStorageInt(STORAGE_KEYS.TOTAL_SECONDS, 0);
    let totalPages = getStorageInt(STORAGE_KEYS.TOTAL_PAGES, 0);
    let loopCount = getStorageInt(STORAGE_KEYS.LOOP_COUNT, 1);
    let lastReloadTime = getStorageInt(STORAGE_KEYS.LAST_RELOAD, Date.now());

    // 升级 v1.9.0 时自动重置此前误触发虚增的轮次数（校准回第 1 轮，累计总时长与总页数完好保留）
    if (!localStorage.getItem(STORAGE_KEYS.CLEANED_V190)) {
        loopCount = 1;
        localStorage.setItem(STORAGE_KEYS.LOOP_COUNT, '1');
        localStorage.setItem(STORAGE_KEYS.CLEANED_V190, 'true');
        console.log('[微信读书助手] 🛠️ v1.9.0 升级：已自动将虚增的轮次校准回第 1 轮！');
    }

    // 状态变量
    let isRunning = false;
    let mainLoopTimer = null;
    let targetTurnTimestamp = 0;   // 下次翻页的绝对物理时间戳
    let lastTickTimestamp = 0;     // 上次计时的绝对物理时间戳
    let isFlipping = false;        // 严格防抖锁：确保每次绝对只翻 1 页
    let isLoopingBack = false;     // 跳转回首章中状态
    let isVerifyingEnd = false;    // 末页双重复核确认中状态
    let pagesInCurrentLoop = 0;    // 本轮已翻页数（安全屏障，防止开局误判）
    let uiContainer = null;

    // 格式化时间为：X小时 Y分 Z秒
    function formatDuration(sec) {
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        if (h > 0) return `${h}小时 ${m}分 ${s}秒`;
        if (m > 0) return `${m}分 ${s}秒`;
        return `${s}秒`;
    }

    // 解析当前阅读器 URL 中的书籍 ID 与章节哈希（通用适配所有图书）
    function parseReaderUrl(url = location.href) {
        const m = url.match(/\/web\/reader\/(.+?)(k[a-zA-Z0-9]+)$/);
        if (m) {
            return { bookId: m[1], chapterHash: m[2] };
        }
        const m2 = url.match(/\/web\/reader\/([a-zA-Z0-9_]+)/);
        if (m2) {
            return { bookId: m2[1], chapterHash: '' };
        }
        return { bookId: '', chapterHash: '' };
    }

    // 自动记录当前书籍的起点与首章地址（用于全书完后无缝直跳）
    function cacheCurrentChapterIfEarly() {
        const { bookId, chapterHash } = parseReaderUrl();
        if (!bookId) return;

        // 若处于单轮开局前 5 页且非末页，将当前 URL 与章节记录为起点
        if (pagesInCurrentLoop <= 5 && !isEndOfBook()) {
            const startUrlKey = 'weread_start_url_' + bookId;
            if (!localStorage.getItem(startUrlKey)) {
                localStorage.setItem(startUrlKey, location.href);
            }
            if (chapterHash) {
                const cacheKey = 'weread_first_chapter_' + bookId;
                if (!localStorage.getItem(cacheKey)) {
                    localStorage.setItem(cacheKey, chapterHash);
                    console.log('[微信读书助手] 🔖 已记住本书首章哈希:', chapterHash);
                }
            }
        }
    }

    // ================= 辅助函数：全事件模拟点击 =================
    function triggerClick(el) {
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const clientX = rect.left + rect.width / 2;
        const clientY = rect.top + rect.height / 2;

        const eventTypes = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
        eventTypes.forEach(evt => {
            el.dispatchEvent(new MouseEvent(evt, {
                bubbles: true,
                cancelable: true,
                view: window,
                clientX: clientX,
                clientY: clientY
            }));
        });

        if (typeof el.click === 'function') {
            try { el.click(); } catch (e) {}
        }
    }

    // ================= 0. Web Audio 静音防节流黑科技 =================
    let audioCtx = null;
    function activateAntiThrottlingAudio() {
        if (audioCtx) return;
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) return;
            audioCtx = new AudioContext();
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            gain.gain.value = 0.000001;
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start();
            console.log('[微信读书助手] 🛡️ Web Audio 活跃保活已开启，浏览器后台降频限制已豁免！');
        } catch (e) {
            console.warn('[微信读书助手] Web Audio 激活失败(不影响主功能):', e);
        }
    }

    // ================= 1. 终点检测（严格物理几何视口核验，杜绝隐藏预加载 DOM 误判） =================

    // 判断当前页面是否处于“真实的、屏幕上可见的全书完结页”
    function isEndOfBook() {
        // 寻找读完结语卡片（在微信读书中，封底位于 .readerFooter_ending 或 .horizontal_reader_back_cover_wrapper 内）
        const endingCards = document.querySelectorAll('.readerFooter_ending, .horizontal_reader_back_cover_wrapper .readerFooter_ending, .horizontal_reader_back_cover, .readerFooter');
        for (const ending of endingCards) {
            // 防线 1：必须有真实的 offsetParent（排除处于 display:none 或祖先隐藏容器中的元素）
            if (ending.offsetParent === null) continue;

            // 防线 2：物理渲染尺寸检查（排除未排版或尺寸为 0 的幽灵元素）
            const rect = ending.getBoundingClientRect();
            if (rect.width < 50 || rect.height < 50) continue;

            // 防线 3：屏幕视口几何检查（必须完全落入屏幕当前可视窗口，排除屏幕外负坐标或超视口元素）
            if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
            if (rect.right < 0 || rect.left > window.innerWidth) continue;

            // 防线 4：横屏封底组件显隐检查（必须没有被 v-show 隐藏）
            const wrapper = ending.closest('.horizontal_reader_back_cover_wrapper');
            if (wrapper) {
                const wrapperStyle = window.getComputedStyle(wrapper);
                if (wrapperStyle.display === 'none' || wrapperStyle.visibility === 'hidden' || wrapperStyle.opacity === '0') {
                    continue;
                }
                const wrapperRect = wrapper.getBoundingClientRect();
                if (wrapperRect.width < 100 || wrapperRect.height < 100) continue;
            }

            // 防线 5：文案严格核验，必须为明确的全书完结标题，且严格剔除“未读完”
            const titleEl = ending.querySelector('.readerFooter_ending_title');
            const text = (titleEl ? titleEl.innerText : ending.innerText || '').replace(/\s+/g, '');
            if (text.includes('未读完全书') || text.includes('未读完')) {
                continue;
            }
            if (text.includes('全书完') || text.includes('已读完全书') || text.includes('已读完') || text.includes('读完了') || text.includes('本书已读完') || text.includes('读完全书')) {
                console.log('[微信读书助手] 🎯 捕获真实屏幕可见的完结卡片:', text, rect);
                return true;
            }
        }

        return false;
    }

    // 精准定位右侧悬浮栏中的 ☰ 目录按钮
    function getCatalogButton() {
        let btn = document.querySelector('button.readerControls_item.catalog, .readerControls_item.catalog, button.catalog, [class*="readerControls"] .catalog');
        if (btn) return btn;

        const controls = document.querySelector('.readerControls, [class*="readerControls"]');
        if (controls) {
            const btns = controls.querySelectorAll('button, .readerControls_item');
            for (const b of btns) {
                if (b.className.includes('translate')) continue;
                if (b.className.includes('catalog') || (b.getAttribute('title') || '').includes('目录')) {
                    return b;
                }
            }
            if (btns.length >= 2 && btns[0].className.includes('translate')) {
                return btns[1];
            }
        }
        return null;
    }

    // 在目录抽屉里定位第一项条目并点击
    function clickFirstChapter(callback) {
        const bookInfo = document.querySelector('.readerCatalog_bookInfo, .readerCatalog_bookInfo_cover, .readerCatalog_bookInfo_right');
        if (bookInfo) {
            console.log('[微信读书助手] 🎯 锁定目录顶部书封组件，触发首章原生跳转...');
            triggerClick(bookInfo);
            if (callback) callback(true);
            return;
        }

        const firstItem = document.querySelector('.readerCatalog_list .readerCatalog_list_item, .readerCatalog_list li');
        if (firstItem) {
            console.log('[微信读书助手] 🎯 锁定目录列表第一项，触发跳转...');
            triggerClick(firstItem);
            if (callback) callback(true);
            return;
        }

        if (callback) callback(false);
    }

    // 核心跳转函数：结合 DOM 模拟与底层路由直跳，确保 100% 成功回到第一章（全书库通用）
    function triggerLoopToBeginning() {
        if (isLoopingBack) return;
        isLoopingBack = true;

        updateNotice('🎉 确认全书已读完！正在自动返回第一章重新循环...');
        console.log('[微信读书助手] 启动全书重置流程...');

        const { bookId } = parseReaderUrl();
        const cachedHash = (bookId && localStorage.getItem('weread_first_chapter_' + bookId)) || '';
        const cachedStartUrl = (bookId && localStorage.getItem('weread_start_url_' + bookId)) || '';

        // 最终兜底 URL：优先使用记录的起点 URL，次优拼接首章哈希，最后回退基础阅读路由（通用适配任意书籍）
        const targetUrl = cachedStartUrl || (bookId ? (cachedHash ? `https://weread.qq.com/web/reader/${bookId}${cachedHash}` : `https://weread.qq.com/web/reader/${bookId}`) : location.href);

        // 尝试通过目录原生跳转
        const catalogBtn = getCatalogButton();
        if (catalogBtn) {
            triggerClick(catalogBtn);
            setTimeout(() => {
                clickFirstChapter((success) => {
                    if (success) {
                        setTimeout(() => {
                            const closeBtn = getCatalogButton();
                            if (closeBtn) triggerClick(closeBtn);
                        }, 600);
                    }
                });
            }, 600);
        }

        // 3 秒后若仍处于末页，直接使用底层章节路由 URL 替换跳转
        setTimeout(() => {
            loopCount++;
            pagesInCurrentLoop = 0;
            localStorage.setItem(STORAGE_KEYS.LOOP_COUNT, loopCount);

            if (isEndOfBook()) {
                console.log('[微信读书助手] 🚀 执行底层路由无感重定向至首章:', targetUrl);
                location.replace(targetUrl);
            } else {
                console.log('[微信读书助手] 🎯 验证成功！已回到第一章正文，进入新一轮阅读。');
                finishLoop();
            }
        }, 3000);
    }

    function finishLoop() {
        isLoopingBack = false;
        isVerifyingEnd = false;
        updateUI();
        updateNotice('');
        scheduleNext();
        console.log(`[微信读书助手] 循环重启成功！进入第 ${loopCount} 轮自动阅读。`);
    }

    // 终点检测与双重确认（翻页动作完成后延迟 1.5 秒执行）
    function checkEndOfBook() {
        if (isLoopingBack || !isRunning || isVerifyingEnd) return;

        // 首次物理几何视口核验
        if (isEndOfBook()) {
            console.log('[微信读书助手] ⏳ 首次检测到末页信号，正在进行 2.5 秒二次物理复核...');
            isVerifyingEnd = true;
            updateNotice('⏳ 检测到末页信号，正在二次复核...');

            setTimeout(() => {
                isVerifyingEnd = false;
                // 二次复核：必须仍然处于全书完结状态，才正式触发跳转
                if (isEndOfBook() && isRunning && !isLoopingBack) {
                    console.log('[微信读书助手] 🎯 二次复核确认到达全书终点！启动回到首章流程！');
                    triggerLoopToBeginning();
                } else {
                    console.log('[微信读书助手] 🛡️ 复核未通过或页面已切走，取消跳转，继续正常阅读。');
                    updateNotice('');
                }
            }, 2500);
        }
    }

    // ================= 2. 精准单页翻页 =================
    function doSinglePageTurn() {
        if (isFlipping || isLoopingBack || isVerifyingEnd) return;
        isFlipping = true;

        console.log('[微信读书助手] 触发精准单页翻页...');

        const eventOptions = {
            key: 'ArrowRight',
            code: 'ArrowRight',
            keyCode: 39,
            which: 39,
            bubbles: true,
            cancelable: true
        };

        const keydownEvent = new KeyboardEvent('keydown', eventOptions);
        document.dispatchEvent(keydownEvent);

        setTimeout(() => {
            const keyupEvent = new KeyboardEvent('keyup', eventOptions);
            document.dispatchEvent(keyupEvent);
        }, 60);

        // 模拟页面轻微 DOM 微动防挂机
        const dummyMove = new MouseEvent('mousemove', {
            bubbles: true,
            cancelable: true,
            clientX: Math.floor(window.innerWidth / 2 + (Math.random() * 20 - 10)),
            clientY: Math.floor(window.innerHeight / 2 + (Math.random() * 20 - 10))
        });
        document.dispatchEvent(dummyMove);

        totalPages++;
        pagesInCurrentLoop++;
        localStorage.setItem(STORAGE_KEYS.TOTAL_PAGES, totalPages);
        updateUI();

        cacheCurrentChapterIfEarly();

        // 翻页完成 1.5 秒后（待 DOM 渲染完毕），执行严格终点核验
        setTimeout(() => {
            checkEndOfBook();
            isFlipping = false;
        }, 1500);
    }

    // ================= 3. 调度下次翻页（基于绝对时间戳 Date.now()） =================
    function scheduleNext() {
        if (!isRunning || isLoopingBack || isVerifyingEnd) return;
        if (isEndOfBook()) {
            console.log('[微信读书助手] 🎯 检测到当前已处于末页，立即启动全书完结复核...');
            checkEndOfBook();
            return;
        }
        const delaySec = Math.floor(Math.random() * (CONFIG.maxDelay - CONFIG.minDelay + 1)) + CONFIG.minDelay;
        targetTurnTimestamp = Date.now() + (delaySec * 1000);
        updateUI();
    }

    function start() {
        if (isRunning) return;
        isRunning = true;
        activateAntiThrottlingAudio();
        localStorage.setItem(STORAGE_KEYS.IS_RUNNING, 'true');

        lastTickTimestamp = Date.now();
        updateUI();

        if (isEndOfBook()) {
            console.log('[微信读书助手] 🎯 启动时即处于末页，直接触发完结复核...');
            checkEndOfBook();
        } else {
            scheduleNext();
        }

        clearInterval(mainLoopTimer);
        mainLoopTimer = setInterval(() => {
            if (!isRunning || isLoopingBack || isVerifyingEnd) return;

            const now = Date.now();

            const deltaMs = now - lastTickTimestamp;
            if (deltaMs >= 1000) {
                const addSeconds = Math.floor(deltaMs / 1000);
                totalSeconds += addSeconds;
                lastTickTimestamp += (addSeconds * 1000);

                if (totalSeconds % 5 === 0) {
                    localStorage.setItem(STORAGE_KEYS.TOTAL_SECONDS, totalSeconds);
                }
            }

            if (now >= targetTurnTimestamp) {
                doSinglePageTurn();
                scheduleNext();
            }

            updateUI();
        }, 500);

        updateUI();
        console.log('[微信读书助手] 自动翻页已启动 (物理时钟模式)');
    }

    function pause() {
        isRunning = false;
        localStorage.setItem(STORAGE_KEYS.IS_RUNNING, 'false');
        clearInterval(mainLoopTimer);
        localStorage.setItem(STORAGE_KEYS.TOTAL_SECONDS, totalSeconds);
        updateUI();
        console.log('[微信读书助手] 自动翻页已暂停');
    }

    function resetStats() {
        if (confirm('确定要清空累计的阅读时长、翻页计数和循环轮次吗？')) {
            totalSeconds = 0;
            totalPages = 0;
            loopCount = 1;
            pagesInCurrentLoop = 0;
            lastTickTimestamp = Date.now();
            localStorage.setItem(STORAGE_KEYS.TOTAL_SECONDS, '0');
            localStorage.setItem(STORAGE_KEYS.TOTAL_PAGES, '0');
            localStorage.setItem(STORAGE_KEYS.LOOP_COUNT, '1');
            updateUI();
        }
    }

    // ================= 4. 异常自动恢复与定时整页刷新 =================
    function checkAndRecoverErrors() {
        if (isLoopingBack) return;
        const errorKeywords = ['加载失败', '网络异常', '请重试', '点击重试', '重新加载'];
        const candidates = document.querySelectorAll('button, a, div[role="button"], .weui-btn, .weui-dialog__btn, span');

        for (const el of candidates) {
            const text = (el.innerText || el.textContent || '').trim();
            for (const kw of errorKeywords) {
                if (text.includes(kw) && el.offsetParent !== null) {
                    console.warn(`[微信读书助手] ⚠️ 发现错误提示: "${text}"，正在自动点击重试...`);
                    triggerClick(el);

                    setTimeout(() => {
                        if (document.body && (document.body.innerText || '').includes('加载失败')) {
                            console.warn('[微信读书助手] 点击未恢复，强制刷新整页...');
                            location.reload();
                        }
                    }, 6000);
                    return;
                }
            }
        }
    }

    function checkPeriodicReload() {
        if (isLoopingBack) return;
        const now = Date.now();
        const elapsedMinutes = (now - lastReloadTime) / (1000 * 60);

        if (elapsedMinutes >= CONFIG.autoReloadMinutes) {
            console.log(`[微信读书助手] 已运行 ${elapsedMinutes.toFixed(1)} 分钟，执行定时整页刷新保活...`);
            localStorage.setItem(STORAGE_KEYS.LAST_RELOAD, now);
            localStorage.setItem(STORAGE_KEYS.TOTAL_SECONDS, totalSeconds);
            localStorage.setItem(STORAGE_KEYS.TOTAL_PAGES, totalPages);
            localStorage.setItem(STORAGE_KEYS.LOOP_COUNT, loopCount);
            location.reload();
        }
    }

    setInterval(() => {
        checkAndRecoverErrors();
        checkPeriodicReload();
    }, 4000);

    // ================= 5. 精美悬浮控制面板 (含 v1.9.0 标牌与本轮翻页数) =================
    function createUI() {
        if (uiContainer) return;

        uiContainer = document.createElement('div');
        uiContainer.id = 'weread-auto-panel';
        uiContainer.style.cssText = `
            position: fixed;
            bottom: 25px;
            right: 25px;
            z-index: 999999;
            background: rgba(23, 27, 38, 0.94);
            color: #fff;
            padding: 14px 18px;
            border-radius: 14px;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif;
            font-size: 13px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.4);
            backdrop-filter: blur(12px);
            border: 1px solid rgba(255,255,255,0.15);
            user-select: none;
            transition: all 0.3s ease;
            min-width: 270px;
        `;

        uiContainer.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;">
                <div style="display: flex; align-items: center; gap: 7px;">
                    <span id="weread-status-dot" style="width: 9px; height: 9px; border-radius: 50%; background: #10b981; display: inline-block;"></span>
                    <span id="weread-status-text" style="font-weight: 600; font-size: 13px;">自动翻页中</span>
                    <span style="background: rgba(59, 130, 246, 0.2); color: #60a5fa; font-size: 10px; padding: 1px 6px; border-radius: 4px; font-weight: 600; border: 1px solid rgba(59, 130, 246, 0.35);">${SCRIPT_VERSION}</span>
                </div>
                <div style="display: flex; gap: 6px;">
                    <button id="weread-reset-btn" title="清空累计时长与页数" style="
                        background: rgba(255,255,255,0.1);
                        color: #94a3b8;
                        border: 1px solid rgba(255,255,255,0.15);
                        padding: 3px 7px;
                        border-radius: 6px;
                        cursor: pointer;
                        font-size: 11px;
                    ">重置</button>
                    <button id="weread-toggle-btn" style="
                        background: #ef4444;
                        color: white;
                        border: none;
                        padding: 4px 12px;
                        border-radius: 6px;
                        cursor: pointer;
                        font-size: 12px;
                        font-weight: 500;
                    ">暂停</button>
                </div>
            </div>

            <div style="color: #94a3b8; font-size: 12px; line-height: 1.6; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 8px;">
                <div>下次翻页: <b id="weread-countdown" style="color: #38bdf8; font-size: 13px;">--</b> 秒 (单页严格对齐)</div>
                <div>累计翻页: <b id="weread-total-pages" style="color: #f1f5f9;">0</b> 页</div>
                <div>累计总时长: <b id="weread-total-time" style="color: #34d399; font-size: 13px;">0秒</b></div>
                <div style="color: #cbd5e1; font-size: 12px; margin-top: 2px;">
                    🔄 循环阅读: <b id="weread-loop-round" style="color: #fbbf24;">第 1 轮</b> <span id="weread-loop-sub" style="font-size: 11px; color: #94a3b8;">(本轮: 0页)</span>
                </div>
                <div id="weread-notice-box" style="display:none; color: #fbbf24; font-size: 11px; margin-top: 4px; background: rgba(251,191,36,0.1); padding: 4px 8px; border-radius: 4px;"></div>
                <div style="color: #64748b; font-size: 11px; margin-top: 4px; display: flex; justify-content: space-between;">
                    <span>🛡️ 视口物理几何核验</span>
                    <span id="weread-reload-countdown">90m定时保活</span>
                </div>
            </div>
        `;

        document.body.appendChild(uiContainer);

        document.getElementById('weread-toggle-btn').addEventListener('click', () => {
            if (isRunning) {
                pause();
            } else {
                start();
            }
        });

        document.getElementById('weread-reset-btn').addEventListener('click', resetStats);
        window.addEventListener('click', () => activateAntiThrottlingAudio(), { once: true });
    }

    function updateNotice(msg) {
        const box = document.getElementById('weread-notice-box');
        if (!box) return;
        if (msg) {
            box.innerText = msg;
            box.style.display = 'block';
        } else {
            box.style.display = 'none';
        }
    }

    function updateUI() {
        if (!uiContainer) return;
        const statusDot = document.getElementById('weread-status-dot');
        const statusText = document.getElementById('weread-status-text');
        const toggleBtn = document.getElementById('weread-toggle-btn');
        const countdownEl = document.getElementById('weread-countdown');
        const totalPagesEl = document.getElementById('weread-total-pages');
        const totalTimeEl = document.getElementById('weread-total-time');
        const loopRoundEl = document.getElementById('weread-loop-round');
        const loopSubEl = document.getElementById('weread-loop-sub');
        const reloadInfoEl = document.getElementById('weread-reload-countdown');

        if (isRunning) {
            statusDot.style.background = '#10b981';
            statusText.innerText = '自动翻页运行中';
            toggleBtn.innerText = '暂停';
            toggleBtn.style.background = '#ef4444';

            const remainSec = Math.max(0, Math.ceil((targetTurnTimestamp - Date.now()) / 1000));
            countdownEl.innerText = remainSec;
        } else {
            statusDot.style.background = '#94a3b8';
            statusText.innerText = '自动翻页已暂停';
            toggleBtn.innerText = '开始';
            toggleBtn.style.background = '#3b82f6';
            countdownEl.innerText = '已暂停';
        }

        totalPagesEl.innerText = totalPages;
        totalTimeEl.innerText = formatDuration(totalSeconds);
        if (loopRoundEl) loopRoundEl.innerText = `第 ${loopCount} 轮`;
        if (loopSubEl) loopSubEl.innerText = `(本轮已翻: ${pagesInCurrentLoop}页)`;

        const elapsedMins = (Date.now() - lastReloadTime) / (1000 * 60);
        const remainMins = Math.max(0, Math.round(CONFIG.autoReloadMinutes - elapsedMins));
        if (reloadInfoEl) {
            reloadInfoEl.innerText = `约${remainMins}分钟后保活刷新`;
        }
    }

    // ================= 6. SPA 单页路由自动激活 =================
    function checkPage() {
        const isReader = location.href.includes('/web/reader/');
        if (isReader) {
            if (!uiContainer) {
                createUI();
            } else {
                uiContainer.style.display = 'block';
            }
            cacheCurrentChapterIfEarly();
            if (!isRunning && CONFIG.autoStart) {
                start();
            }
        } else {
            if (uiContainer) {
                uiContainer.style.display = 'none';
            }
            if (isRunning) {
                pause();
            }
        }
    }

    setInterval(checkPage, 1000);
    checkPage();

})();
