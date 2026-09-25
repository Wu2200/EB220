const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const EventEmitter = require("events");
const { Pool } = require("pg");

const dataEmitter = new EventEmitter();
const dataDir = fs.existsSync("/data") ? "/data" : __dirname;
const dataFile = path.join(dataDir, "data.json");

let globalData = null;
let logHistory = [];
const MAX_LOGS = 200;

const originalConsoleLog = console.log;

function addLog(msg) {
    const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const logStr = `[${time}] ${msg}`;
    originalConsoleLog(logStr);
    logHistory.push({ timestamp: Date.now(), text: logStr });
    if (logHistory.length > MAX_LOGS) logHistory.shift();
}

function getLogs() {
    return logHistory;
}

function clearLogs() {
    logHistory.length = 0;
}

function maskPhone(phone) {
    if (!phone || phone.length < 8) return phone;
    return phone.substring(0, 4) + '****' + phone.substring(phone.length - 4);
}

function getPhoneHash(phone) {
    return crypto.createHash('sha256').update(phone).digest('hex');
}

function getPasswordHash(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

function getBjDateString(timestamp = Date.now()) {
    return new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().split('T')[0];
}

function getDaysDiffBj(olderDateStr, newerDateStr) {
    if (!olderDateStr || !newerDateStr) return 9999;
    const [y1, m1, d1] = olderDateStr.split('-').map(Number);
    const [y2, m2, d2] = newerDateStr.split('-').map(Number);
    const ms1 = Date.UTC(y1, m1 - 1, d1);
    const ms2 = Date.UTC(y2, m2 - 1, d2);
    return Math.floor((ms2 - ms1) / 86400000);
}

const defaultSteps = [
    { type: 'send', text: '/start' },
    { type: 'click', text: '签到' },
    { type: 'click', text: '人机,验证,不是,机器,✅' }
];

const devicePool = [
    {
        deviceModel: "iPhone 7",
        systemVersion: "15.8.3",
        appVersion: "Telegram iOS 10.2.1",
        langCode: "zh-hans",
        systemLangCode: "zh-hans",
        platform: "ios",
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 15_8_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
    },
    {
        deviceModel: "iPhone 8 Plus",
        systemVersion: "16.7.10",
        appVersion: "Swiftgram 10.9 (240)",
        langCode: "zh-hans",
        systemLangCode: "zh-hans",
        platform: "ios",
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
    },
    {
        deviceModel: "iPhone X",
        systemVersion: "16.7.10",
        appVersion: "Telegram iOS 10.8.0",
        langCode: "zh-hans",
        systemLangCode: "zh-hans",
        platform: "ios",
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
    },
    {
        deviceModel: "iPhone 11 Pro",
        systemVersion: "17.5.1",
        appVersion: "Telegram iOS 10.9.1",
        langCode: "zh-hans",
        systemLangCode: "zh-hans",
        platform: "ios",
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
    },
    {
        deviceModel: "iPhone 12",
        systemVersion: "17.6.0",
        appVersion: "Swiftgram 11.2 (255)",
        langCode: "zh-hans",
        systemLangCode: "zh-hans",
        platform: "ios",
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
    },
    {
        deviceModel: "iPhone 13 Pro Max",
        systemVersion: "17.6.1",
        appVersion: "Telegram iOS 10.9.3",
        langCode: "zh-hans",
        systemLangCode: "zh-hans",
        platform: "ios",
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
    },
    {
        deviceModel: "iPhone 14 Pro",
        systemVersion: "17.6.1",
        appVersion: "Telegram iOS 10.9.2",
        langCode: "zh-hans",
        systemLangCode: "zh-hans",
        platform: "ios",
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
    },
    {
        deviceModel: "iPhone 15 Pro",
        systemVersion: "17.6.1",
        appVersion: "Swiftgram 12.7 (275)",
        langCode: "zh-hans",
        systemLangCode: "zh-hans",
        platform: "ios",
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
    },
    {
        deviceModel: "iPhone 16",
        systemVersion: "18.0.0",
        appVersion: "Telegram iOS 11.0.0",
        langCode: "zh-hans",
        systemLangCode: "zh-hans",
        platform: "ios",
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
    },
    {
        deviceModel: "iPhone 16 Pro Max",
        systemVersion: "18.0.0",
        appVersion: "Telegram iOS 11.0.1",
        langCode: "zh-hans",
        systemLangCode: "zh-hans",
        platform: "ios",
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
    }
];

function getNextAvailableDeviceIndex(excludePhone = "") {
    const data = loadData();
    const used = new Set();
    if (data.accounts && Array.isArray(data.accounts)) {
        data.accounts.forEach(a => {
            if (a.phone !== excludePhone && typeof a.deviceIndex === 'number' && a.deviceIndex >= 0) {
                used.add(a.deviceIndex % devicePool.length);
            }
        });
    }
    for (let i = 0; i < devicePool.length; i++) {
        if (!used.has(i)) return i;
    }
    return (data.accounts || []).length % devicePool.length;
}

function getDeviceConfig(phone = "") {
    const data = loadData();
    let index = -1;
    if (phone && data.accounts && Array.isArray(data.accounts)) {
        const acc = data.accounts.find(a => a.phone === phone);
        if (acc && typeof acc.deviceIndex === 'number' && acc.deviceIndex >= 0) {
            index = acc.deviceIndex % devicePool.length;
        }
    }
    if (index === -1) {
        index = getNextAvailableDeviceIndex(phone);
    }

    const chosen = devicePool[index];
    return {
        connectionRetries: 5,
        deviceIndex: index,
        deviceModel: chosen.deviceModel,
        systemVersion: chosen.systemVersion,
        appVersion: chosen.appVersion,
        langCode: chosen.langCode,
        systemLangCode: chosen.systemLangCode,
        platform: chosen.platform,
        userAgent: chosen.userAgent
    };
}

function ensureUniqueDeviceIndices(accounts) {
    if (!Array.isArray(accounts)) return false;
    let modified = false;
    const used = new Set();
    accounts.forEach(acc => {
        if (typeof acc.deviceIndex === 'number' && acc.deviceIndex >= 0 && acc.deviceIndex < devicePool.length && !used.has(acc.deviceIndex)) {
            used.add(acc.deviceIndex);
        } else {
            delete acc.deviceIndex;
            modified = true;
        }
    });

    accounts.forEach(acc => {
        if (typeof acc.deviceIndex !== 'number') {
            for (let i = 0; i < devicePool.length; i++) {
                if (!used.has(i)) {
                    acc.deviceIndex = i;
                    used.add(i);
                    break;
                }
            }
            if (typeof acc.deviceIndex !== 'number') {
                acc.deviceIndex = used.size % devicePool.length;
            }
            modified = true;
        }
    });
    return modified;
}

const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
let dbPool = null;

if (dbUrl) {
    dbPool = new Pool({
        connectionString: dbUrl,
        ssl: dbUrl.includes("localhost") ? false : { rejectUnauthorized: false },
        connectionTimeoutMillis: 10000
    });
    dbPool.on("error", (err) => {
        addLog(`🐘 数据库连接池异常: ${err.message}`);
    });
}

function loadDefaultData() {
    return { 
        accounts: [], 
        bots: [], 
        settings: { apiId: 2040, apiHash: "b18441a1ff607e10a989891a5462e627" },
        aiSettings: { model1: "", model2: "", model3: "" },
        keepAlive: { url: "", interval: 300, enabled: false }
    };
}

function normalizeData(data) {
    if (!data.aiSettings) {
        data.aiSettings = { model1: "", model2: "", model3: "" };
    } else {
        delete data.aiSettings.enabled;
    }

    let hasMigrated = false;

    if (data.accounts && Array.isArray(data.accounts)) {
        if (ensureUniqueDeviceIndices(data.accounts)) {
            hasMigrated = true;
        }
    }

    if (data.accounts && data.accounts.length > 0 && (!data.bots || data.bots.length === 0)) {
        data.bots = [];
        data.accounts.forEach(acc => {
            if (acc.bots && acc.bots.length > 0) {
                acc.bots.forEach(oldBot => {
                    let globalBot = data.bots.find(b => b.username === oldBot.username);
                    if (!globalBot) {
                        globalBot = {
                            username: oldBot.username,
                            name: oldBot.name || oldBot.username,
                            steps: oldBot.steps || [...defaultSteps],
                            checkKeywords: oldBot.checkKeywords || "",
                            checkinIntervalDays: 1,
                            renewIntervalDays: 0,
                            renewSteps: [],
                            enabledAccounts: [],
                            states: {}
                        };
                        data.bots.push(globalBot);
                    }
                    if (!globalBot.enabledAccounts.includes(acc.phone)) {
                        globalBot.enabledAccounts.push(acc.phone);
                    }
                    globalBot.states[acc.phone] = {
                        nextRunTime: getNextRandomTime(1),
                        retryCount: 0,
                        todayRetryCount: 0,
                        lastRetryDate: "",
                        lastStatus: 'pending',
                        lastSuccessTime: oldBot.lastSuccessTime || 0,
                        lastRenewDate: "",
                        lastRenewStatus: 'pending'
                    };
                });
                hasMigrated = true;
            }
        });
        
        data.accounts.forEach(acc => {
            delete acc.bots;
        });
    }

    if (data.bots) {
        data.bots.forEach(bot => {
            if (!bot.enabledAccounts) bot.enabledAccounts = [];
            if (!bot.states) bot.states = {};
            if (typeof bot.checkinIntervalDays !== 'number' || bot.checkinIntervalDays < 1) bot.checkinIntervalDays = 1;
            if (typeof bot.renewIntervalDays !== 'number' || bot.renewIntervalDays < 0) bot.renewIntervalDays = 0;
            if (!Array.isArray(bot.renewSteps)) bot.renewSteps = [];
            delete bot.aiEnabled;
            bot.enabledAccounts.forEach(phone => {
                if (!bot.states[phone]) {
                    bot.states[phone] = {
                        nextRunTime: getNextRandomTime(bot.checkinIntervalDays || 1),
                        retryCount: 0,
                        todayRetryCount: 0,
                        lastRetryDate: "",
                        lastStatus: 'pending',
                        lastSuccessTime: 0,
                        lastRenewDate: "",
                        lastRenewStatus: 'pending'
                    };
                }
            });
        });
    }

    return { data, hasMigrated };
}

async function initDatabase() {
    if (!dbPool) {
        addLog("ℹ️ 未检测到 DATABASE_URL / POSTGRES_URL 环境变量，使用本地 JSON 文件存储");
        return;
    }
    try {
        addLog("🐘 正在连接云端数据库 (Neon/Supabase)...");
        await dbPool.query(`
            CREATE TABLE IF NOT EXISTS tg_signer_data (
                id VARCHAR(64) PRIMARY KEY,
                data JSONB NOT NULL,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
        `);
        const res = await dbPool.query("SELECT data FROM tg_signer_data WHERE id = 'main_config' LIMIT 1;");
        if (res.rows && res.rows.length > 0 && res.rows[0].data) {
            const cloudData = res.rows[0].data;
            if (cloudData && (Array.isArray(cloudData.accounts) || Array.isArray(cloudData.bots))) {
                const normalized = normalizeData(cloudData);
                globalData = normalized.data;
                if (normalized.hasMigrated) {
                    saveData(globalData);
                }
                try {
                    fs.writeFileSync(dataFile, JSON.stringify(globalData, null, 2), "utf8");
                } catch (e) {}
                addLog("🐘 成功从云端数据库 (Neon/Supabase) 同步并加载数据！");
                return;
            }
        }
        
        const localData = loadData();
        await dbPool.query(`
            INSERT INTO tg_signer_data (id, data, updated_at)
            VALUES ('main_config', $1, NOW())
            ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW();
        `, [JSON.stringify(localData)]);
        addLog("🐘 云端数据库为空，已将本地初始数据成功同步至云端数据库！");
    } catch (err) {
        addLog(`❌ 云端数据库初始化失败，已降级回本地文件模式: ${err.message}`);
    }
}

function loadData() {
    if (globalData) {
        return globalData;
    }

    let data = loadDefaultData();
    
    if (fs.existsSync(dataFile)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(dataFile, "utf8"));
            data = { ...data, ...parsed };
        } catch (e) {
            console.error("读取 data.json 失败，可能文件损坏，将使用默认配置:", e.message);
            addLog(`❌ 读取 data.json 失败: ${e.message}`);
        }
    } else {
        addLog(`ℹ️ 未找到历史数据文件，将使用默认配置初始化`);
    }

    const normalized = normalizeData(data);
    globalData = normalized.data;

    if (normalized.hasMigrated) {
        saveData(globalData);
    }

    return globalData;
}

function saveData(data) {
    if (data.accounts && Array.isArray(data.accounts)) {
        ensureUniqueDeviceIndices(data.accounts);
    }

    const tempFile = dataFile + ".tmp";
    try {
        fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), "utf8");
        fs.renameSync(tempFile, dataFile);
        globalData = data;
        dataEmitter.emit('dataChanged');
    } catch (e) {
        console.error("保存数据失败:", e.message);
        addLog(`❌ 保存本地数据失败: ${e.message}`);
    }

    if (dbPool) {
        dbPool.query(`
            INSERT INTO tg_signer_data (id, data, updated_at)
            VALUES ('main_config', $1, NOW())
            ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW();
        `, [JSON.stringify(data)]).catch((err) => {
            addLog(`❌ 同步数据至云端数据库失败: ${err.message}`);
        });
    }
}

function getNextRandomTime(days = 1) {
    const stepDays = Math.max(1, parseInt(days) || 1);
    const now = new Date();
    const currentUtc = now.getTime();
    const bjTimeMs = currentUtc + 8 * 60 * 60 * 1000;
    const bjDate = new Date(bjTimeMs);
    
    const targetBjMs = Date.UTC(bjDate.getUTCFullYear(), bjDate.getUTCMonth(), bjDate.getUTCDate() + stepDays);
    
    const minTimeBjMs = targetBjMs + 8 * 60 * 60 * 1000;
    const maxTimeBjMs = targetBjMs + 23.5 * 60 * 60 * 1000;
    
    const randomBjMs = Math.floor(Math.random() * (maxTimeBjMs - minTimeBjMs)) + minTimeBjMs;
    
    return randomBjMs - 8 * 60 * 60 * 1000;
}

function getRetryTime() {
    const now = Date.now();
    const bjTimeMs = now + 8 * 60 * 60 * 1000;
    const bjDate = new Date(bjTimeMs);
    
    const today2330BjMs = Date.UTC(bjDate.getUTCFullYear(), bjDate.getUTCMonth(), bjDate.getUTCDate(), 23, 30, 0);
    const today2330Ms = today2330BjMs - 8 * 60 * 60 * 1000;

    const remainingMs = today2330Ms - now;
    const oneHourMs = 60 * 60 * 1000;
    const sixHoursMs = 6 * 60 * 60 * 1000;

    if (remainingMs < oneHourMs) {
        return getNextRandomTime(1);
    }

    if (remainingMs <= sixHoursMs) {
        const today2300BjMs = Date.UTC(bjDate.getUTCFullYear(), bjDate.getUTCMonth(), bjDate.getUTCDate(), 23, 0, 0);
        const today2300Ms = today2300BjMs - 8 * 60 * 60 * 1000;
        const randomOffsetMs = Math.floor(Math.random() * 20 * 60 * 1000);
        return today2300Ms + randomOffsetMs;
    }

    return now + sixHoursMs;
}

module.exports = {
    addLog,
    getLogs,
    clearLogs,
    maskPhone,
    getPhoneHash,
    getPasswordHash,
    getBjDateString,
    getDaysDiffBj,
    loadData,
    saveData,
    getDeviceConfig,
    getNextAvailableDeviceIndex,
    getNextRandomTime,
    getRetryTime,
    defaultSteps,
    dataEmitter,
    initDatabase
};
