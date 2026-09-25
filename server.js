const express = require("express");
const http = require("http");
const https = require("https");
const EventEmitter = require("events");
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");

const utils = require("./utils");
const {
    addLog,
    getLogs,
    clearLogs,
    maskPhone,
    getPhoneHash,
    getPasswordHash,
    loadData,
    saveData,
    getDeviceConfig,
    getNextAvailableDeviceIndex,
    getNextRandomTime,
    defaultSteps,
    dataEmitter
} = utils;

const {
    renderAccountsHtml,
    renderBotsHtml,
    renderMainHtml
} = require("./views");

const {
    runCheckinForAccount,
    runRenewForAccount,
    importSessionsFromEnv,
    runningAccounts
} = require("./telegram");

const app = express();
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.json({ limit: '50mb' }));

app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({ success: false, error: "请求格式错误" });
    }
    next(err);
});

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

const port = process.env.PORT || 3000;
const webPassword = process.env.WEB_PASSWORD || ""; 
const aiEndpoint = process.env.AI_ENDPOINT || process.env.OPENAI_BASE_URL || "";
const aiKey = process.env.AI_KEY || process.env.OPENAI_API_KEY || "";

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

app.use((req, res, next) => {
    if (!webPassword) return next(); 
    if (req.path === '/web-login') return next(); 

    const cookies = req.headers.cookie || "";
    const expectedCookie = `auth=${getPasswordHash(webPassword)}`;
    if (cookies.includes(expectedCookie)) return next(); 

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
        const hash = getPasswordHash(webPassword);
        res.setHeader('Set-Cookie', `auth=${hash}; Max-Age=2592000; HttpOnly; SameSite=None; Secure`); 
        res.redirect('/');
    } else {
        res.send('<script>alert("❌ 密码错误！");window.location.href="/";</script>');
    }
});

app.get("/", (req, res) => {
    res.send(renderMainHtml());
});

app.get("/api/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const onDataChanged = () => {
        res.write("data: refresh\n\n");
    };

    dataEmitter.on("dataChanged", onDataChanged);

    req.on("close", () => {
        dataEmitter.removeListener("dataChanged", onDataChanged);
    });
});

app.get("/api/logs", (req, res) => {
    res.json({ logs: getLogs().map(l => l.text) });
});

app.post("/clear-logs", (req, res) => {
    clearLogs();
    addLog("🗑️ 日志已手动清空。");
    res.json({ success: true });
});

app.get("/api/accounts-html", (req, res) => {
    res.send(renderAccountsHtml());
});

app.get("/api/bots-html", (req, res) => {
    res.send(renderBotsHtml());
});

app.get("/api/backup", (req, res) => {
    res.status(405).send("❌ 请使用 POST 请求并携带密码进行备份");
});

app.post("/api/backup", (req, res) => {
    const pwd = req.body.password;
    if (webPassword && pwd !== webPassword) {
        addLog("❌ 备份失败: 密码验证未通过");
        return res.status(403).send("❌ 密码错误，拒绝访问");
    }
    try {
        const data = loadData();
        res.setHeader('Content-disposition', 'attachment; filename=tg-signer-backup.json');
        res.setHeader('Content-type', 'application/json');
        res.send(JSON.stringify(data, null, 2));
        addLog("💾 备份数据下载成功");
    } catch (e) {
        addLog(`❌ 备份生成失败: ${e.message}`);
        res.status(500).send(`❌ 备份生成失败: ${e.message}`);
    }
});

app.post("/api/get-session", (req, res) => {
    const { phoneHash, password } = req.body;
    if (webPassword && password !== webPassword) {
        addLog(`❌ 获取 Session 失败: 密码验证未通过`);
        return res.json({ success: false, error: "密码错误" });
    }
    try {
        const data = loadData();
        const acc = data.accounts.find(a => getPhoneHash(a.phone) === phoneHash);
        if (!acc) {
            return res.json({ success: false, error: "账号不存在" });
        }
        addLog(`🔑 成功获取并复制了账号 ${maskPhone(acc.phone)} 的 Session 密钥`);
        res.json({ success: true, session: acc.session });
    } catch (e) {
        addLog(`❌ 获取 Session 异常: ${e.message}`);
        res.json({ success: false, error: e.message });
    }
});

app.post("/api/restore", (req, res) => {
    try {
        const newData = req.body;
        if (!newData || !Array.isArray(newData.accounts)) {
            return res.json({ success: false, error: "无效的备份文件格式" });
        }
        
        if (!Array.isArray(newData.bots)) newData.bots = [];
        if (!newData.settings) newData.settings = { apiId: 2040, apiHash: "b18441a1ff607e10a989891a5462e627" };
        if (!newData.aiSettings) newData.aiSettings = { model1: "", model2: "", model3: "" };
        if (!newData.keepAlive) newData.keepAlive = { url: "", interval: 300, enabled: false };

        saveData(newData);
        addLog("💾 配置已从备份文件恢复！");
        startKeepAlive(); 
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.post("/api/fetch-models", async (req, res) => {
    if (!aiEndpoint || !aiKey) {
        return res.json({ success: false, error: "未配置 AI_ENDPOINT 或 AI_KEY 环境变量" });
    }
    try {
        const url = `${aiEndpoint.replace(/\/$/, '')}/models`;
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${aiKey}`
            }
        });
        if (!response.ok) {
            const errText = await response.text();
            return res.json({ success: false, error: `HTTP ${response.status}: ${errText}` });
        }
        const data = await response.json();
        let models = [];
        if (data && Array.isArray(data.data)) {
            models = data.data.map(m => m.id);
        } else if (data && Array.isArray(data.models)) {
            models = data.models.map(m => m.id || m);
        } else if (Array.isArray(data)) {
            models = data.map(m => m.id || m);
        } else {
            return res.json({ success: false, error: "格式不匹配" });
        }
        res.json({ success: true, models: models });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.post("/get-tg-code", async (req, res) => {
    const phoneHash = req.body.phoneHash;
    const data = loadData();
    const account = data.accounts.find(a => getPhoneHash(a.phone) === phoneHash);
    if (!account) return res.json({ success: false, error: "账号不存在" });
    
    const phone = account.phone;
    if (runningAccounts.has(phone)) {
        return res.json({ success: false, error: "该账号正在运行签到任务，请稍后再试" });
    }

    const apiId = Number(data.settings.apiId);
    if (!Number.isInteger(apiId) || apiId <= 0) {
        return res.json({ success: false, error: "Telegram API ID 配置无效" });
    }

    const deviceConf = getDeviceConfig(phone);
    addLog(`[${maskPhone(phone)}] 正在连接并获取官方登录验证码...`);
    const client = new TelegramClient(new StringSession(account.session), apiId, data.settings.apiHash, deviceConf);
    
    try {
        await client.connect();
        const messages = await client.getMessages(777000, { limit: 3 });
        if (messages.length > 0) {
            const latestMsg = messages[0].message;
            try {
                await client.invoke(new Api.messages.ReadHistory({ peer: 777000, maxId: 0 }));
            } catch (readErr) {}
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

app.post("/save-aisettings", (req, res) => {
    let data = loadData();
    data.aiSettings = {
        model1: req.body.model1 || "",
        model2: req.body.model2 || "",
        model3: req.body.model3 || ""
    };
    saveData(data);
    addLog(`⚙️ AI 验证助手设置已更新`);
    res.json({ success: true });
});

app.post("/update-bot-accounts", (req, res) => {
    let data = loadData();
    let bot = data.bots.find(b => b.username === req.body.bot);
    if (bot) {
        let submittedAccounts = req.body.enabledAccounts;
        let hashes = [];
        if (!submittedAccounts) {
            hashes = [];
        } else if (Array.isArray(submittedAccounts)) {
            hashes = submittedAccounts;
        } else {
            hashes = [submittedAccounts];
        }

        let enabledPhones = hashes.map(hash => {
            const acc = data.accounts.find(a => getPhoneHash(a.phone) === hash);
            return acc ? acc.phone : null;
        }).filter(Boolean);

        bot.enabledAccounts = enabledPhones;

        if (!bot.states) bot.states = {};
        bot.enabledAccounts.forEach(phone => {
            if (!bot.states[phone]) {
                const checkinInterval = bot.checkinIntervalDays || 1;
                bot.states[phone] = {
                    nextRunTime: getNextRandomTime(checkinInterval),
                    retryCount: 0,
                    todayRetryCount: 0,
                    lastRetryDate: "",
                    lastStatus: 'pending',
                    lastSuccessTime: 0,
                    lastRenewDate: "",
                    lastRenewStatus: 'pending'
                };
                addLog(`[🤖 ${bot.name}] ➕ 为账号 ${maskPhone(phone)} 分配任务，跳过当天并在明天随机时间首次签到`);
            }
        });

        Object.keys(bot.states).forEach(phone => {
            if (!bot.enabledAccounts.includes(phone)) {
                delete bot.states[phone];
            }
        });

        saveData(data);
        addLog(`⚙️ 已更新机器人 ${bot.name} 的运行账号列表`);
    }
    res.json({ success: true });
});

function parseStepsFromText(stepsStr) {
    const newSteps = [];
    (stepsStr || "").split('\n').forEach(line => {
        line = line.trim();
        if (line.startsWith('发送并撤回:')) {
            newSteps.push({ type: 'send_delete', text: line.substring(6).trim() });
        } else if (line.startsWith('发送撤回:')) {
            newSteps.push({ type: 'send_delete', text: line.substring(5).trim() });
        } else if (line.startsWith('发送:')) {
            newSteps.push({ type: 'send', text: line.substring(3).trim() });
        } else if (line.startsWith('点击:')) {
            newSteps.push({ type: 'click', text: line.substring(3).trim() });
        } else if (line.startsWith('Ai识别') || line.startsWith('AI识别')) {
            newSteps.push({ type: 'ai_captcha' });
        } else if (line.startsWith('小程序:') || line.startsWith('小程序：')) {
            let content = line.substring(4).trim();
            if (content === '开启') {
                newSteps.push({ type: 'miniapp_open' });
            } else if (content.startsWith('{')) {
                try {
                    let config = JSON.parse(content);
                    newSteps.push({ type: 'webapp_json', config: config });
                } catch (e) {
                    addLog(`⚠️ JSON 解析失败，请检查格式: ${e.message}`);
                }
            } else if (content.includes('|')) {
                const parts = content.split('|');
                if (parts.length >= 2) {
                    newSteps.push({ type: 'webapp', webAppUrl: parts[0].trim(), apiUrl: parts[1].trim() });
                }
            } else {
                newSteps.push({ type: 'miniapp_open', text: content });
            }
        }
    });
    return newSteps;
}

app.post("/update-bot-config", (req, res) => {
    let data = loadData();
    let bot = data.bots.find(b => b.username === req.body.bot);
    if (bot) {
        let newUsername = req.body.botUsername.trim();
        if (!newUsername.startsWith("@")) {
            newUsername = "@" + newUsername;
        }
        
        const isDuplicate = data.bots.some(b => b.username === newUsername && b.username !== bot.username);
        if (isDuplicate) {
            return res.json({ success: false, error: "该用户名已存在，请勿重复添加" });
        }

        const oldUsername = bot.username;
        bot.username = newUsername;
        bot.name = req.body.botName ? req.body.botName.trim() : newUsername;
        bot.checkinIntervalDays = Math.max(1, parseInt(req.body.checkinIntervalDays) || 1);
        bot.renewIntervalDays = Math.max(0, parseInt(req.body.renewIntervalDays) || 0);

        const parsedSteps = parseStepsFromText(req.body.stepsStr);
        bot.steps = parsedSteps.length > 0 ? parsedSteps : [...defaultSteps];

        bot.renewSteps = parseStepsFromText(req.body.renewStepsStr);
        bot.checkKeywords = req.body.checkKeywords || "";
        
        saveData(data);
        addLog(`⚙️ 已更新机器人配置: ${oldUsername} -> ${newUsername} (${bot.name})`);
    }
    res.json({ success: true });
});

app.post("/add-bot", (req, res) => {
    let data = loadData();
    let botUsername = req.body.botUsername.trim();
    let customName = req.body.customName ? req.body.customName.trim() : botUsername;
    
    if (botUsername) {
        if (!botUsername.startsWith("@")) {
            botUsername = "@" + botUsername;
        }
        if (!data.bots) data.bots = [];
        if (!data.bots.find(b => b.username === botUsername)) {
            data.bots.push({
                username: botUsername,
                name: customName, 
                steps: [...defaultSteps],
                checkinIntervalDays: 1,
                renewIntervalDays: 0,
                renewSteps: [],
                checkKeywords: "",
                enabledAccounts: [],
                states: {}
            });
            saveData(data);
            addLog(`➕ 添加了全局机器人: ${customName}`);
        } else {
            return res.json({ success: false, error: "该机器人已存在" });
        }
    }
    res.json({ success: true });
});

app.post("/remove-bot", (req, res) => {
    let data = loadData();
    if (data.bots) {
        data.bots = data.bots.filter(b => b.username !== req.body.bot);
        saveData(data);
        addLog(`➖ 移除了全局机器人: ${req.body.bot}`);
    }
    res.json({ success: true });
});

app.post("/delete-account", async (req, res) => {
    const phoneHash = req.body.phoneHash;
    let data = loadData();
    const account = data.accounts.find(a => getPhoneHash(a.phone) === phoneHash);
    if (!account) return res.json({ success: false, error: "账号不存在" });
    
    const phone = account.phone;
    const maskedPhone = maskPhone(phone);
    const apiId = Number(data.settings.apiId);
    
    if (Number.isInteger(apiId) && apiId > 0 && account.session) {
        addLog(`📱 [${maskedPhone}] 正在尝试向 Telegram 服务器发送登出请求...`);
        const deviceConf = getDeviceConfig(phone);
        const client = new TelegramClient(new StringSession(account.session), apiId, data.settings.apiHash, deviceConf);
        try {
            await client.connect();
            await client.invoke(new Api.auth.LogOut());
            addLog(`✅ [${maskedPhone}] Telegram 官方会话已成功退出`);
        } catch (err) {
            addLog(`⚠️ [${maskedPhone}] 远程退出会话失败或已失效: ${err.message}`);
        } finally {
            try {
                await client.destroy();
            } catch (e) {}
        }
    }

    data = loadData();
    data.accounts = data.accounts.filter(a => a.phone !== phone);
    
    if (data.bots) {
        data.bots.forEach(bot => {
            if (bot.enabledAccounts) {
                bot.enabledAccounts = bot.enabledAccounts.filter(p => p !== phone);
            }
            if (bot.states && bot.states[phone]) {
                delete bot.states[phone];
            }
        });
    }
    
    saveData(data);
    addLog(`🗑️ 已彻底退出并删除账号: ${maskedPhone}`);
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
    const phoneHash = req.body.phoneHash;
    const data = loadData();
    const account = data.accounts.find(a => getPhoneHash(a.phone) === phoneHash);
    if (!account) return res.json({ success: false, error: "账号不存在" });

    addLog(`▶️ 手动触发了单账号签到任务: ${maskPhone(account.phone)}！`);
    res.json({ success: true });
    await runCheckinForAccount(account.phone, true);
});

app.post("/run-single-bot", async (req, res) => {
    const phoneHash = req.body.phoneHash;
    const data = loadData();
    const account = data.accounts.find(a => getPhoneHash(a.phone) === phoneHash);
    if (!account) return res.json({ success: false, error: "账号不存在" });

    addLog(`▶️ 手动触发了单机器人测试: ${req.body.bot} (账号: ${maskPhone(account.phone)})！`);
    res.json({ success: true });
    await runCheckinForAccount(account.phone, true, req.body.bot);
});

app.post("/run-single-renew", async (req, res) => {
    const phoneHash = req.body.phoneHash;
    const data = loadData();
    const account = data.accounts.find(a => getPhoneHash(a.phone) === phoneHash);
    if (!account) return res.json({ success: false, error: "账号不存在" });

    addLog(`▶️ 手动触发了单机器人续费测试: ${req.body.bot} (账号: ${maskPhone(account.phone)})！`);
    res.json({ success: true });
    await runRenewForAccount(account.phone, req.body.bot);
});

app.post("/login-session", async (req, res) => {
    const sessionStr = req.body.sessionString.trim();
    let data = loadData();
    addLog(`尝试使用提供的 Session 密钥登录...`);
    
    const apiId = Number(data.settings.apiId);
    if (!Number.isInteger(apiId) || apiId <= 0) {
        return res.json({ success: false, error: "Telegram API ID 配置无效" });
    }

    const freeIdx = getNextAvailableDeviceIndex();
    const deviceConf = getDeviceConfig();
    const tempClient = new TelegramClient(new StringSession(sessionStr), apiId, data.settings.apiHash, deviceConf);
    try {
        await tempClient.connect();
        const me = await tempClient.getMe();
        const phone = "+" + me.phone;
        
        data = loadData();
        if (!data.accounts.find(a => a.phone === phone)) {
            const assignedDevice = getDeviceConfig(phone);
            data.accounts.push({ phone: phone, session: sessionStr, deviceIndex: assignedDevice.deviceIndex });
            saveData(data);
            addLog(`✅ 密钥登录成功！识别到账号: ${maskPhone(phone)}，已分配独立设备: ${assignedDevice.deviceModel}`);
        } else {
            addLog(`✅ 密钥登录成功！账号已存在: ${maskPhone(phone)}`);
        }
        res.json({ success: true });
    } catch (error) {
        addLog(`❌ 密钥登录失败: ${error.message}`);
        res.json({ success: false, error: "密钥无效或已过期: " + error.message });
    } finally {
        await tempClient.destroy();
    }
});

const loginEmitter = new EventEmitter();
let loginState = {
    client: null,
    phone: "",
    resolvePhoneCode: null,
    resolvePassword: null
};

app.post("/send-code", async (req, res) => {
    const data = loadData();
    if (loginState.client) {
        try {
            await loginState.client.destroy();
        } catch (e) {}
        loginState.client = null;
    }
    loginState.phone = req.body.phone.trim();
    
    const apiId = Number(data.settings.apiId);
    if (!Number.isInteger(apiId) || apiId <= 0) {
        return res.json({ success: false, error: "Telegram API ID 配置无效" });
    }

    const deviceConf = getDeviceConfig(loginState.phone);
    loginState.client = new TelegramClient(new StringSession(""), apiId, data.settings.apiHash, deviceConf);
    
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
            const devConf = getDeviceConfig(loginState.phone);
            currentData.accounts.push({ phone: loginState.phone, session: sessionString, deviceIndex: devConf.deviceIndex });
            saveData(currentData);
            addLog(`✅ 手机号登录成功！分配独立设备: ${devConf.deviceModel}`);
        }
        await loginState.client.destroy();
        loginState.client = null;
    }).catch(async err => {
        loginEmitter.emit('error', err.message);
        if (loginState.client) {
            await loginState.client.destroy();
            loginState.client = null;
        }
    });

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
    loginEmitter.once('waiting_code', onWaitingCodeAgain);

    const resolve = loginState.resolvePhoneCode;
    loginState.resolvePhoneCode = null;
    resolve(code);
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
    loginEmitter.once('waiting_password', onWaitingPasswordAgain);

    const resolve = loginState.resolvePassword;
    loginState.resolvePassword = null;
    resolve(password);
});

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

async function startApp() {
    if (utils && typeof utils.initDatabase === 'function') {
        try {
            await utils.initDatabase();
        } catch (e) {
            addLog(`⚠️ 数据库初始化异常: ${e.message}`);
        }
    }
    app.listen(port, async () => {
        addLog(`🚀 控制台服务已启动，监听端口 ${port}`);
        startKeepAlive();
        await importSessionsFromEnv();
    });
}

startApp();
