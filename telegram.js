const fs = require("fs");
const puppeteer = require("puppeteer-core");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const {
    addLog,
    maskPhone,
    loadData,
    saveData,
    getDeviceConfig,
    getNextRandomTime,
    getRetryTime,
    getBjDateString,
    getDaysDiffBj
} = require("./utils");

const aiEndpoint = process.env.AI_ENDPOINT || process.env.OPENAI_BASE_URL || "";
const aiKey = process.env.AI_KEY || process.env.OPENAI_API_KEY || "";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const runningAccounts = new Set();

function randomDelay(minMs, maxMs) {
    const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    return sleep(ms);
}

function getChromiumPath() {
    const candidates = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/google-chrome"
    ].filter(Boolean);
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return "/usr/bin/chromium-browser";
}

async function runMiniAppInHeadlessBrowser(client, peer, button, webViewUrl, deviceConf, botName, maskedPhone) {
    let browser = null;
    let pageText = "";
    try {
        const executablePath = getChromiumPath();
        addLog(`[🤖 ${botName}] 🌐 [${maskedPhone}] 正在启动内置浏览器加载小程序并执行自动验证...`);
        browser = await puppeteer.launch({
            executablePath,
            headless: "new",
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-accelerated-2d-canvas",
                "--no-first-run",
                "--no-zygote",
                "--disable-gpu",
                "--disable-blink-features=AutomationControlled",
                "--lang=zh-CN,zh",
                "--window-size=390,1200"
            ]
        });

        const page = await browser.newPage();
        await page.setBypassCSP(true);
        await page.setViewport({ width: 390, height: 1200, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
        
        const androidUA = "Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.127 Mobile Safari/537.36";
        await page.setUserAgent(androidUA);

        let webAppClosed = false;
        let sentWebViewData = null;
        let lastChallenge = "";

        page.on("console", (msg) => {
            const txt = msg.text();
            if (txt.includes("cloudflareinsights") || txt.includes("beacon.min.js")) return;
            if (msg.type() === "error" || txt.includes("error") || txt.includes("Error") || txt.includes("turnstile")) {
                addLog(`[🤖 ${botName}] 🌐 页面控制台 [${msg.type()}]: ${txt.substring(0, 120)}`);
            }
        });

        page.on("request", (req) => {
            const url = req.url();
            if (url.includes("/checkin") || url.includes("/telegram/")) {
                const pd = req.postData();
                addLog(`[🤖 ${botName}] 📤 请求 [${req.method()}]: ${url.substring(0, 70)} (负载: ${pd ? pd.substring(0, 80) : "无"})`);
            }
        });

        page.on("response", async (res) => {
            const url = res.url();
            if (url.includes("/checkin") || res.status() >= 400) {
                if (url.includes("cloudflareinsights.com") || url.includes("google-analytics")) return;
                let body = "";
                try {
                    body = await res.text();
                    try {
                        const parsed = JSON.parse(body);
                        if (parsed && parsed.data && parsed.data.challenge) {
                            lastChallenge = parsed.data.challenge;
                        }
                    } catch (e) {}
                } catch (e) {}
                addLog(`[🤖 ${botName}] 📥 响应 [${res.status()}]: ${url.substring(0, 70)} -> ${body ? body.substring(0, 120) : "无响应体"}`);
            }
        });

        await page.exposeFunction("__tgBridgeEvent", async (eventType, eventData) => {
            if (eventType === "web_app_data_send" && eventData) {
                try {
                    const parsed = typeof eventData === "string" ? JSON.parse(eventData) : eventData;
                    if (parsed && parsed.data) {
                        sentWebViewData = String(parsed.data);
                    }
                } catch (e) {}
            }
            if (eventType === "web_app_close") {
                webAppClosed = true;
            }
        });

        let rawHash = "";
        let initParamsMap = {};
        try {
            const hashIndex = webViewUrl.indexOf("#");
            if (hashIndex !== -1) {
                rawHash = webViewUrl.substring(hashIndex + 1);
                const pairs = rawHash.split("&");
                for (const pair of pairs) {
                    const eqIdx = pair.indexOf("=");
                    if (eqIdx !== -1) {
                        const k = decodeURIComponent(pair.substring(0, eqIdx));
                        const v = decodeURIComponent(pair.substring(eqIdx + 1));
                        initParamsMap[k] = v;
                    }
                }
            }
        } catch (e) {}

        const rawTgWebAppData = initParamsMap["tgWebAppData"] || "";

        await page.evaluateOnNewDocument((params, rawInitData, fullHash) => {
            try {
                Object.defineProperty(navigator, "webdriver", { get: () => undefined });
                Object.defineProperty(navigator, "platform", { get: () => "Linux armv81" });
                Object.defineProperty(navigator, "vendor", { get: () => "Google Inc." });
                Object.defineProperty(navigator, "maxTouchPoints", { get: () => 5 });
                Object.defineProperty(navigator, "languages", { get: () => ["zh-CN", "zh", "en-US", "en"] });
                Object.defineProperty(navigator, "language", { get: () => "zh-CN" });

                if (!window.chrome) {
                    window.chrome = {
                        runtime: {},
                        loadTimes: function () {},
                        csi: function () {},
                        app: {}
                    };
                }

                if (window.outerWidth === 0) {
                    Object.defineProperty(window, "outerWidth", { get: () => 390 });
                    Object.defineProperty(window, "outerHeight", { get: () => 1200 });
                }

                const origQuery = window.navigator.permissions && window.navigator.permissions.query;
                if (origQuery) {
                    window.navigator.permissions.query = (p) => (
                        p.name === "notifications" ? Promise.resolve({ state: "default" }) : origQuery(p)
                    );
                }
            } catch (e) {}

            try {
                if (params && Object.keys(params).length > 0) {
                    sessionStorage.setItem("__telegram__initParams", JSON.stringify(params));
                }
            } catch (e) {}

            const bridgeHandler = function (eventType, eventData) {
                if (typeof window.__tgBridgeEvent === "function") {
                    window.__tgBridgeEvent(eventType, eventData);
                }
            };

            window.TelegramWebviewProxy = {
                postEvent: bridgeHandler
            };

            window.webkit = {
                messageHandlers: {
                    performAction: {
                        postMessage: function (data) {
                            if (!data) return;
                            try {
                                const parsed = typeof data === "string" ? JSON.parse(data) : data;
                                const evtName = parsed.event_name || parsed.eventType || "";
                                const evtData = parsed.data || parsed.eventData || "";
                                bridgeHandler(evtName, evtData);
                            } catch (e) {}
                        }
                    }
                }
            };

            let parsedUser = null;
            try {
                if (rawInitData) {
                    const sp = new URLSearchParams(rawInitData);
                    const userStr = sp.get("user");
                    if (userStr) parsedUser = JSON.parse(userStr);
                }
            } catch (e) {}

            window.Telegram = window.Telegram || {};
            window.Telegram.WebApp = {
                initData: rawInitData || "",
                initDataUnsafe: {
                    query_id: (new URLSearchParams(rawInitData || "")).get("query_id") || "",
                    user: parsedUser,
                    auth_date: (new URLSearchParams(rawInitData || "")).get("auth_date") || "",
                    hash: (new URLSearchParams(rawInitData || "")).get("hash") || ""
                },
                version: "7.0",
                platform: "android",
                colorScheme: "light",
                themeParams: {
                    bg_color: "#ffffff",
                    text_color: "#000000",
                    hint_color: "#707579",
                    link_color: "#3390ec",
                    button_color: "#3390ec",
                    button_text_color: "#ffffff"
                },
                isExpanded: true,
                viewportHeight: 1200,
                viewportStableHeight: 1200,
                headerColor: "#ffffff",
                backgroundColor: "#ffffff",
                BackButton: { isVisible: false, onClick: function () {}, offClick: function () {}, show: function () {}, hide: function () {} },
                MainButton: { text: "CONTINUE", color: "#3390ec", textColor: "#ffffff", isVisible: false, isActive: true, isProgressVisible: false, setText: function () {}, onClick: function () {}, offClick: function () {}, show: function () {}, hide: function () {}, enable: function () {}, disable: function () {}, showProgress: function () {}, hideProgress: function () {} },
                HapticFeedback: { impactOccurred: function () {}, notificationOccurred: function () {}, selectionChanged: function () {} },
                ready: function () { bridgeHandler("web_app_ready"); },
                expand: function () { bridgeHandler("web_app_expand"); },
                close: function () { bridgeHandler("web_app_close"); },
                sendData: function (data) { bridgeHandler("web_app_data_send", { data: String(data) }); },
                openLink: function (url) { bridgeHandler("web_app_open_link", { url: url }); },
                openTelegramLink: function (url) { bridgeHandler("web_app_open_tg_link", { path_full: url }); }
            };
        }, initParamsMap, rawTgWebAppData, rawHash);

        page.on("pageerror", (err) => {
            const msg = String(err.message || err);
            if (!msg.includes("Script error") && !msg.includes("ResizeObserver")) {
                addLog(`[🤖 ${botName}] ⚠️ 页面异常: ${msg.substring(0, 100)}`);
            }
        });

        await page.goto(webViewUrl, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});

        try {
            await page.evaluate(() => {
                if (window.Telegram && window.Telegram.WebApp) {
                    window.Telegram.WebApp.ready();
                    window.Telegram.WebApp.expand();
                }
            });
        } catch (e) {}

        const startWait = Date.now();
        let turnstileClickTime = 0;
        let submittedToken = false;
        let lastLoggedSummary = "";

        while (Date.now() - startWait < 50000 && !webAppClosed) {
            await sleep(1500);

            await page.evaluate(() => {
                window.scrollTo(0, document.body.scrollHeight);
                const candidates = document.querySelectorAll('iframe, .cf-turnstile, [data-sitekey], [id*="cf-"], [id*="turnstile"]');
                candidates.forEach(el => {
                    try {
                        el.scrollIntoView({ block: 'center' });
                    } catch (e) {}
                });
            }).catch(() => {});

            const pageSummary = await page.evaluate(() => {
                const text = document.body ? (document.body.innerText || "").replace(/\s+/g, " ").trim() : "";
                const ifrList = Array.from(document.querySelectorAll("iframe")).map(f => ({
                    src: f.src || '',
                    w: f.offsetWidth,
                    h: f.offsetHeight
                }));
                const hasTurnstileInput = Boolean(document.querySelector('input[name="cf-turnstile-response"]') || document.querySelector('textarea[name="cf-turnstile-response"]'));
                return { text, ifrList, hasTurnstileInput };
            }).catch(() => ({ text: "", ifrList: [], hasTurnstileInput: false }));

            const currentText = pageSummary.text;

            if (currentText && currentText !== lastLoggedSummary && !currentText.includes(lastLoggedSummary)) {
                lastLoggedSummary = currentText.substring(0, 60);
                addLog(`[🤖 ${botName}] 📄 [${maskedPhone}] 页面内容: ${lastLoggedSummary}...`);
            }

            if (currentText.includes("加载超时") || currentText.includes("重新加载") || currentText.includes("网络错误")) {
                await page.evaluate(() => {
                    const reloadBtns = Array.from(document.querySelectorAll("button, a, div[role='button'], .btn"));
                    for (const b of reloadBtns) {
                        const txt = (b.innerText || b.textContent || "").trim();
                        if (txt.includes("重新加载") || txt.includes("Reload") || txt.includes("重试")) {
                            b.click();
                            break;
                        }
                    }
                }).catch(() => {});
            }

            const now = Date.now();
            try {
                const iframes = await page.$$("iframe");
                for (const ifr of iframes) {
                    const src = await ifr.evaluate(el => el.src || "").catch(() => "");
                    const isCf = src.includes("challenges.cloudflare.com") || src.includes("turnstile") || src.includes("cf-chl") || src === "" || src.includes("about:blank");
                    if (isCf) {
                        await ifr.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' })).catch(() => {});
                        await sleep(200);

                        const box = await ifr.boundingBox();
                        if (box && box.width > 20 && box.height > 20 && now - turnstileClickTime > 6000) {
                            turnstileClickTime = Date.now();
                            addLog(`[🤖 ${botName}] 👆 [${maskedPhone}] 成功定位 Cloudflare 验证框 (尺寸: ${Math.round(box.width)}x${Math.round(box.height)})，执行模拟点击...`);
                            
                            const clickX = box.x + Math.min(32, Math.max(16, box.width * 0.12));
                            const clickY = box.y + box.height / 2;
                            await page.mouse.move(box.x + 2, box.y + 2);
                            await sleep(50);
                            await page.mouse.move(clickX, clickY, { steps: 5 });
                            await sleep(60);
                            await page.mouse.down();
                            await sleep(90);
                            await page.mouse.up();
                            break;
                        }
                    }
                }
            } catch (e) {}

            try {
                const frames = page.frames();
                for (const frame of frames) {
                    const frameUrl = frame.url();
                    if (frameUrl.includes("challenges.cloudflare.com") || frameUrl.includes("turnstile") || frameUrl.includes("cf-chl")) {
                        await frame.evaluate(() => {
                            const cb = document.querySelector("input[type='checkbox']") ||
                                       document.querySelector("#challenge-stage") ||
                                       document.querySelector(".ctp-checkbox-label") ||
                                       document.querySelector("label");
                            if (cb) cb.click();
                        }).catch(() => {});
                    }
                }
            } catch (e) {}

            const currentToken = await page.evaluate(() => {
                const cfInput = document.querySelector('input[name="cf-turnstile-response"]') || 
                                document.querySelector('textarea[name="cf-turnstile-response"]') ||
                                document.querySelector('[name*="turnstile"]');
                if (cfInput && cfInput.value && cfInput.value.length > 10) return cfInput.value;
                if (window.turnstile && typeof window.turnstile.getResponse === "function") {
                    try {
                        const t = window.turnstile.getResponse();
                        if (t && t.length > 10) return t;
                    } catch (e) {}
                }
                return null;
            }).catch(() => null);

            if (currentToken && !submittedToken) {
                submittedToken = true;
                addLog(`[🤖 ${botName}] 🎯 [${maskedPhone}] 成功获取 Cloudflare 验证 Token: ${currentToken.substring(0, 16)}...`);
                await sleep(1000);

                await page.evaluate((tok) => {
                    const submits = Array.from(document.querySelectorAll("button, a, div[role='button'], input[type='submit'], .btn"));
                    for (const b of submits) {
                        const t = (b.innerText || b.textContent || b.value || "").trim();
                        if (t.includes("签到") || t.includes("提交") || t.includes("完成") || t.includes("确定") || t.includes("Submit")) {
                            b.click();
                            break;
                        }
                    }
                }, currentToken).catch(() => {});

                if (lastChallenge && rawTgWebAppData) {
                    await page.evaluate(async (initData, ch, tk) => {
                        try {
                            const pathname = window.location.pathname || "";
                            let apiUrl = "/api/v1/servers/server-1/telegram/checkin";
                            if (pathname.includes("/servers/")) {
                                const match = pathname.match(/\/servers\/([^\/]+)/);
                                if (match && match[1]) {
                                    apiUrl = `/api/v1/servers/${match[1]}/telegram/checkin`;
                                }
                            }
                            await fetch(apiUrl, {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                    init_data: initData,
                                    challenge: ch,
                                    token: tk,
                                    turnstile_token: tk
                                })
                            });
                        } catch (e) {}
                    }, rawTgWebAppData, lastChallenge, currentToken).catch(() => {});
                }
            }

            if (currentText.includes("签到成功") || currentText.includes("验证成功") || currentText.includes("今日已签到") || currentText.includes("Success")) {
                addLog(`[🤖 ${botName}] 🎯 [${maskedPhone}] 小程序页面已检测到验证成功标识`);
                break;
            }

            if (sentWebViewData && button) {
                try {
                    await client.invoke(new Api.messages.SendWebViewData({
                        bot: peer,
                        randomId: BigInt(Math.floor(Math.random() * 1e15)),
                        buttonText: button.text || "签到",
                        data: sentWebViewData
                    }));
                    addLog(`[🤖 ${botName}] 📤 [${maskedPhone}] 已向机器人回传小程序验证数据`);
                    break;
                } catch (e) {}
            }
        }

        pageText = await page.evaluate(() => document.body ? (document.body.innerText || "") : "").catch(() => "");
        addLog(`[🤖 ${botName}] ✅ [${maskedPhone}] 小程序运行与验证流程执行完毕`);
        return { success: true, pageText };
    } catch (err) {
        addLog(`[🤖 ${botName}] ⚠️ [${maskedPhone}] 浏览器运行小程序异常: ${err.message}`);
        return { success: false, pageText: "" };
    } finally {
        if (browser) {
            try {
                await browser.close();
            } catch (e) {}
        }
    }
}

async function callModel(endpoint, key, model, base64Image, options, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(`${endpoint.replace(/\/$/, '')}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${key}`
            },
            body: JSON.stringify({
                model: model,
                messages: [
                    {
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: `这是一张验证图片。请从以下选项中选择一个最符合图片内容的选项。你必须只输出选项中的原文，不要包含任何其他文字、标点符号或解释。\n选项列表：${options.join(', ')}`
                            },
                            {
                                type: "image_url",
                                image_url: {
                                    url: `data:image/jpeg;base64,${base64Image}`
                                }
                            }
                        ]
                    }
                ],
                max_tokens: 50
            }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errText}`);
        }
        const resData = await response.json();
        if (resData.choices && resData.choices[0] && resData.choices[0].message) {
            return resData.choices[0].message.content.trim();
        }
        throw new Error("接口未返回有效 choices 数据");
    } catch (e) {
        clearTimeout(timeoutId);
        throw e;
    }
}

async function getBestAnswer(base64Image, options, aiSettings, botName) {
    const models = [aiSettings.model1, aiSettings.model2, aiSettings.model3].filter(Boolean);
    if (models.length === 0) {
        addLog(`[🤖 ${botName}] ⚠️ 未配置任何 AI 模型`);
        return null;
    }

    if (!aiEndpoint || !aiKey) {
        addLog(`[🤖 ${botName}] ⚠️ 系统未配置环境变量 AI_ENDPOINT 或 AI_KEY`);
        return null;
    }

    addLog(`[🤖 ${botName}] 🚀 正在向模型 [${models.join(', ')}] 发送并发请求...`);

    const promises = models.map(model => 
        callModel(aiEndpoint, aiKey, model, base64Image, options, 22000)
        .then(ans => ({ model, ans, success: true }))
        .catch(err => ({ model, err: err.message, success: false }))
    );

    const results = await Promise.all(promises);
    
    results.forEach(r => {
        if (r.success) {
            addLog(`[🤖 ${botName}] 💬 模型 [${r.model}] 返回: ${r.ans}`);
        } else {
            addLog(`[🤖 ${botName}] ❌ 模型 [${r.model}] 失败: ${r.err}`);
        }
    });

    const validAnswers = results
        .filter(r => r.success && r.ans)
        .map(r => {
            const cleaned = r.ans.trim().replace(/['"“”]/g, '');
            return options.find(opt => cleaned.includes(opt) || opt.includes(cleaned)) || null;
        })
        .filter(Boolean);

    if (validAnswers.length === 0) return null;

    const counts = {};
    let maxCount = 0;
    let bestAns = validAnswers[0];
    for (const ans of validAnswers) {
        counts[ans] = (counts[ans] || 0) + 1;
        if (counts[ans] > maxCount) {
            maxCount = counts[ans];
            bestAns = ans;
        }
    }
    addLog(`[🤖 ${botName}] 🗳️ 投票统计: ${JSON.stringify(counts)} -> 最终选择: [${bestAns}]`);
    return bestAns;
}

async function clickButtonByKeywords(client, peer, message, keywords, botName) {
    if (!message.replyMarkup || !message.replyMarkup.rows) return { clicked: false, popupText: "" };
    
    for (const row of message.replyMarkup.rows) {
        for (const button of row.buttons) {
            if (button.text && button.data) {
                for (const kw of keywords) {
                    if (button.text.includes(kw)) {
                        addLog(`[🤖 ${botName}] 👉 匹配到按钮: [${button.text}]，正在模拟点击...`);
                        let popupText = "";
                        
                        try {
                            let result = await client.invoke(new Api.messages.GetBotCallbackAnswer({
                                peer: peer,
                                msgId: message.id,
                                data: button.data
                            }));
                            if (result && result.message) {
                                popupText = result.message;
                                addLog(`[🤖 ${botName}] 💬 收到按钮回复: ${popupText}`);
                            } else {
                                addLog(`[🤖 ${botName}] ✅ 按钮已点击`);
                            }
                        } catch (e) {
                            if (e.message && (e.message.includes("BOT_RESPONSE_TIMEOUT") || e.message.includes("TIMEOUT"))) {
                                addLog(`[🤖 ${botName}] ✅ 按钮已点击`);
                            } else {
                                addLog(`[🤖 ${botName}] ⚠️ 点击异常: ${e.message}`);
                            }
                        }
                        return { clicked: true, popupText: popupText }; 
                    }
                }
            }
        }
    }
    return { clicked: false, popupText: "" };
}

async function markHistoryAsRead(client, botEntity, maxMsgId) {
    if (!botEntity || !maxMsgId || typeof maxMsgId !== 'number' || maxMsgId <= 0) return;
    try {
        await client.invoke(new Api.messages.ReadHistory({
            peer: botEntity,
            maxId: maxMsgId
        }));
    } catch (e) {}
}

async function executeStepList(client, botEntity, steps, maskedPhone, displayName, checkKeywords, deviceConf, taskName = "签到") {
    let latestHandledMsgId = 0;
    let forceSuccess = false;
    let finalResultText = "";

    const waitForBotResponse = async (lastMsgId, lastText, lastMarkupStr, timeoutMs = 15000) => {
        let startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) {
            if (forceSuccess) return null;
            await sleep(1000); 
            let checkMsgs = await client.getMessages(botEntity, { limit: 5 });
            let latestBotMsg = checkMsgs.find(m => !m.out);
            
            if (latestBotMsg) {
                const currentMarkupStr = latestBotMsg.replyMarkup ? JSON.stringify(latestBotMsg.replyMarkup) : "";
                const isNewMessage = latestBotMsg.id > lastMsgId;
                const isMessageModified = latestBotMsg.id === lastMsgId && (latestBotMsg.text !== lastText || currentMarkupStr !== lastMarkupStr);

                if (isNewMessage || isMessageModified) {
                    latestHandledMsgId = Math.max(latestHandledMsgId, latestBotMsg.id);
                    let text = latestBotMsg.text ? latestBotMsg.text.replace(/\n/g, '  ') : "[面板按钮已更新]";
                    addLog(`[🤖 ${displayName}] 📩 收到新回复/消息面板更新: ${text}`);
                    await markHistoryAsRead(client, botEntity, latestBotMsg.id);
                    return { text: latestBotMsg.text || "", msg: latestBotMsg };
                }
            }
        }
        return null;
    };

    for (let i = 0; i < steps.length; i++) {
        if (forceSuccess) break;
        const step = steps[i];
        
        if (step.type === 'send' || step.type === 'send_delete') {
            await randomDelay(2000, 4000);
            const isDelete = (step.type === 'send_delete');
            addLog(`[🤖 ${displayName}] 🚀 [${maskedPhone}] ${taskName}发送: ${step.text}${isDelete ? ' 将在 30 秒后撤回' : ''}`);
            
            let messagesBefore = await client.getMessages(botEntity, { limit: 5 });
            let lastBotMsgBefore = messagesBefore.find(m => !m.out);
            let lastMsgId = lastBotMsgBefore ? lastBotMsgBefore.id : 0;
            let lastText = lastBotMsgBefore ? lastBotMsgBefore.text : "";
            let lastMarkupStr = (lastBotMsgBefore && lastBotMsgBefore.replyMarkup) ? JSON.stringify(lastBotMsgBefore.replyMarkup) : "";

            let startTime = Date.now();
            let sentMsg = await client.sendMessage(botEntity, { message: step.text });
            
            let response = await waitForBotResponse(lastMsgId, lastText, lastMarkupStr, 25000);
            if (response) {
                finalResultText = response.text;
            } else {
                finalResultText = "";
            }

            if (isDelete) {
                let elapsed = Date.now() - startTime;
                if (elapsed < 30000) {
                    await sleep(30000 - elapsed);
                }
                try {
                    if (sentMsg && sentMsg.id) {
                        await client.deleteMessages(botEntity, [sentMsg.id], { revoke: true });
                        addLog(`[🤖 ${displayName}] 🗑️ [${maskedPhone}] 已成功撤回发送的消息: ${step.text}`);
                    }
                } catch (delErr) {
                    addLog(`[🤖 ${displayName}] ⚠️ 撤回消息失败: ${delErr.message}`);
                }
            }
        } 
        else if (step.type === 'click') {
            await randomDelay(1500, 2500);
            let messages = await client.getMessages(botEntity, { limit: 5 });
            let lastBotMsg = messages.find(m => !m.out); 

            if (lastBotMsg) {
                latestHandledMsgId = Math.max(latestHandledMsgId, lastBotMsg.id);
                let lastMsgId = lastBotMsg.id;
                let lastText = lastBotMsg.text;
                let lastMarkupStr = lastBotMsg.replyMarkup ? JSON.stringify(lastBotMsg.replyMarkup) : "";

                let keywords = step.text.split(',').map(k => k.trim()).filter(k => k);
                let clickRes = await clickButtonByKeywords(client, botEntity, lastBotMsg, keywords, displayName);
                
                if (!clickRes.clicked) {
                    addLog(`[🤖 ${displayName}] ℹ️ [${maskedPhone}] 未找到匹配的普通按钮 [${step.text}]，跳过此步。`);
                } else {
                    let matchedPopup = false;
                    if (clickRes.popupText && checkKeywords && checkKeywords.trim() !== "") {
                        const kws = checkKeywords.split(',').map(k => k.trim()).filter(k => k);
                        if (kws.length > 0 && kws.some(kw => clickRes.popupText.includes(kw))) {
                            matchedPopup = true;
                        }
                    }

                    if (matchedPopup) {
                        addLog(`[🤖 ${displayName}] 🎯 弹窗回复匹配到检测关键词，立即判定成功。`);
                        finalResultText = clickRes.popupText;
                        forceSuccess = true;
                        break;
                    } else {
                        let response = await waitForBotResponse(lastMsgId, lastText, lastMarkupStr, 12000);
                        if (response) {
                            finalResultText = response.text;
                        } else if (clickRes.popupText) {
                            addLog(`[🤖 ${displayName}] ℹ️ 未收到新消息，使用弹窗回复作为检测文本。`);
                            finalResultText = clickRes.popupText;
                        } else {
                            finalResultText = "";
                        }
                    }
                }
            } else {
                addLog(`[🤖 ${displayName}] ⚠️ 未找到历史消息，无法点击。`);
            }
        }
        else if (step.type === 'miniapp_open') {
            await randomDelay(1500, 2500);
            let messages = await client.getMessages(botEntity, { limit: 5 });
            let lastBotMsg = messages.find(m => !m.out);

            if (lastBotMsg && lastBotMsg.replyMarkup && lastBotMsg.replyMarkup.rows) {
                latestHandledMsgId = Math.max(latestHandledMsgId, lastBotMsg.id);
                let targetButton = null;
                const rawKws = (step.text && step.text !== '开启') ? step.text : "";
                const keywords = rawKws ? rawKws.split(',').map(k => k.trim()).filter(Boolean) : [];

                for (const row of lastBotMsg.replyMarkup.rows) {
                    for (const btn of row.buttons) {
                        const isWebView = Boolean(
                            btn.url && (
                                btn.className === "KeyboardButtonWebView" ||
                                btn.className === "KeyboardButtonSimpleWebView" ||
                                !btn.data
                            )
                        );
                        if (isWebView) {
                            if (keywords.length > 0) {
                                if (btn.text && keywords.some(kw => btn.text.includes(kw))) {
                                    targetButton = btn;
                                    break;
                                }
                            } else {
                                targetButton = btn;
                                break;
                            }
                        }
                    }
                    if (targetButton) break;
                }

                if (!targetButton) {
                    addLog(`[🤖 ${displayName}] ⚠️ [${maskedPhone}] 未在最新消息中找到匹配 [${rawKws || '任意'}] 的小程序按钮，跳过此步。`);
                } else {
                    addLog(`[🤖 ${displayName}] 🚀 [${maskedPhone}] 检测到小程序按钮 [${targetButton.text}]，正在唤出小程序...`);
                    let lastMsgId = lastBotMsg.id;
                    let lastText = lastBotMsg.text;
                    let lastMarkupStr = JSON.stringify(lastBotMsg.replyMarkup);
                    let miniRes = { success: false, pageText: "" };

                    try {
                        const themeParams = new Api.DataJSON({
                            data: JSON.stringify({
                                bg_color: "#ffffff",
                                text_color: "#000000",
                                hint_color: "#707579",
                                link_color: "#3390ec",
                                button_color: "#3390ec",
                                button_text_color: "#ffffff"
                            })
                        });
                        let webViewResult = null;
                        try {
                            webViewResult = await client.invoke(new Api.messages.RequestWebView({
                                peer: botEntity,
                                bot: botEntity,
                                platform: "android",
                                fromBotMenu: false,
                                url: targetButton.url,
                                msgId: lastBotMsg.id,
                                themeParams: themeParams
                            }));
                        } catch (err1) {
                            webViewResult = await client.invoke(new Api.messages.RequestSimpleWebView({
                                bot: botEntity,
                                platform: "android",
                                url: targetButton.url,
                                themeParams: themeParams
                            }));
                        }

                        if (webViewResult && webViewResult.url) {
                            miniRes = await runMiniAppInHeadlessBrowser(
                                client,
                                botEntity,
                                targetButton,
                                webViewResult.url,
                                deviceConf || getDeviceConfig(),
                                displayName,
                                maskedPhone || ""
                            );
                        }
                    } catch (webErr) {
                        addLog(`[🤖 ${displayName}] ⚠️ 唤出小程序异常: ${webErr.message}`);
                    }

                    let response = await waitForBotResponse(lastMsgId, lastText, lastMarkupStr, 10000);
                    let botMsgText = response ? (response.text || "") : "";
                    if (!botMsgText) {
                        let checkMsgs = await client.getMessages(botEntity, { limit: 3 });
                        let latest = checkMsgs.find(m => !m.out);
                        if (latest && latest.text) botMsgText = latest.text;
                    }

                    finalResultText = [miniRes.pageText, botMsgText].filter(Boolean).join(" ");
                    if (finalResultText) {
                        addLog(`[🤖 ${displayName}] 📋 [${maskedPhone}] 验证反馈内容: ${finalResultText.replace(/\n/g, ' ').substring(0, 80)}...`);
                    }
                }
            } else {
                addLog(`[🤖 ${displayName}] ⚠️ 未找到包含按钮的最新消息，无法唤出小程序。`);
            }
        }
        else if (step.type === 'ai_captcha') {
            let messages = await client.getMessages(botEntity, { limit: 5 });
            let lastBotMsg = messages.find(m => !m.out);
            if (lastBotMsg && lastBotMsg.media && lastBotMsg.replyMarkup) {
                latestHandledMsgId = Math.max(latestHandledMsgId, lastBotMsg.id);
                addLog(`[🤖 ${displayName}] ⏳ [${maskedPhone}] 正在执行 AI 识别步骤...`);
                const currentData = loadData();
                const options = [];
                if (lastBotMsg.replyMarkup.rows) {
                    for (const row of lastBotMsg.replyMarkup.rows) {
                        for (const btn of row.buttons) {
                            if (btn.text) options.push(btn.text);
                        }
                    }
                }
                if (options.length > 1) {
                    addLog(`[🤖 ${displayName}] 🔍 正在下载验证码图片并调用 AI 求解...`);
                    try {
                        const buffer = await client.downloadMedia(lastBotMsg.media);
                        if (buffer) {
                            const base64Image = buffer.toString('base64');
                            addLog(`[🤖 ${displayName}] 📋 验证码选项: ${options.join(', ')}`);
                            const bestAns = await getBestAnswer(base64Image, options, currentData.aiSettings, displayName);
                            if (bestAns) {
                                await randomDelay(1500, 3000);
                                addLog(`[🤖 ${displayName}] 🎯 AI 选定答案: [${bestAns}]，正在模拟点击...`);
                                let lastMsgId = lastBotMsg.id;
                                let lastText = lastBotMsg.text;
                                let lastMarkupStr = JSON.stringify(lastBotMsg.replyMarkup);
                                let clickRes = await clickButtonByKeywords(client, botEntity, lastBotMsg, [bestAns], displayName);
                                
                                let matchedPopup = false;
                                if (clickRes.popupText && checkKeywords && checkKeywords.trim() !== "") {
                                    const kws = checkKeywords.split(',').map(k => k.trim()).filter(k => k);
                                    if (kws.length > 0 && kws.some(kw => clickRes.popupText.includes(kw))) {
                                        matchedPopup = true;
                                    }
                                }

                                if (matchedPopup) {
                                    addLog(`[🤖 ${displayName}] 🎯 弹窗回复匹配到检测关键词，立即判定成功。`);
                                    finalResultText = clickRes.popupText;
                                    forceSuccess = true;
                                    break;
                                } else {
                                    let response = await waitForBotResponse(lastMsgId, lastText, lastMarkupStr, 25000);
                                    if (response) {
                                        finalResultText = response.text;
                                    } else if (clickRes.popupText) {
                                        addLog(`[🤖 ${displayName}] ℹ️ 未收到新消息，使用弹窗回复作为检测文本。`);
                                        finalResultText = clickRes.popupText;
                                    } else {
                                        finalResultText = "";
                                    }
                                }
                            } else {
                                addLog(`[🤖 ${displayName}] ❌ AI 未能给出有效答案`);
                            }
                        }
                    } catch (err) {
                        addLog(`[🤖 ${displayName}] ❌ AI 识别步骤失败: ${err.message}`);
                    }
                } else {
                    addLog(`[🤖 ${displayName}] ⚠️ 验证码选项不足，跳过 AI 识别`);
                }
            } else {
                addLog(`[🤖 ${displayName}] ⚠️ 未找到包含媒体 and 按钮的最新消息，无法执行 AI 识别`);
            }
        }
        else if (step.type === 'webapp' || step.type === 'webapp_json') {
            addLog(`[🤖 ${displayName}] ⏳ [${maskedPhone}] 正在请求小程序鉴权数据...`);
            try {
                let targetWebAppUrl = step.type === 'webapp' ? step.webAppUrl : step.config.webAppUrl;
                
                const themeParams = new Api.DataJSON({
                    data: JSON.stringify({
                        "bg_color": "#ffffff",
                        "text_color": "#000000",
                        "hint_color": "#707579",
                        "link_color": "#3390ec",
                        "button_color": "#3390ec",
                        "button_text_color": "#ffffff",
                        "secondary_bg_color": "#f4f4f5",
                        "header_bg_color": "#ffffff",
                        "bottom_bar_bg_color": "#ffffff",
                        "accent_text_color": "#3390ec",
                        "section_bg_color": "#ffffff",
                        "section_header_text_color": "#3390ec",
                        "subtitle_text_color": "#707579",
                        "destructive_text_color": "#df3f40"
                    })
                });

                const webViewResult = await client.invoke(new Api.messages.RequestWebView({
                    peer: botEntity,
                    bot: botEntity,
                    platform: "android",
                    fromBotMenu: false,
                    url: targetWebAppUrl,
                    themeParams: themeParams
                }));
                
                if (webViewResult && webViewResult.url) {
                    if (step.type === 'webapp' && (!step.apiUrl || step.apiUrl === 'auto' || step.apiUrl === 'browser')) {
                        let messagesBefore = await client.getMessages(botEntity, { limit: 5 });
                        let lastBotMsgBefore = messagesBefore.find(m => !m.out);
                        let lastMsgId = lastBotMsgBefore ? lastBotMsgBefore.id : 0;
                        let lastText = lastBotMsgBefore ? lastBotMsgBefore.text : "";
                        let lastMarkupStr = (lastBotMsgBefore && lastBotMsgBefore.replyMarkup) ? JSON.stringify(lastBotMsgBefore.replyMarkup) : "";

                        await runMiniAppInHeadlessBrowser(client, botEntity, null, webViewResult.url, deviceConf, displayName, maskedPhone);
                        let response = await waitForBotResponse(lastMsgId, lastText, lastMarkupStr, 12000);
                        if (response) finalResultText = response.text;
                    } else {
                        let tgWebAppDataEncoded = "";
                        let tgWebAppDataDecoded = "";
                        const match = webViewResult.url.match(/tgWebAppData=([^&]+)/);
                        
                        if (match && match[1]) {
                            tgWebAppDataEncoded = match[1];
                            tgWebAppDataDecoded = decodeURIComponent(match[1]);
                            
                            addLog(`[🤖 ${displayName}] ✅ [${maskedPhone}] 成功获取动态鉴权数据!`);
                            
                            let fetchOptions = {};
                            let apiUrl = "";

                            if (step.type === 'webapp_json') {
                                const replaceVars = (obj) => {
                                    if (typeof obj === 'string') {
                                        return obj.replace(/\{\{tgWebAppData\}\}/g, tgWebAppDataEncoded)
                                                  .replace(/\{\{tgWebAppData_decoded\}\}/g, tgWebAppDataDecoded);
                                    } else if (Array.isArray(obj)) {
                                        return obj.map(replaceVars);
                                    } else if (typeof obj === 'object' && obj !== null) {
                                        let res = {};
                                        for (let k in obj) res[k] = replaceVars(obj[k]);
                                        return res;
                                    }
                                    return obj;
                                };

                                let finalConfig = replaceVars(step.config);
                                apiUrl = finalConfig.apiUrl;
                                const customHeaders = finalConfig.headers || {};
                                if (!customHeaders['User-Agent'] && !customHeaders['user-agent']) {
                                    customHeaders['User-Agent'] = deviceConf.userAgent;
                                }
                                fetchOptions = {
                                    method: finalConfig.method || 'POST',
                                    headers: customHeaders,
                                    body: finalConfig.body ? (typeof finalConfig.body === 'string' ? finalConfig.body : JSON.stringify(finalConfig.body)) : undefined
                                };
                            } else {
                                apiUrl = step.apiUrl;
                                fetchOptions = {
                                    method: 'POST',
                                    headers: {
                                        'Content-Type': 'application/json',
                                        'Authorization': `Bearer ${tgWebAppDataDecoded}`,
                                        'User-Agent': deviceConf.userAgent
                                    },
                                    body: JSON.stringify({ action: 'checkin', tgWebAppData: tgWebAppDataDecoded })
                                };
                            }
                            
                            await randomDelay(2000, 4000);
                            const response = await fetch(apiUrl, fetchOptions);
                            const resText = await response.text();
                            finalResultText = resText;
                            addLog(`[🤖 ${displayName}] 🎁 [${maskedPhone}] 小程序返回: ${resText.substring(0, 150)}`);
                        } else {
                            addLog(`[🤖 ${displayName}] ❌ [${maskedPhone}] 无法从返回 URL 中提取 tgWebAppData`);
                        }
                    }
                }
            } catch (e) {
                addLog(`[🤖 ${displayName}] ❌ [${maskedPhone}] 小程序请求失败: ${e.message}`);
            }
        }
    }

    if (latestHandledMsgId > 0) {
        await markHistoryAsRead(client, botEntity, latestHandledMsgId);
    }

    let isSuccess = true;
    if (forceSuccess) {
        isSuccess = true;
    } else {
        if (checkKeywords && checkKeywords.trim() !== "") {
            const kws = checkKeywords.split(',').map(k => k.trim()).filter(k => k);
            if (kws.length > 0) {
                isSuccess = kws.some(kw => finalResultText.includes(kw));
            }
        }
    }

    return { isSuccess, finalResultText };
}

async function simulateBrowseChannelOrIdle(client, maskedPhone, durationMs = 300000) {
    const startTime = Date.now();
    try {
        await client.invoke(new Api.account.UpdateStatus({ offline: false }));
    } catch (e) {}

    let chosenChannel = null;
    let chosenTitle = "";

    try {
        const dialogs = await client.getDialogs({ limit: 30 });
        const channels = dialogs.filter(d => d.isChannel && d.entity);
        if (channels.length > 0) {
            chosenChannel = channels[Math.floor(Math.random() * channels.length)];
            chosenTitle = chosenChannel.title || chosenChannel.name || "已加入频道";
            addLog(`📱 [${maskedPhone}] 随机进入频道 [${chosenTitle}] 模拟阅读 5 分钟...`);
        } else {
            addLog(`📱 [${maskedPhone}] 未检测到已加入的频道，切换为在线保持 5 分钟...`);
        }
    } catch (e) {
        addLog(`📱 [${maskedPhone}] 获取对话列表失败，切换为在线保持 5 分钟: ${e.message}`);
    }

    while (Date.now() - startTime < durationMs) {
        const remainingMs = durationMs - (Date.now() - startTime);
        if (remainingMs <= 0) break;
        const stepMs = Math.min(remainingMs, Math.floor(Math.random() * 15000) + 35000);
        await sleep(stepMs);

        try {
            await client.invoke(new Api.account.UpdateStatus({ offline: false }));
        } catch (e) {}

        if (chosenChannel && chosenChannel.entity) {
            try {
                const msgs = await client.getMessages(chosenChannel.entity, { limit: 10 });
                if (msgs && msgs.length > 0) {
                    const topMsg = msgs[0];
                    if (topMsg && topMsg.id) {
                        await client.invoke(new Api.channels.ReadHistory({
                            channel: chosenChannel.entity,
                            maxId: topMsg.id
                        }));
                    }
                }
            } catch (e) {}
        }
    }
    addLog(`🌱 [${maskedPhone}] 已成功完成 5 分钟在线与浏览，准备断开连接。`);
}

async function runCheckinForAccount(accountPhone, isManual = false, targetBotUsername = null) {
    let data = loadData();
    let account = data.accounts.find(a => a.phone === accountPhone);
    if (!account) return;

    const maskedPhone = maskPhone(account.phone);
    if (runningAccounts.has(accountPhone)) {
        if (isManual) {
            addLog(`📱 [${maskedPhone}] 任务已在运行中，跳过重复执行。`);
        }
        return;
    }
    runningAccounts.add(accountPhone);

    const now = Date.now();
    let botsToRun = data.bots.filter(b => b.enabledAccounts && b.enabledAccounts.includes(accountPhone));
    
    if (targetBotUsername) {
        botsToRun = botsToRun.filter(b => b.username === targetBotUsername);
    } else if (isManual) {
    } else {
        botsToRun = botsToRun.filter(b => {
            const state = b.states && b.states[accountPhone];
            const nextRunTime = state ? state.nextRunTime : 0;
            return now >= nextRunTime;
        });
    }
    
    if (botsToRun.length === 0) {
        runningAccounts.delete(accountPhone);
        return;
    }

    const apiId = Number(data.settings.apiId);
    if (!Number.isInteger(apiId) || apiId <= 0) {
        addLog(`❌ [${maskedPhone}] Telegram API ID 配置无效: ${data.settings.apiId}`);
        runningAccounts.delete(accountPhone);
        return;
    }

    const deviceConf = getDeviceConfig(account.phone);
    addLog(`📱 [${maskedPhone}] 开始执行任务，当前设备环境: ${deviceConf.deviceModel}`);
    const client = new TelegramClient(new StringSession(account.session), apiId, data.settings.apiHash, deviceConf);
    
    try {
        await client.connect();
        try {
            await client.invoke(new Api.account.UpdateStatus({ offline: false }));
        } catch (e) {}
        addLog(`✅ [${maskedPhone}] Telegram 连接成功！`);

        for (let bIdx = 0; bIdx < botsToRun.length; bIdx++) {
            if (bIdx > 0) {
                await randomDelay(3000, 6000);
            }

            const botObj = botsToRun[bIdx];
            const botUsername = botObj.username;
            const displayName = botObj.name; 
            const state = botObj.states[accountPhone];
            const checkinInterval = botObj.checkinIntervalDays || 1;

            const todayBj = getBjDateString();
            if (state.lastRetryDate !== todayBj) {
                state.todayRetryCount = 0;
                state.lastRetryDate = todayBj;
            }

            let botEntity;
            try {
                botEntity = await client.getEntity(botUsername);
            } catch (entityError) {
                addLog(`[🤖 ${displayName}] ❌ [${maskedPhone}] 无法找到机器人 ${botUsername}。`);
                state.todayRetryCount = (state.todayRetryCount || 0) + 1;
                state.lastStatus = 'fail';
                
                const nowBjTime = new Date(Date.now() + 8 * 60 * 60 * 1000);
                const isAfter2330Bj = (nowBjTime.getUTCHours() === 23 && nowBjTime.getUTCMinutes() >= 30);
                
                if (state.todayRetryCount >= 2 || isAfter2330Bj) {
                    state.retryCount = 0;
                    state.nextRunTime = getNextRandomTime(checkinInterval);
                } else {
                    state.retryCount = 0;
                    state.nextRunTime = getRetryTime();
                }
                
                data = loadData();
                let botIndex = data.bots.findIndex(b => b.username === botUsername);
                if (botIndex !== -1) {
                    data.bots[botIndex].states[accountPhone] = state;
                    saveData(data);
                }
                
                const nextTimeStr = new Date(state.nextRunTime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
                addLog(`[🤖 ${displayName}] 📅 [${maskedPhone}] 下次执行时间已设定为: ${nextTimeStr}`);
                continue; 
            }

            const lastSuccessBj = state.lastSuccessTime ? getBjDateString(state.lastSuccessTime) : "";
            let isCheckinSuccess = !isManual && (todayBj === lastSuccessBj);
            let skipCheckinSteps = isCheckinSuccess;

            if (!isManual && !skipCheckinSteps && state.todayRetryCount > 0 && botObj.checkKeywords && botObj.checkKeywords.trim() !== "") {
                try {
                    let preCheckMessages = await client.getMessages(botEntity, { limit: 5 });
                    let lastOutMsg = preCheckMessages.find(m => m.out);
                    if (lastOutMsg) {
                        let botReplies = preCheckMessages.filter(m => !m.out && m.id > lastOutMsg.id);
                        const kws = botObj.checkKeywords.split(',').map(k => k.trim()).filter(k => k);
                        
                        const nowBj = new Date(Date.now() + 8 * 60 * 60 * 1000);
                        const todayStartBjMs = Date.UTC(nowBj.getUTCFullYear(), nowBj.getUTCMonth(), nowBj.getUTCDate(), 0, 0, 0);
                        const todayStartMs = todayStartBjMs - 8 * 60 * 60 * 1000;
                        const todayStartSec = Math.floor(todayStartMs / 1000);

                        let matchedReply = botReplies.find(reply => {
                            if (reply.text && reply.date >= todayStartSec) {
                                return kws.some(kw => reply.text.includes(kw));
                            }
                            return false;
                        });

                        if (matchedReply) {
                            addLog(`[🤖 ${displayName}] 🔍 预检发现今日已在后台签到成功，跳过签到步骤。`);
                            state.lastSuccessTime = matchedReply.date * 1000;
                            isCheckinSuccess = true;
                            skipCheckinSteps = true;
                            await markHistoryAsRead(client, botEntity, matchedReply.id);
                        }
                    }
                } catch (preCheckErr) {
                    addLog(`[🤖 ${displayName}] ⚠️ 预检过程出错: ${preCheckErr.message}`);
                }
            }

            if (!isManual && state.todayRetryCount >= 2) {
                addLog(`[🤖 ${displayName}] ⚠️ 今日已达到重试上限(2次)，推迟至明日再次尝试。`);
                state.nextRunTime = getNextRandomTime(1);
                data = loadData();
                let botIndex = data.bots.findIndex(b => b.username === botUsername);
                if (botIndex !== -1) {
                    data.bots[botIndex].states[accountPhone] = state;
                    saveData(data);
                }
                const nextTimeStr = new Date(state.nextRunTime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
                addLog(`[🤖 ${displayName}] 📅 [${maskedPhone}] 下次执行时间已设定为: ${nextTimeStr}`);
                continue;
            }

            if (!isManual) {
                state.todayRetryCount = (state.todayRetryCount || 0) + 1;
            }

            if (!skipCheckinSteps) {
                if (state.todayRetryCount <= 1 || isManual) {
                    addLog(`[🤖 ${displayName}] 🚀 开始执行签到...`);
                } else {
                    addLog(`[🤖 ${displayName}] 🚀 开始执行签到 重试...`);
                }
                const checkinResult = await executeStepList(client, botEntity, botObj.steps, maskedPhone, displayName, botObj.checkKeywords, deviceConf, "签到");
                isCheckinSuccess = checkinResult.isSuccess;
            }

            const nowBjTime = new Date(Date.now() + 8 * 60 * 60 * 1000);
            const isAfter2330Bj = (nowBjTime.getUTCHours() === 23 && nowBjTime.getUTCMinutes() >= 30);

            if (!isCheckinSuccess) {
                state.lastStatus = 'fail';
                if (isManual) {
                    addLog(`[🤖 ${displayName}] ❌ 手动签到测试失败。`);
                } else if (state.todayRetryCount >= 2) {
                    state.retryCount = 0;
                    state.nextRunTime = getNextRandomTime(checkinInterval);
                    addLog(`[🤖 ${displayName}] ❌ 今日签到重试已失败，推迟至下次周期。`);
                } else if (isAfter2330Bj) {
                    state.retryCount = 0;
                    state.nextRunTime = getNextRandomTime(checkinInterval);
                    addLog(`[🤖 ${displayName}] ❌ 签到在 23:30 后失败，跳过重试并推迟。`);
                } else {
                    state.retryCount = 0; 
                    state.nextRunTime = getRetryTime(); 
                    addLog(`[🤖 ${displayName}] ❌ 签到失败，已安排重试。`);
                }
            } else {
                state.lastSuccessTime = Date.now();
                if (!skipCheckinSteps) {
                    addLog(`[🤖 ${displayName}] ✅ 签到确认成功！`);
                } else {
                    addLog(`[🤖 ${displayName}] ℹ️ 今日已签到成功，跳过签到步骤。`);
                }

                const renewInterval = parseInt(botObj.renewIntervalDays) || 0;
                const hasRenewConfig = renewInterval > 0 && Array.isArray(botObj.renewSteps) && botObj.renewSteps.length > 0;
                const daysSinceRenew = getDaysDiffBj(state.lastRenewDate, todayBj);
                const needRenewToday = hasRenewConfig && (daysSinceRenew >= renewInterval);

                if (!needRenewToday) {
                    if (hasRenewConfig) {
                        addLog(`[🤖 ${displayName}] ℹ️ [${maskedPhone}] 距上次续费(${state.lastRenewDate || '未记录'})已有 ${daysSinceRenew} 天，未达续费周期 ${renewInterval} 天，跳过续费。`);
                    }
                    state.retryCount = 0;
                    state.todayRetryCount = 0;
                    state.lastStatus = 'success';
                    state.nextRunTime = getNextRandomTime(checkinInterval);
                } else {
                    addLog(`[🤖 ${displayName}] 🔄 [${maskedPhone}] 满足续费条件(距上次续费 ${daysSinceRenew} 天 / 设定周期 ${renewInterval} 天)，开始执行自动续费...`);
                    await randomDelay(2500, 4500);
                    const renewResult = await executeStepList(client, botEntity, botObj.renewSteps, maskedPhone, displayName, botObj.checkKeywords, deviceConf, "续费");
                    
                    if (renewResult.isSuccess) {
                        state.lastRenewDate = todayBj;
                        state.lastRenewStatus = 'success';
                        state.retryCount = 0;
                        state.todayRetryCount = 0;
                        state.lastStatus = 'success';
                        state.nextRunTime = getNextRandomTime(checkinInterval);
                        addLog(`[🤖 ${displayName}] 🌟 [${maskedPhone}] 自动续费执行成功，记录本次续费日期: ${todayBj}`);
                    } else {
                        state.lastStatus = 'fail';
                        state.lastRenewStatus = 'fail';
                        addLog(`[🤖 ${displayName}] ❌ [${maskedPhone}] 自动续费失败，准备安排重试...`);
                        if (isManual) {
                        } else if (state.todayRetryCount >= 2) {
                            state.retryCount = 0;
                            state.nextRunTime = getNextRandomTime(1);
                            addLog(`[🤖 ${displayName}] ⚠️ 今日续费重试已达上限，推迟至明天再次尝试。`);
                        } else if (isAfter2330Bj) {
                            state.retryCount = 0;
                            state.nextRunTime = getNextRandomTime(1);
                            addLog(`[🤖 ${displayName}] ⚠️ 超过 23:30，推迟至明天再次尝试续费。`);
                        } else {
                            state.retryCount = 0;
                            state.nextRunTime = getRetryTime();
                            addLog(`[🤖 ${displayName}] 📅 已安排今日稍后重试续费。`);
                        }
                    }
                }
            }
            
            data = loadData();
            let botIndex = data.bots.findIndex(b => b.username === botUsername);
            if (botIndex !== -1) {
                data.bots[botIndex].states[accountPhone] = state;
                saveData(data);
            }
            
            const nextTimeStr = new Date(state.nextRunTime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
            addLog(`[🤖 ${displayName}] 📅 [${maskedPhone}] 下次执行时间已设定为: ${nextTimeStr}`);
        }

        await simulateBrowseChannelOrIdle(client, maskedPhone, 300000);

    } catch (error) {
        addLog(`❌ [${maskedPhone}] 运行出错: ${error.message}`);
        const errStr = String(error.message || error);
        data = loadData();
        if (errStr.includes("AUTH_KEY_UNREGISTERED") || errStr.includes("USER_DEACTIVATED") || errStr.includes("SESSION_REVOKED") || errStr.includes("PHONE_NUMBER_BANNED")) {
            addLog(`🚨 [${maskedPhone}] 检测到账号已被封禁或 Session 已失效，已自动推迟该账号所有任务 24 小时。`);
            const longNextTime = Date.now() + 24 * 60 * 60 * 1000;
            data.bots.forEach(b => {
                if (b.states && b.states[accountPhone]) {
                    b.states[accountPhone].nextRunTime = longNextTime;
                    b.states[accountPhone].lastStatus = 'fail';
                }
            });
            saveData(data);
        } else {
            const retryTime = getRetryTime();
            data.bots.forEach(b => {
                if (b.states && b.states[accountPhone]) {
                    b.states[accountPhone].nextRunTime = retryTime;
                    b.states[accountPhone].lastStatus = 'fail';
                }
            });
            saveData(data);
        }
    } finally {
        try {
            await client.destroy();
        } catch (e) {}
        runningAccounts.delete(accountPhone);
        addLog(`🔌 [${maskedPhone}] 任务结束，已彻底断开连接。`);
    }
}

async function runRenewForAccount(accountPhone, targetBotUsername) {
    let data = loadData();
    let account = data.accounts.find(a => a.phone === accountPhone);
    if (!account) return;

    const maskedPhone = maskPhone(account.phone);
    if (runningAccounts.has(accountPhone)) {
        addLog(`📱 [${maskedPhone}] 任务已在运行中，跳过续费测试。`);
        return;
    }
    runningAccounts.add(accountPhone);

    const botObj = data.bots.find(b => b.username === targetBotUsername);
    if (!botObj) {
        addLog(`❌ [${maskedPhone}] 机器人不存在: ${targetBotUsername}`);
        runningAccounts.delete(accountPhone);
        return;
    }

    if (!Array.isArray(botObj.renewSteps) || botObj.renewSteps.length === 0) {
        addLog(`[🤖 ${botObj.name}] ⚠️ [${maskedPhone}] 尚未配置续费步骤，无法执行续费测试。`);
        runningAccounts.delete(accountPhone);
        return;
    }

    const apiId = Number(data.settings.apiId);
    if (!Number.isInteger(apiId) || apiId <= 0) {
        addLog(`❌ [${maskedPhone}] Telegram API ID 配置无效`);
        runningAccounts.delete(accountPhone);
        return;
    }

    const deviceConf = getDeviceConfig(account.phone);
    addLog(`📱 [${maskedPhone}] 开始执行独立续费测试...`);
    const client = new TelegramClient(new StringSession(account.session), apiId, data.settings.apiHash, deviceConf);

    try {
        await client.connect();
        const botEntity = await client.getEntity(botObj.username);
        const renewResult = await executeStepList(client, botEntity, botObj.renewSteps, maskedPhone, botObj.name, botObj.checkKeywords, deviceConf, "续费测试");
        
        const todayBjDate = getBjDateString();
        data = loadData();
        let bIdx = data.bots.findIndex(b => b.username === botObj.username);
        if (bIdx !== -1) {
            if (!data.bots[bIdx].states[accountPhone]) {
                data.bots[bIdx].states[accountPhone] = {
                    nextRunTime: getNextRandomTime(data.bots[bIdx].checkinIntervalDays || 1),
                    retryCount: 0,
                    todayRetryCount: 0,
                    lastRetryDate: "",
                    lastStatus: 'pending',
                    lastSuccessTime: 0,
                    lastRenewDate: "",
                    lastRenewStatus: 'pending'
                };
            }
            if (renewResult.isSuccess) {
                data.bots[bIdx].states[accountPhone].lastRenewDate = todayBjDate;
                data.bots[bIdx].states[accountPhone].lastRenewStatus = 'success';
                addLog(`[🤖 ${botObj.name}] 🌟 [${maskedPhone}] 续费测试执行成功，已更新续费日期为: ${todayBjDate}`);
            } else {
                data.bots[bIdx].states[accountPhone].lastRenewStatus = 'fail';
                addLog(`[🤖 ${botObj.name}] ⚠️ [${maskedPhone}] 续费测试未匹配检测关键词或未确认成功`);
            }
            saveData(data);
        }
    } catch (err) {
        addLog(`[🤖 ${botObj.name}] ❌ [${maskedPhone}] 续费测试失败: ${err.message}`);
    } finally {
        try {
            await client.destroy();
        } catch (e) {}
        runningAccounts.delete(accountPhone);
        addLog(`🔌 [${maskedPhone}] 续费测试连接已释放。`);
    }
}

async function importSessionsFromEnv() {
    const envSessionsStr = process.env.TG_SESSIONS;
    if (!envSessionsStr) return;

    const sessions = envSessionsStr.split(/[\n,]+/).map(s => s.trim()).filter(s => s);
    if (sessions.length === 0) return;

    let data = loadData();
    let addedCount = 0;

    for (const sessionStr of sessions) {
        if (data.accounts.find(a => a.session === sessionStr)) continue;

        const apiId = Number(data.settings.apiId);
        if (!Number.isInteger(apiId) || apiId <= 0) {
            addLog(`❌ 环境变量导入失败: Telegram API ID 配置无效`);
            continue;
        }

        addLog(`🔄 正在从环境变量导入新的 Session...`);
        const tempClient = new TelegramClient(new StringSession(sessionStr), apiId, data.settings.apiHash, getDeviceConfig());
        try {
            await tempClient.connect();
            const me = await tempClient.getMe();
            const phone = "+" + me.phone;
            
            data = loadData();
            if (!data.accounts.find(a => a.phone === phone)) {
                const devConf = getDeviceConfig(phone);
                data.accounts.push({ phone: phone, session: sessionStr, deviceIndex: devConf.deviceIndex });
                saveData(data);
                addLog(`✅ 环境变量导入成功！识别到账号: ${maskPhone(phone)}，分配环境: ${devConf.deviceModel}`);
                addedCount++;
            }
        } catch (error) {
            addLog(`❌ 环境变量 Session 导入失败: ${error.message}`);
        } finally {
            await tempClient.destroy();
        }
    }
    if (addedCount > 0) addLog(`🎉 环境变量导入完成，共新增 ${addedCount} 个账号。`);
}

module.exports = {
    runCheckinForAccount,
    runRenewForAccount,
    importSessionsFromEnv,
    runningAccounts
};