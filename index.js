const express = require("express");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const EventEmitter = require("events");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");

const app = express();
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.json({ limit: '50mb' }));

// ================= 屏蔽底层刷屏日志 =================
const originalConsoleError = console.error;
const originalConsoleLog = console.log;

function isIgnoredLog(args) {
    const str = args.map(a => (a instanceof Error ? a.stack || a.message : String(a))).join(' ');
    if (str.includes('TIMEOUT') && str.includes('updates.js')) return true;
    return false;
}

console.error = function (...args) {
    if (isIgnoredLog(args)) return;
    originalConsoleError.apply(console, args);
};

console.log = function (...args) {
    if (isIgnoredLog(args)) return;
    originalConsoleLog.apply(console, args);
};
// ====================================================

// 手机号脱敏函数 (提升到全局)
function maskPhone(phone) {
    if (!phone || phone.length < 8) return phone;
    return phone.substring(0, 4) + '****' + phone.substring(phone.length - 4);
}

// ================= 基础配置与数据存储 =================
const port = process.env.PORT || 3000;
const dataFile = path.join(__dirname, "data.json");
const webPassword = process.env.WEB_PASSWORD || ""; 

const defaultSteps = [
    { type: 'send', text: '/start' },
    { type: 'click', text: '签到' },
    { type: 'click', text: '人机,验证,不是,机器,✅' }
];

function loadData() {
    let data = { 
        accounts: [], 
        settings: { apiId: 2040, apiHash: "b18441a1ff607e10a989891a5462e627" },
        keepAlive: { url: "", interval: 300, enabled: false }
    };
    if (fs.existsSync(dataFile)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(dataFile, "utf8"));
            data = { ...data, ...parsed };
        } catch (e) {
            console.error("读取 data.json 失败，可能文件损坏，将使用默认配置:", e.message);
        }
    }
    
    data.accounts.forEach(acc => {
        if (acc.bots && acc.bots.length > 0) {
            acc.bots = acc.bots.map(b => {
                if (typeof b === 'string') {
                    return { username: b, name: b, nextRunTime: Date.now(), steps: [...defaultSteps], checkKeywords: "", retryCount: 0, lastStatus: 'pending', lastSuccessTime: 0 };
                }
                if (!b.steps) b.steps = [...defaultSteps];
                if (b.checkKeywords === undefined) b.checkKeywords = "";
                if (b.retryCount === undefined) b.retryCount = 0;
                if (b.lastStatus === undefined) b.lastStatus = 'pending'; // pending, success, fail
                if (b.lastSuccessTime === undefined) b.lastSuccessTime = 0;
                return b;
            });
        }
    });
    return data;
}

// 原子化写入，防止写入中断导致 data.json 损坏清空
function saveData(data) {
    const tempFile = dataFile + ".tmp";
    try {
        fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), "utf8");
        fs.renameSync(tempFile, dataFile);
    } catch (e) {
        console.error("保存数据失败:", e.message);
    }
}

function getDeviceConfig() {
    return {
        connectionRetries: 5,
        deviceModel: "iPhone X",
        systemVersion: "16.6.1",
        appVersion: "Swiftgram 12.7 (275)",
        langCode: "zh-hans",
        systemLangCode: "zh-hans"
    };
}

// ================= 全局状态与日志 =================
let logHistory = [];
const MAX_LOGS = 200; 

function addLog(msg) {
    const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const logStr = `[${time}] ${msg}`;
    originalConsoleLog(logStr); 
    logHistory.push({ timestamp: Date.now(), text: logStr }); 
    if (logHistory.length > MAX_LOGS) logHistory.shift(); 
}

function getNextRandomTime() {
    const now = new Date();
    const currentUtc = now.getTime();
    const bjTimeMs = currentUtc + 8 * 60 * 60 * 1000;
    const bjDate = new Date(bjTimeMs);
    
    const tomorrowBjMs = Date.UTC(bjDate.getUTCFullYear(), bjDate.getUTCMonth(), bjDate.getUTCDate() + 1);
    
    // 北京时间 8:00 - 23:30
    const minTimeBjMs = tomorrowBjMs + 8 * 60 * 60 * 1000;
    const maxTimeBjMs = tomorrowBjMs + 23.5 * 60 * 60 * 1000;
    
    const randomBjMs = Math.floor(Math.random() * (maxTimeBjMs - minTimeBjMs)) + minTimeBjMs;
    
    return randomBjMs - 8 * 60 * 60 * 1000;
}

function getRetryTime() {
    const now = Date.now();
    const bjTimeMs = now + 8 * 60 * 60 * 1000;
    const bjDate = new Date(bjTimeMs);
    
    const todayLimitBjMs = Date.UTC(bjDate.getUTCFullYear(), bjDate.getUTCMonth(), bjDate.getUTCDate(), 23, 30, 0);
    const todayLimitMs = todayLimitBjMs - 8 * 60 * 60 * 1000;
    
    const today23BjMs = Date.UTC(bjDate.getUTCFullYear(), bjDate.getUTCMonth(), bjDate.getUTCDate(), 23, 0, 0);
    const today23Ms = today23BjMs - 8 * 60 * 60 * 1000;

    const sixHoursLater = now + 6 * 60 * 60 * 1000;

    if (now >= todayLimitMs) {
        return getNextRandomTime();
    } else if (sixHoursLater > todayLimitMs) {
        const startMs = Math.max(now + 60 * 1000, today23Ms); 
        return Math.floor(Math.random() * (todayLimitMs - startMs)) + startMs;
    } else {
        return sixHoursLater;
    }
}

// ================= 保活机制 =================
let keepAliveTimer = null;
function startKeepAlive() {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    const data = loadData();
    if (data.keepAlive && data.keepAlive.enabled && data.keepAlive.url) {
        const intervalMs = (data.keepAlive.interval || 300) * 1000;
        addLog(`🟢 保活机制已启动: 每 ${data.keepAlive.interval} 秒请求一次`);
        keepAliveTimer = setInterval(() => {
            const url = data.keepAlive.url;
            const client = url.startsWith('https') ? https : http;
            client.get(url, (res) => {
                res.on('data', () => {}); 
                res.on('end', () => {});
            }).on('error', (err) => {});
        }, intervalMs);
    }
}

// ================= 网页密码保护 =================
app.use((req, res, next) => {
    if (!webPassword) return next(); 
    if (req.path === '/web-login') return next(); 

    const cookies = req.headers.cookie || "";
    if (cookies.includes(`auth=${webPassword}`)) return next(); 

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
            <title>安全验证</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background: #f2f2f7; margin: 0; }
                .login-box { background: #fff; padding: 25px; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); text-align: center; width: 85%; max-width: 320px; }
                input { padding: 14px; width: 100%; box-sizing: border-box; margin-bottom: 15px; border: 1px solid #e5e5ea; border-radius: 10px; font-size: 16px; background: #f2f2f7; outline: none; color: #000; }
                input:focus { border-color: #007aff; }
                button { padding: 14px; width: 100%; background: #007aff; color: #fff; border: none; border-radius: 10px; font-size: 16px; cursor: pointer; font-weight: 600; }
            </style>
        </head>
        <body>
            <div class="login-box">
                <h2 style="margin-top:0; color:#1c1c1e;">🔒 访问受限</h2>
                <form action="/web-login" method="POST" class="normal-form">
                    <input type="password" name="password" placeholder="请输入密码" required>
                    <button type="submit">进入控制台</button>
                </form>
            </div>
        </body>
        </html>
    `);
});

app.post('/web-login', (req, res) => {
    if (req.body.password === webPassword) {
        res.setHeader('Set-Cookie', `auth=${webPassword}; Max-Age=2592000; HttpOnly`); 
        res.redirect('/');
    } else {
        res.send('<script>alert("❌ 密码错误！");window.location.href="/";</script>');
    }
});

// ================= 核心功能 =================
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function clickButtonByKeywords(client, peer, message, keywords, botName) {
    if (!message.replyMarkup || !message.replyMarkup.rows) return { clicked: false, popupText: "" };
    
    for (const row of message.replyMarkup.rows) {
        for (const button of row.buttons) {
            if (button.text) {
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

async function runCheckinForAccount(accountPhone, isManual = false, targetBotUsername = null) {
    let data = loadData();
    let account = data.accounts.find(a => a.phone === accountPhone);
    if (!account) return;

    const maskedPhone = maskPhone(account.phone);
    const now = Date.now();
    let botsToRun = [];
    
    if (targetBotUsername) {
        botsToRun = account.bots.filter(b => b.username === targetBotUsername);
    } else if (isManual) {
        botsToRun = account.bots;
    } else {
        botsToRun = account.bots.filter(b => now >= b.nextRunTime);
    }
    
    if (botsToRun.length === 0) return; 

    addLog(`📱 [${maskedPhone}] 开始执行签到任务...`);
    const client = new TelegramClient(new StringSession(account.session), data.settings.apiId, data.settings.apiHash, getDeviceConfig());
    
    try {
        await client.connect();
        addLog(`✅ [${maskedPhone}] Telegram 连接成功！`);

        for (let botObj of botsToRun) {
            const botUsername = botObj.username;
            const displayName = botObj.name; 

            if (!isManual) {
                const randomDelay = Math.floor(Math.random() * 20000) + 10000;
                addLog(`[🤖 ${displayName}] ⏳ [${maskedPhone}] 准备签到，随机等待 ${(randomDelay/1000).toFixed(1)} 秒...`);
                await sleep(randomDelay);
            }

            let botEntity;
            try {
                botEntity = await client.getEntity(botUsername);
            } catch (entityError) {
                addLog(`[🤖 ${displayName}] ❌ [${maskedPhone}] 无法找到机器人 ${botUsername}，跳过。`);
                continue; 
            }

            let initialMessages = await client.getMessages(botEntity, { limit: 5 });
            let lastReadMsgId = initialMessages.length > 0 ? Math.max(...initialMessages.map(m => m.id)) : 0;
            let lastPrintedText = ""; 
            let finalResultText = ""; 

            const waitForBotResponse = async (timeoutMs = 15000) => {
                const startTime = Date.now();
                let finalLastText = "";
                
                let currentMsgs = await client.getMessages(botEntity, { limit: 5 });
                let initialBotMsg = currentMsgs.find(m => !m.out); 
                let initialText = initialBotMsg ? initialBotMsg.text : "";

                while (Date.now() - startTime < timeoutMs) {
                    await sleep(2000); 
                    let checkMsgs = await client.getMessages(botEntity, { limit: 5 });
                    
                    let newBotMsgs = checkMsgs.filter(m => !m.out && m.id > lastReadMsgId).reverse();
                    let latestBotMsg = checkMsgs.find(m => !m.out);
                    
                    let foundUpdate = false;

                    if (newBotMsgs.length > 0) {
                        for (let m of newBotMsgs) {
                            let text = m.text ? m.text.replace(/\n/g, '  ') : "[非文本消息/图片/卡片等]";
                            addLog(`[🤖 ${displayName}] 📩 收到新回复: ${text}`);
                            finalLastText = text;
                            lastPrintedText = text;
                        }
                        lastReadMsgId = Math.max(...newBotMsgs.map(m => m.id));
                        foundUpdate = true;
                    } 
                    else if (latestBotMsg && latestBotMsg.text !== initialText && latestBotMsg.text !== lastPrintedText) {
                        let text = latestBotMsg.text ? latestBotMsg.text.replace(/\n/g, '  ') : "[非文本消息/图片/卡片等]";
                        addLog(`[🤖 ${displayName}] 📝 消息已更新: ${text}`);
                        finalLastText = text;
                        lastPrintedText = text;
                        foundUpdate = true;
                    }

                    if (foundUpdate) {
                        await sleep(1000); 
                        return finalLastText;
                    }
                }
                
                return finalLastText;
            };

            for (let i = 0; i < botObj.steps.length; i++) {
                const step = botObj.steps[i];
                
                if (step.type === 'send') {
                    addLog(`[🤖 ${displayName}] 🚀 [${maskedPhone}] 发送: ${step.text}`);
                    await client.sendMessage(botEntity, { message: step.text });
                    
                    let sentMsgs = await client.getMessages(botEntity, { limit: 1 });
                    if(sentMsgs.length > 0) lastReadMsgId = Math.max(lastReadMsgId, sentMsgs[0].id);

                    let msgText = await waitForBotResponse(15000);
                    if (msgText) finalResultText = msgText;
                } 
                else if (step.type === 'click') {
                    let messages = await client.getMessages(botEntity, { limit: 5 });
                    let lastBotMsg = messages.find(m => !m.out); 

                    if (lastBotMsg) {
                        addLog(`[🤖 ${displayName}] ⏳ [${maskedPhone}] 尝试点击包含 [${step.text}] 的按钮...`);
                        let keywords = step.text.split(',').map(k => k.trim()).filter(k => k);
                        let clickRes = await clickButtonByKeywords(client, botEntity, lastBotMsg, keywords, displayName);
                        
                        if (!clickRes.clicked) {
                            addLog(`[🤖 ${displayName}] ℹ️ [${maskedPhone}] 未找到匹配 [${step.text}] 的按钮，跳过此步。`);
                        } else {
                            if (clickRes.popupText) finalResultText = clickRes.popupText;
                            let msgText = await waitForBotResponse(15000);
                            if (msgText) finalResultText = msgText;
                        }
                    } else {
                        addLog(`[🤖 ${displayName}] ⚠️ 未找到机器人的历史消息，无法点击。`);
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
                            platform: 'ios',
                            fromBotMenu: false,
                            url: targetWebAppUrl,
                            themeParams: themeParams
                        }));
                        
                        if (webViewResult && webViewResult.url) {
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
                                    fetchOptions = {
                                        method: finalConfig.method || 'POST',
                                        headers: finalConfig.headers || {},
                                        body: finalConfig.body ? (typeof finalConfig.body === 'string' ? finalConfig.body : JSON.stringify(finalConfig.body)) : undefined
                                    };
                                } else {
                                    apiUrl = step.apiUrl;
                                    fetchOptions = {
                                        method: 'POST',
                                        headers: {
                                            'Content-Type': 'application/json',
                                            'Authorization': `Bearer ${tgWebAppDataDecoded}`,
                                            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6_1 like Mac OS X)'
                                        },
                                        body: JSON.stringify({ action: 'checkin', tgWebAppData: tgWebAppDataDecoded })
                                    };
                                }
                                
                                const response = await fetch(apiUrl, fetchOptions);
                                const resText = await response.text();
                                finalResultText = resText;
                                addLog(`[🤖 ${displayName}] 🎁 [${maskedPhone}] 小程序签到返回: ${resText.substring(0, 150)}`);
                            } else {
                                addLog(`[🤖 ${displayName}] ❌ [${maskedPhone}] 无法从返回的 URL 中提取 tgWebAppData`);
                            }
                        }
                    } catch (e) {
                        addLog(`[🤖 ${displayName}] ❌ [${maskedPhone}] 小程序请求失败: ${e.message}`);
                    }
                    let msgText = await waitForBotResponse(10000);
                    if (msgText) finalResultText = msgText;
                }
            }

            let isSuccess = true; 
            if (botObj.checkKeywords && botObj.checkKeywords.trim() !== "") {
                const kws = botObj.checkKeywords.split(',').map(k => k.trim()).filter(k => k);
                if (kws.length > 0) {
                    isSuccess = kws.some(kw => finalResultText.includes(kw));
                }
            }

            if (isSuccess) {
                botObj.retryCount = 0;
                botObj.lastStatus = 'success';
                botObj.lastSuccessTime = Date.now(); 
                botObj.nextRunTime = getNextRandomTime();
                if (botObj.checkKeywords && botObj.checkKeywords.trim() !== "") {
                    addLog(`[🤖 ${displayName}] ✅ 签到结果检测通过！`);
                }
            } else {
                botObj.retryCount = (botObj.retryCount || 0) + 1;
                botObj.lastStatus = 'fail';
                if (botObj.retryCount < 3) {
                    const delayMs = Math.floor(Math.random() * 2 * 60 * 1000) + 3 * 60 * 1000; 
                    botObj.nextRunTime = Date.now() + delayMs;
                    addLog(`[🤖 ${displayName}] ⚠️ 签到结果检测未通过！(第 ${botObj.retryCount} 次失败) 将在 ${(delayMs/60000).toFixed(1)} 分钟后重试。`);
                } else {
                    botObj.retryCount = 0; 
                    botObj.nextRunTime = getRetryTime(); 
                    addLog(`[🤖 ${displayName}] ❌ 连续 3 次签到失败！可能机器人出现问题，已推迟重试。`);
                }
            }
            
            data = loadData();
            let accIndex = data.accounts.findIndex(a => a.phone === account.phone);
            let botIndex = data.accounts[accIndex].bots.findIndex(b => b.username === botUsername);
            data.accounts[accIndex].bots[botIndex].nextRunTime = botObj.nextRunTime;
            data.accounts[accIndex].bots[botIndex].retryCount = botObj.retryCount;
            data.accounts[accIndex].bots[botIndex].lastStatus = botObj.lastStatus;
            data.accounts[accIndex].bots[botIndex].lastSuccessTime = botObj.lastSuccessTime;
            saveData(data);
            
            const nextTimeStr = new Date(botObj.nextRunTime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
            addLog(`[🤖 ${displayName}] 📅 [${maskedPhone}] 下次执行时间已设定为: ${nextTimeStr}`);
        }
    } catch (error) {
        addLog(`❌ [${maskedPhone}] 运行出错: ${error.message}`);
    } finally {
        await client.destroy();
        addLog(`🔌 [${maskedPhone}] 任务结束，已彻底断开连接。`);
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

        addLog(`🔄 正在从环境变量导入新的 Session...`);
        const client = new TelegramClient(new StringSession(sessionStr), data.settings.apiId, data.settings.apiHash, getDeviceConfig());
        try {
            await client.connect();
            const me = await client.getMe();
            const phone = "+" + me.phone;
            
            if (!data.accounts.find(a => a.phone === phone)) {
                data.accounts.push({ phone: phone, session: sessionStr, bots: [] });
                saveData(data);
                addLog(`✅ 环境变量导入成功！识别到账号: ${maskPhone(phone)}`);
                addedCount++;
            }
        } catch (error) {
            addLog(`❌ 环境变量 Session 导入失败: ${error.message}`);
        } finally {
            await client.destroy();
        }
    }
    if (addedCount > 0) addLog(`🎉 环境变量导入完成，共新增 ${addedCount} 个账号。`);
}

// ================= 渲染账号列表 HTML =================
function renderAccountsHtml() {
    const data = loadData();
    if (data.accounts.length === 0) {
        return "<p style='color:#8e8e93; text-align:center; padding:20px 0; font-size:14px;'>暂无账号，请在下方登录添加。</p>";
    }

    let html = "";
    data.accounts.forEach((acc) => {
        let botsHtml = acc.bots.map(b => {
            const nextTimeStr = new Date(b.nextRunTime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
            
            let statusIcon = "⏳";
            if (b.lastStatus === 'fail') {
                statusIcon = "❌";
            } else if (b.lastStatus === 'success' && (Date.now() - (b.lastSuccessTime || 0) < 60000)) {
                statusIcon = "✅";
            }

            const displayName = b.name === b.username ? b.username : `${b.name} <span class="text-sec" style="font-size:12px; font-weight:normal;">(${b.username})</span>`;
            
            const stepsStr = b.steps.map(s => {
                if (s.type === 'send') return `发送: ${s.text}`;
                if (s.type === 'click') return `点击: ${s.text}`;
                if (s.type === 'webapp') return `小程序: ${s.webAppUrl} | ${s.apiUrl}`;
                if (s.type === 'webapp_json') return `小程序: ${JSON.stringify(s.config)}`;
                return '';
            }).join('\n');

            return `
            <div class="bot-item" style="margin-bottom:10px; padding:10px 12px; border:1px solid var(--border); border-radius:10px; background:#fff;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div style="flex:1; min-width:0;">
                        <div style="font-size:14px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                            ${statusIcon} ${displayName}
                        </div> 
                        <div style="margin-top:4px; font-size:12px; color:#ff3b30;">
                            🕒 下次: ${nextTimeStr} ${b.retryCount > 0 ? `<span style="color:#ff9500;">(重试 ${b.retryCount}/3)</span>` : ''}
                        </div>
                    </div>
                    <div style="display:flex; gap:6px; flex-shrink:0;">
                        <form action="/run-single-bot" method="POST" class="ajax-form" style="margin:0;">
                            <input type="hidden" name="phone" value="${acc.phone}">
                            <input type="hidden" name="bot" value="${b.username}">
                            <button type="submit" class="btn-action" style="background:#e5f1ff; color:#007aff;">测试</button>
                        </form>
                        <form action="/remove-bot" method="POST" class="ajax-form" data-confirm="确定要删除这个机器人吗？" style="margin:0;">
                            <input type="hidden" name="phone" value="${acc.phone}">
                            <input type="hidden" name="bot" value="${b.username}">
                            <button type="submit" class="btn-action" style="background:#ffe5e5; color:#ff3b30;">删除</button>
                        </form>
                    </div>
                </div>
                <details style="font-size:12px; margin-top:8px;">
                    <summary style="cursor:pointer; color:#007aff; font-weight:500; outline:none;">⚙️ 自定义步骤</summary>
                    <form action="/update-steps" method="POST" class="ajax-form" style="margin-top:8px;">
                        <input type="hidden" name="phone" value="${acc.phone}">
                        <input type="hidden" name="bot" value="${b.username}">
                        <textarea name="stepsStr" rows="3" class="custom-textarea" placeholder="发送: /start\n点击: 签到">${stepsStr}</textarea>
                        <input type="text" name="checkKeywords" value="${b.checkKeywords || ''}" placeholder="结果检测关键词(逗号分隔，留空不检测)" class="custom-input">
                        <button type="submit" class="btn-action" style="margin-top:6px; width:100%; background:#34c759; color:#fff; padding:6px;">保存配置</button>
                    </form>
                </details>
            </div>`;
        }).join("");
            
        html += `
            <div class="account-card" style="padding:15px; margin-bottom:15px; border-radius:12px;">
                <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--border); padding-bottom:10px; margin-bottom:12px;">
                    <h3 style="margin:0; font-size:16px;">📱 ${maskPhone(acc.phone)}</h3>
                    <div style="display:flex; gap:8px;">
                        <form action="/get-tg-code" method="POST" class="ajax-form" style="margin:0;">
                            <input type="hidden" name="phone" value="${acc.phone}">
                            <button type="submit" style="display:flex; flex-direction:column; align-items:center; justify-content:center; background:#fff5e5; color:#ff9500; border:none; border-radius:8px; padding:4px 10px; font-size:11px; font-weight:600; cursor:pointer; min-width:48px;">
                                <span style="font-size:14px; margin-bottom:2px;">📩</span>
                                <span>获取</span>
                            </button>
                        </form>
                        <form action="/run-account" method="POST" class="ajax-form" style="margin:0;">
                            <input type="hidden" name="phone" value="${acc.phone}">
                            <button type="submit" style="display:flex; flex-direction:column; align-items:center; justify-content:center; background:#e5f1ff; color:#007aff; border:none; border-radius:8px; padding:4px 10px; font-size:11px; font-weight:600; cursor:pointer; min-width:48px;">
                                <span style="font-size:14px; margin-bottom:2px;">⚡</span>
                                <span>执行</span>
                            </button>
                        </form>
                    </div>
                </div>
                
                <details style="margin-bottom:12px; font-size:13px;">
                    <summary class="text-sec" style="cursor:pointer; outline:none;">🔑 查看 Session 密钥</summary>
                    <div style="position:relative; margin-top:6px;">
                        <textarea id="sess-${acc.phone.replace('+', '')}" readonly class="session-textarea">${acc.session}</textarea>
                        <button type="button" onclick="copyText('sess-${acc.phone.replace('+', '')}', this)" style="position:absolute; right:5px; top:5px; padding:4px 8px; font-size:12px; background:#e5e5ea; color:#1c1c1e; border:none; border-radius:4px; cursor:pointer;">复制</button>
                    </div>
                </details>

                <details open style="margin-bottom:12px;">
                    <summary style="font-weight:600; font-size:14px; cursor:pointer; outline:none; margin-bottom:8px;">🎯 目标机器人 (${acc.bots.length})</summary>
                    <div style="margin-bottom:12px;">${botsHtml || "<div class='empty-bot'>暂无机器人</div>"}</div>
                </details>
                
                <form action="/add-bot" method="POST" class="ajax-form" style="display:flex; gap:6px; margin-bottom:12px; align-items:stretch;">
                    <input type="hidden" name="phone" value="${acc.phone}">
                    <input type="text" name="botUsername" placeholder="用户名 (@xxx)" required style="flex:1; min-width:0; padding:10px; margin:0; border-radius:8px; font-size:13px;">
                    <input type="text" name="customName" placeholder="昵称(选填)" style="flex:1; min-width:0; padding:10px; margin:0; border-radius:8px; font-size:13px;">
                    <button type="submit" class="btn-action" style="background:#007aff; color:white; padding:0 15px; margin:0;">添加</button>
                </form>
                
                <form action="/delete-account" method="POST" class="ajax-form" data-confirm="确定要退出并删除此账号吗？此操作不可恢复。" style="margin:0; text-align:center;">
                    <input type="hidden" name="phone" value="${acc.phone}">
                    <button type="submit" style="background:none; border:none; color:#ff3b30; font-size:13px; cursor:pointer; padding:5px;">退出并删除此账号</button>
                </form>
            </div>
        `;
    });
    return html;
}

// ================= 网页路由 =================

app.get("/", (req, res) => {
    const data = loadData();
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
            <title>TG 自动签到</title>
            <style>
                :root { 
                    --primary: #007aff; 
                    --bg: #f2f2f7; 
                    --card: #ffffff; 
                    --text: #1c1c1e; 
                    --text-sec: #8e8e93; 
                    --border: #e5e5ea; 
                    --input-bg: #f2f2f7;
                    --console-bg: #fafafa;
                }
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 12px; -webkit-font-smoothing: antialiased; }
                .container { max-width: 600px; margin: auto; }
                .card { background: var(--card); padding: 16px; border-radius: 16px; box-shadow: 0 2px 10px rgba(0,0,0,0.03); margin-bottom: 16px; border: 1px solid var(--border); }
                .card-title { margin: 0 0 12px 0; font-size: 17px; font-weight: 600; border-bottom: 1px solid var(--border); padding-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
                
                .console { background: var(--console-bg); color: var(--text); padding: 10px 14px; border-radius: 12px; height: 250px; overflow-y: auto; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; line-height: 1.6; word-wrap: break-word; border: 1px solid var(--border); }
                .log-item { padding: 4px 0; border-bottom: 1px solid var(--border); }
                .log-item:last-child { border-bottom: none; }
                
                input[type="text"], input[type="password"], input[type="number"] { padding: 12px; width: 100%; box-sizing: border-box; border: 1px solid var(--border); border-radius: 10px; margin-bottom: 10px; font-size: 15px; background: var(--input-bg); color: var(--text); outline: none; transition: border 0.2s; }
                input:focus { border-color: var(--primary); }
                .btn-primary { background: var(--primary); color: white; padding: 14px; border: none; border-radius: 10px; width: 100%; font-size: 16px; font-weight: 600; cursor: pointer; }
                .btn-action { padding: 6px 12px; border: none; border-radius: 8px; font-size: 13px; font-weight: 500; cursor: pointer; }
                .pill-btn { background: var(--primary); color: white; padding: 6px 14px; border-radius: 20px; font-size: 13px; font-weight: 600; border: none; cursor: pointer; }
                
                .account-card { border: 1px solid var(--border); background: var(--card); }
                .text-sec { color: var(--text-sec); }
                .custom-textarea { width:100%; padding:8px; border:1px solid var(--border); border-radius:8px; box-sizing:border-box; font-family:monospace; font-size:12px; background:var(--input-bg); color:var(--text); outline:none; margin-bottom:6px; }
                .custom-input { width:100%; padding:8px; border:1px solid var(--border); border-radius:8px; box-sizing:border-box; font-size:12px; background:var(--input-bg); color:var(--text); outline:none; }
                .session-textarea { width:100%; height:50px; font-size:11px; color:var(--text-sec); padding:8px; border:1px solid var(--border); border-radius:8px; box-sizing:border-box; background:var(--input-bg); outline:none; resize:none; }
                .empty-bot { color:var(--text-sec); font-size:13px; text-align:center; padding:10px; background:var(--input-bg); border-radius:8px; }
            </style>
        </head>
        <body>
            <div class="container">
                <h2 style="text-align: center; margin: 10px 0 20px 0; font-size: 20px;">🤖 TG 自动签到</h2>

                <div class="card">
                    <div class="card-title">
                        <span>🖥️ 运行日志</span>
                        <form action="/clear-logs" method="POST" class="ajax-form" style="margin:0;">
                            <button type="submit" class="pill-btn" style="background:#ff3b30;">清空</button>
                        </form>
                    </div>
                    <div class="console" id="console-box">加载中...</div>
                </div>

                <div class="card">
                    <div class="card-title">
                        <span>📋 账号</span>
                        <div style="display:flex; gap:8px;">
                            <button type="button" class="pill-btn" style="background:#34c759;" onclick="window.location.href='/api/backup'">备份</button>
                            <button type="button" class="pill-btn" style="background:#ff9500;" onclick="document.getElementById('restore-file').click()">导入</button>
                            <input type="file" id="restore-file" accept=".json" style="display:none;">
                            <form action="/run-all" method="POST" class="ajax-form" style="margin:0;">
                                <button type="submit" class="pill-btn">执行所有</button>
                            </form>
                        </div>
                    </div>
                    <div id="accounts-container">
                        ${renderAccountsHtml()}
                    </div>
                </div>

                <div class="card">
                    <div class="card-title">📱 手机号验证码登录</div>
                    <div id="login-step-1">
                        <form action="/send-code" method="POST" class="ajax-form" id="form-phone">
                            <input type="text" name="phone" placeholder="手机号 (带国家代码，如 +86...)" required>
                            <button type="submit" class="btn-primary">发送验证码</button>
                        </form>
                    </div>
                    <div id="login-step-2" style="display:none;">
                        <p style="font-size:13px; color:var(--text-sec); margin-top:0;">验证码已发送，请查收 Telegram 消息。</p>
                        <form action="/verify-code" method="POST" class="ajax-form" id="form-code">
                            <input type="text" name="code" placeholder="输入验证码" required>
                            <button type="submit" class="btn-primary">验证</button>
                        </form>
                    </div>
                    <div id="login-step-3" style="display:none;">
                        <p style="font-size:13px; color:#ff9500; margin-top:0;">账号已开启两步验证，请输入密码。</p>
                        <form action="/verify-password" method="POST" class="ajax-form" id="form-password">
                            <input type="password" name="password" placeholder="两步验证密码" required>
                            <button type="submit" class="btn-primary" style="background:#ff9500;">验证密码并登录</button>
                        </form>
                    </div>
                </div>

                <div class="card">
                    <div class="card-title">🔑 密钥(Session)直接登录</div>
                    <form action="/login-session" method="POST" class="ajax-form" id="form-session">
                        <input type="text" name="sessionString" placeholder="粘贴 Session 字符串..." required>
                        <button type="submit" class="btn-primary" style="background:#ff9500;">直接登录</button>
                    </form>
                </div>

                <div class="card">
                    <div class="card-title">⚙️ 保活机制 (防休眠)</div>
                    <form action="/save-keepalive" method="POST" class="ajax-form">
                        <input type="text" name="url" value="${data.keepAlive?.url || ''}" placeholder="应用网址 URL (留空关闭)">
                        <input type="number" name="interval" value="${data.keepAlive?.interval || 300}" min="60" placeholder="请求间隔(秒)" required>
                        <button type="submit" class="btn-primary" style="background:#5856d6;">保存设置</button>
                    </form>
                </div>
            </div>

            <script>
                // 复制 Session 文本
                function copyText(id, btn) {
                    var copyText = document.getElementById(id);
                    copyText.select();
                    copyText.setSelectionRange(0, 99999); 
                    document.execCommand("copy");
                    var oldText = btn.innerText;
                    btn.innerText = "已复制!";
                    setTimeout(function(){ btn.innerText = oldText; }, 2000);
                }

                // 导入配置逻辑
                document.getElementById('restore-file').addEventListener('change', function(e) {
                    const file = e.target.files[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = async function(event) {
                        try {
                            const json = JSON.parse(event.target.result);
                            if(!confirm("⚠️ 警告：导入将覆盖当前所有配置和账号！确定要继续吗？")) {
                                e.target.value = '';
                                return;
                            }
                            const res = await fetch('/api/restore', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(json)
                            });
                            const data = await res.json();
                            if (data.success) {
                                alert("✅ 配置恢复成功！");
                                location.reload();
                            } else {
                                alert("❌ 恢复失败: " + data.error);
                            }
                        } catch(err) {
                            alert("❌ 文件解析失败，请确保是有效的 JSON 备份文件");
                        }
                        e.target.value = '';
                    };
                    reader.readAsText(file);
                });

                document.addEventListener('submit', async function(e) {
                    const form = e.target;
                    if (form.classList.contains('normal-form')) return; 
                    
                    // 防误删确认逻辑
                    const confirmMsg = form.getAttribute('data-confirm');
                    if (confirmMsg && !confirm(confirmMsg)) {
                        e.preventDefault();
                        return;
                    }

                    e.preventDefault();
                    const submitBtn = form.querySelector('button[type="submit"]');
                    const originalHTML = submitBtn.innerHTML;
                    const originalBg = submitBtn.style.background;
                    
                    submitBtn.innerHTML = '⏳...';
                    submitBtn.disabled = true;

                    try {
                        const formData = new URLSearchParams(new FormData(form));
                        const response = await fetch(form.action, {
                            method: form.method,
                            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                            body: formData
                        });
                        
                        const contentType = response.headers.get("content-type");
                        if (contentType && contentType.indexOf("application/json") !== -1) {
                            const resData = await response.json();
                            
                            // 处理获取验证码的特殊弹窗
                            if (form.action.includes('/get-tg-code')) {
                                if (resData.success) {
                                    alert("📩 最新验证码消息:\\n\\n" + resData.message);
                                } else {
                                    alert("❌ 获取失败: " + resData.error);
                                }
                                submitBtn.innerHTML = originalHTML;
                                submitBtn.disabled = false;
                                return; 
                            }

                            // 处理无刷新登录流程
                            if (form.id === 'form-phone' || form.id === 'form-code' || form.id === 'form-password' || form.id === 'form-session') {
                                if (!resData.success) {
                                    if (resData.needPassword) {
                                        document.getElementById('login-step-2').style.display = 'none';
                                        document.getElementById('login-step-3').style.display = 'block';
                                    } else {
                                        alert("❌ 错误: " + resData.error);
                                    }
                                    submitBtn.innerHTML = originalHTML;
                                    submitBtn.disabled = false;
                                    return;
                                } else {
                                    if (form.id === 'form-phone') {
                                        document.getElementById('login-step-1').style.display = 'none';
                                        document.getElementById('login-step-2').style.display = 'block';
                                        submitBtn.innerHTML = originalHTML;
                                        submitBtn.disabled = false;
                                        return;
                                    } else {
                                        // 最终登录成功
                                        document.getElementById('login-step-1').style.display = 'block';
                                        document.getElementById('login-step-2').style.display = 'none';
                                        document.getElementById('login-step-3').style.display = 'none';
                                        form.reset();
                                        if(document.getElementById('form-phone')) document.getElementById('form-phone').reset();
                                        alert("✅ 登录成功！");
                                    }
                                }
                            } else if (form.action.includes('/clear-logs')) {
                                // 清空日志不需要弹窗报错
                            } else {
                                // 其他普通操作的报错提示
                                if (!resData.success) {
                                    alert("❌ 操作失败: " + (resData.error || "未知错误"));
                                }
                            }
                        }
                        
                        await refreshAccounts();
                        
                        submitBtn.innerHTML = '✅';
                        submitBtn.style.background = '#34c759';
                        submitBtn.style.color = '#fff';
                        setTimeout(() => {
                            submitBtn.innerHTML = originalHTML;
                            submitBtn.style.background = originalBg;
                            submitBtn.disabled = false;
                        }, 1500);
                    } catch (err) {
                        alert("❌ 网络请求失败");
                        submitBtn.innerHTML = '❌';
                        setTimeout(() => {
                            submitBtn.innerHTML = originalHTML;
                            submitBtn.disabled = false;
                        }, 1500);
                    }
                });

                async function refreshAccounts() {
                    try {
                        const res = await fetch('/api/accounts-html');
                        const html = await res.text();
                        document.getElementById('accounts-container').innerHTML = html;
                    } catch (e) {}
                }

                async function fetchLogs() {
                    try {
                        const res = await fetch('/api/logs');
                        const data = await res.json();
                        const consoleBox = document.getElementById('console-box');
                        // 渲染带分割线的日志
                        const newHtml = data.logs.map(log => '<div class="log-item">' + log + '</div>').join('');
                        if (consoleBox.innerHTML !== newHtml) {
                            consoleBox.innerHTML = newHtml;
                            consoleBox.scrollTop = consoleBox.scrollHeight;
                        }
                    } catch (e) {}
                }
                setInterval(fetchLogs, 2000);
                fetchLogs();
            </script>
        </body>
        </html>
    `);
});

// ================= API 路由 =================

app.get("/api/logs", (req, res) => {
    res.json({ logs: logHistory.map(l => l.text) });
});

app.post("/clear-logs", (req, res) => {
    logHistory = [];
    addLog("🗑️ 日志已手动清空。");
    res.json({ success: true });
});

app.get("/api/accounts-html", (req, res) => {
    res.send(renderAccountsHtml());
});

app.get("/api/backup", (req, res) => {
    const data = loadData();
    res.setHeader('Content-disposition', 'attachment; filename=tg-signer-backup.json');
    res.setHeader('Content-type', 'application/json');
    res.send(JSON.stringify(data, null, 2));
});

app.post("/api/restore", (req, res) => {
    try {
        const newData = req.body;
        if (newData && Array.isArray(newData.accounts)) {
            saveData(newData);
            addLog("💾 配置已从备份文件恢复！");
            startKeepAlive(); 
            res.json({ success: true });
        } else {
            res.json({ success: false, error: "无效的备份文件格式" });
        }
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// ================= 登录与数据操作逻辑 (AJAX 响应) =================

// 获取官方验证码 API
app.post("/get-tg-code", async (req, res) => {
    const phone = req.body.phone;
    const data = loadData();
    const account = data.accounts.find(a => a.phone === phone);
    if (!account) return res.json({ success: false, error: "账号不存在" });

    addLog(`[${maskPhone(phone)}] 正在连接并获取官方登录验证码...`);
    const client = new TelegramClient(new StringSession(account.session), data.settings.apiId, data.settings.apiHash, getDeviceConfig());
    
    try {
        await client.connect();
        // 777000 是 Telegram 官方服务账号的固定 ID
        const messages = await client.getMessages(777000, { limit: 3 });
        if (messages.length > 0) {
            const latestMsg = messages[0].message;
            addLog(`[${maskPhone(phone)}] ✅ 成功获取验证码消息`);
            res.json({ success: true, message: latestMsg });
        } else {
            res.json({ success: false, error: "未找到来自 Telegram 官方的消息，请确保验证码已发送" });
        }
    } catch (error) {
        addLog(`[${maskPhone(phone)}] ❌ 获取验证码失败: ${error.message}`);
        res.json({ success: false, error: error.message });
    } finally {
        await client.destroy();
    }
});

app.post("/save-keepalive", (req, res) => {
    let data = loadData();
    const url = req.body.url.trim();
    const interval = parseInt(req.body.interval) || 300;
    data.keepAlive = { url: url, interval: interval, enabled: url.length > 0 };
    saveData(data);
    addLog(`⚙️ 保活设置已更新: ${url ? '启用' : '禁用'}`);
    startKeepAlive(); 
    res.json({ success: true });
});

app.post("/update-steps", (req, res) => {
    let data = loadData();
    let account = data.accounts.find(a => a.phone === req.body.phone);
    if (account) {
        let bot = account.bots.find(b => b.username === req.body.bot);
        if (bot) {
            const stepsStr = req.body.stepsStr || "";
            const newSteps = [];
            stepsStr.split('\n').forEach(line => {
                line = line.trim();
                if (line.startsWith('发送:')) {
                    newSteps.push({ type: 'send', text: line.substring(3).trim() });
                } else if (line.startsWith('点击:')) {
                    newSteps.push({ type: 'click', text: line.substring(3).trim() });
                } else if (line.startsWith('小程序:')) {
                    let content = line.substring(4).trim();
                    if (content.startsWith('{')) {
                        try {
                            let config = JSON.parse(content);
                            newSteps.push({ type: 'webapp_json', config: config });
                        } catch (e) {
                            addLog(`⚠️ JSON 解析失败，请检查格式: ${e.message}`);
                        }
                    } else {
                        const parts = content.split('|');
                        if (parts.length >= 2) {
                            newSteps.push({ type: 'webapp', webAppUrl: parts[0].trim(), apiUrl: parts[1].trim() });
                        }
                    }
                }
            });
            bot.steps = newSteps.length > 0 ? newSteps : [...defaultSteps];
            bot.checkKeywords = req.body.checkKeywords || "";
            saveData(data);
            addLog(`⚙️ 已更新 ${bot.name} 的自定义签到步骤与检测配置。`);
        }
    }
    res.json({ success: true });
});

app.post("/add-bot", (req, res) => {
    let data = loadData();
    let account = data.accounts.find(a => a.phone === req.body.phone);
    let botUsername = req.body.botUsername.trim();
    let customName = req.body.customName ? req.body.customName.trim() : botUsername;
    
    if (account && botUsername) {
        if (!botUsername.startsWith("@")) botUsername = "@" + botUsername;
        if (!account.bots.find(b => b.username === botUsername)) {
            account.bots.push({
                username: botUsername,
                name: customName, 
                nextRunTime: Date.now(),
                steps: [...defaultSteps],
                checkKeywords: "",
                retryCount: 0,
                lastStatus: 'pending',
                lastSuccessTime: 0
            });
            saveData(data);
            addLog(`➕ 账号 ${maskPhone(account.phone)} 添加了机器人: ${customName}`);
        }
    }
    res.json({ success: true });
});

app.post("/remove-bot", (req, res) => {
    let data = loadData();
    let account = data.accounts.find(a => a.phone === req.body.phone);
    if (account) {
        account.bots = account.bots.filter(b => b.username !== req.body.bot);
        saveData(data);
        addLog(`➖ 账号 ${maskPhone(account.phone)} 移除了机器人: ${req.body.bot}`);
    }
    res.json({ success: true });
});

app.post("/delete-account", (req, res) => {
    let data = loadData();
    data.accounts = data.accounts.filter(a => a.phone !== req.body.phone);
    saveData(data);
    addLog(`🗑️ 已退出并删除账号: ${maskPhone(req.body.phone)}`);
    res.json({ success: true });
});

app.post("/run-all", async (req, res) => {
    addLog("▶️ 手动触发了全员签到任务！");
    res.json({ success: true });
    const data = loadData();
    for (const account of data.accounts) {
        await runCheckinForAccount(account.phone, true);
    }
});

app.post("/run-account", async (req, res) => {
    addLog(`▶️ 手动触发了单账号签到任务: ${maskPhone(req.body.phone)}！`);
    res.json({ success: true });
    await runCheckinForAccount(req.body.phone, true);
});

app.post("/run-single-bot", async (req, res) => {
    addLog(`▶️ 手动触发了单机器人测试: ${req.body.bot}！`);
    res.json({ success: true });
    await runCheckinForAccount(req.body.phone, true, req.body.bot);
});

app.post("/login-session", async (req, res) => {
    const sessionStr = req.body.sessionString.trim();
    const data = loadData();
    addLog(`尝试使用提供的 Session 密钥登录...`);
    
    const client = new TelegramClient(new StringSession(sessionStr), data.settings.apiId, data.settings.apiHash, getDeviceConfig());
    try {
        await client.connect();
        const me = await client.getMe();
        const phone = "+" + me.phone;
        
        if (!data.accounts.find(a => a.phone === phone)) {
            data.accounts.push({ phone: phone, session: sessionStr, bots: [] });
            saveData(data);
        }
        addLog(`✅ 密钥登录成功！识别到账号: ${maskPhone(phone)}`);
        res.json({ success: true });
    } catch (error) {
        addLog(`❌ 密钥登录失败: ${error.message}`);
        res.json({ success: false, error: "密钥无效或已过期: " + error.message });
    } finally {
        await client.destroy();
    }
});

// ================= 终极无敌版登录状态机 =================
const loginEmitter = new EventEmitter();
let loginState = {
    client: null,
    phone: "",
    resolvePhoneCode: null,
    resolvePassword: null
};

app.post("/send-code", async (req, res) => {
    const data = loadData();
    loginState.phone = req.body.phone.trim();
    loginState.client = new TelegramClient(new StringSession(""), data.settings.apiId, data.settings.apiHash, getDeviceConfig());
    
    // 启动后台登录流程
    loginState.client.start({
        phoneNumber: loginState.phone,
        phoneCode: async () => {
            loginEmitter.emit('waiting_code');
            return new Promise(resolve => { loginState.resolvePhoneCode = resolve; });
        },
        password: async () => {
            loginEmitter.emit('waiting_password');
            return new Promise(resolve => { loginState.resolvePassword = resolve; });
        },
        onError: (err) => {
            loginEmitter.emit('error', err.message);
        }
    }).then(async () => {
        loginEmitter.emit('success');
        const sessionString = loginState.client.session.save();
        let currentData = loadData();
        if (!currentData.accounts.find(a => a.phone === loginState.phone)) {
            currentData.accounts.push({ phone: loginState.phone, session: sessionString, bots: [] });
            saveData(currentData);
        }
        addLog(`✅ 手机号登录成功并已保存！`);
        await loginState.client.destroy();
        loginState.client = null;
    }).catch(async err => {
        loginEmitter.emit('error', err.message);
        if (loginState.client) {
            await loginState.client.destroy();
            loginState.client = null;
        }
    });

    // 监听事件并返回给前端
    let timeout;
    const onWaitingCode = () => { cleanup(); res.json({ success: true }); };
    const onError = (msg) => { cleanup(); res.json({ success: false, error: msg }); };
    
    function cleanup() {
        clearTimeout(timeout);
        loginEmitter.removeListener('waiting_code', onWaitingCode);
        loginEmitter.removeListener('error', onError);
    }
    
    timeout = setTimeout(() => { cleanup(); res.json({ success: false, error: "请求超时，请重试" }); }, 30000);
    loginEmitter.once('waiting_code', onWaitingCode);
    loginEmitter.once('error', onError);
});

app.post("/verify-code", async (req, res) => {
    const code = req.body.code.trim();
    if (!loginState.resolvePhoneCode) return res.json({ success: false, error: "未在等待验证码" });

    let timeout;
    const onWaitingPassword = () => { cleanup(); res.json({ success: false, needPassword: true }); };
    const onSuccess = () => { cleanup(); res.json({ success: true }); };
    const onError = (msg) => { cleanup(); res.json({ success: false, error: msg }); };
    const onWaitingCodeAgain = () => { cleanup(); res.json({ success: false, error: "验证码错误，请重新输入" }); };

    function cleanup() {
        clearTimeout(timeout);
        loginEmitter.removeListener('waiting_password', onWaitingPassword);
        loginEmitter.removeListener('success', onSuccess);
        loginEmitter.removeListener('error', onError);
        loginEmitter.removeListener('waiting_code', onWaitingCodeAgain);
    }

    timeout = setTimeout(() => { cleanup(); res.json({ success: false, error: "请求超时，请重试" }); }, 30000);
    loginEmitter.once('waiting_password', onWaitingPassword);
    loginEmitter.once('success', onSuccess);
    loginEmitter.once('error', onError);
    loginEmitter.once('waiting_code', onWaitingCodeAgain); // 如果密码错误，底层会再次触发要验证码

    loginState.resolvePhoneCode(code);
});

app.post("/verify-password", async (req, res) => {
    const password = req.body.password; 
    if (!loginState.resolvePassword) return res.json({ success: false, error: "未在等待密码" });

    let timeout;
    const onSuccess = () => { cleanup(); res.json({ success: true }); };
    const onError = (msg) => { cleanup(); res.json({ success: false, error: msg }); };
    const onWaitingPasswordAgain = () => { cleanup(); res.json({ success: false, error: "密码错误，请重新输入" }); };

    function cleanup() {
        clearTimeout(timeout);
        loginEmitter.removeListener('success', onSuccess);
        loginEmitter.removeListener('error', onError);
        loginEmitter.removeListener('waiting_password', onWaitingPasswordAgain);
    }

    timeout = setTimeout(() => { cleanup(); res.json({ success: false, error: "请求超时，请重试" }); }, 30000);
    loginEmitter.once('success', onSuccess);
    loginEmitter.once('error', onError);
    loginEmitter.once('waiting_password', onWaitingPasswordAgain); // 如果密码错误，底层会再次触发要密码

    loginState.resolvePassword(password);
});

// ================= 定时任务 =================
let isRunning = false;
setInterval(async () => {
    if (isRunning) return; 
    isRunning = true;
    try {
        const data = loadData();
        for (const account of data.accounts) {
            await runCheckinForAccount(account.phone, false);
        }
    } finally {
        isRunning = false;
    }
}, 60 * 1000);

app.listen(port, async () => {
    addLog(`🚀 控制台服务已启动，监听端口 ${port}`);
    startKeepAlive();
    await importSessionsFromEnv();
});
