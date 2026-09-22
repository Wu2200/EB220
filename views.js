const { loadData, maskPhone, getPhoneHash, getDeviceConfig, getBjDateString, getDaysDiffBj } = require("./utils");

function renderAccountsHtml() {
    const data = loadData();
    if (data.accounts.length === 0) {
        return "<p style='color:#8e8e93; text-align:center; padding:20px 0; font-size:14px;'>暂无账号，请在下方登录添加。</p>";
    }

    let html = "";
    data.accounts.forEach((acc) => {
        const phoneHash = getPhoneHash(acc.phone);
        const devConf = getDeviceConfig(acc.phone);
        html += `
            <div class="account-card" style="padding:15px; margin-bottom:15px; border-radius:12px;">
                <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--border); padding-bottom:10px; margin-bottom:12px;">
                    <div>
                        <h3 style="margin:0; font-size:16px;">📱 ${maskPhone(acc.phone)}</h3>
                        <div style="font-size:11px; color:var(--text-sec); margin-top:2px;">${devConf.deviceModel} · iOS ${devConf.systemVersion}</div>
                    </div>
                    <div style="display:flex; gap:8px;">
                        <form action="/get-tg-code" method="POST" class="ajax-form" style="margin:0;">
                            <input type="hidden" name="phoneHash" value="${phoneHash}">
                            <button type="submit" style="display:flex; flex-direction:column; align-items:center; justify-content:center; background:#fff5e5; color:#ff9500; border:none; border-radius:8px; padding:4px 10px; font-size:11px; font-weight:600; cursor:pointer; min-width:48px;">
                                <span style="font-size:14px; margin-bottom:2px;">📩</span>
                                <span>获取</span>
                            </button>
                        </form>
                        <form action="/run-account" method="POST" class="ajax-form" style="margin:0;">
                            <input type="hidden" name="phoneHash" value="${phoneHash}">
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
                        <textarea id="sess-${phoneHash}" readonly class="session-textarea" placeholder="点击右侧按钮获取密钥...">••••••••••••••••••••••••••••••••</textarea>
                        <button type="button" onclick="fetchSession('${phoneHash}', this)" style="position:absolute; right:5px; top:5px; padding:4px 8px; font-size:12px; background:#e5e5ea; color:#1c1c1e; border:none; border-radius:4px; cursor:pointer;">获取并复制</button>
                    </div>
                </details>
                
                <form action="/delete-account" method="POST" class="ajax-form" data-confirm="确定要退出并删除此账号吗？此操作不可恢复。" style="margin:0; text-align:center;">
                    <input type="hidden" name="phoneHash" value="${phoneHash}">
                    <button type="submit" style="background:none; border:none; color:#ff3b30; font-size:13px; cursor:pointer; padding:5px;">退出并删除此账号</button>
                </form>
            </div>
        `;
    });
    return html;
}

function renderBotsHtml() {
    const data = loadData();
    if (!data.bots || data.bots.length === 0) {
        return "<p style='color:#8e8e93; text-align:center; padding:20px 0; font-size:14px;'>暂无机器人，请在下方添加。</p>";
    }

    let html = "";
    data.bots.forEach((b) => {
        const stepsStr = (b.steps || []).map(s => {
            if (s.type === 'send') return `发送: ${s.text}`;
            if (s.type === 'send_delete') return `发送并撤回: ${s.text}`;
            if (s.type === 'click') return `点击: ${s.text}`;
            if (s.type === 'ai_captcha') return `Ai识别`;
            if (s.type === 'webapp') return `小程序: ${s.webAppUrl} | ${s.apiUrl}`;
            if (s.type === 'webapp_json') return `小程序: ${JSON.stringify(s.config)}`;
            return '';
        }).join('\n');

        const renewStepsStr = (b.renewSteps || []).map(s => {
            if (s.type === 'send') return `发送: ${s.text}`;
            if (s.type === 'send_delete') return `发送并撤回: ${s.text}`;
            if (s.type === 'click') return `点击: ${s.text}`;
            if (s.type === 'ai_captcha') return `Ai识别`;
            if (s.type === 'webapp') return `小程序: ${s.webAppUrl} | ${s.apiUrl}`;
            if (s.type === 'webapp_json') return `小程序: ${JSON.stringify(s.config)}`;
            return '';
        }).join('\n');

        let timesHtml = "";
        if (b.enabledAccounts && b.enabledAccounts.length > 0) {
            const todayBj = getBjDateString();
            const yesterdayBj = getBjDateString(Date.now() - 24 * 60 * 60 * 1000);

            timesHtml = b.enabledAccounts.map(phone => {
                const state = (b.states && b.states[phone]) || {};
                const nextTimeStr = state.nextRunTime ? new Date(state.nextRunTime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : "未设定";
                const last4 = phone.slice(-4);
                
                const lastSuccessBj = state.lastSuccessTime ? getBjDateString(state.lastSuccessTime) : "";
                const isCheckinSuccessToday = (todayBj === lastSuccessBj);
                const isAttemptedToday = (state.lastRetryDate === todayBj);
                const todayRetryCount = isAttemptedToday ? (state.todayRetryCount || 0) : 0;
                const isYesterdayFailed = (state.lastRetryDate === yesterdayBj && state.lastStatus === 'fail');

                let statusIcon = "⏳";
                let statusText = "";

                if (state.lastStatus === 'fail') {
                    statusIcon = "❌";
                    if (state.lastRenewStatus === 'fail' && isCheckinSuccessToday) {
                        statusText = " (签到成功但续费失败待重试)";
                    } else if (todayRetryCount === 1) {
                        statusText = " (首次失败等待重试)";
                    } else if (todayRetryCount >= 2) {
                        statusText = " (重试失败)";
                    } else {
                        statusText = " (执行失败)";
                    }
                } else if (isCheckinSuccessToday) {
                    statusIcon = "✅";
                } else if (isYesterdayFailed) {
                    statusIcon = "❌";
                    statusText = " (昨天失败)";
                }

                let renewInfo = "";
                const renewDays = parseInt(b.renewIntervalDays) || 0;
                if (renewDays > 0) {
                    const isNeverRenewed = !state.lastRenewDate;
                    const daysPassed = isNeverRenewed ? 0 : getDaysDiffBj(state.lastRenewDate, todayBj);
                    let renewStatusTag = "";
                    if (state.lastRenewStatus === 'fail') {
                        renewStatusTag = "<span style='color:#ff3b30; font-weight:600;'>[❌上次续费失败]</span> ";
                    } else if (state.lastRenewDate === todayBj) {
                        renewStatusTag = "<span style='color:#34c759; font-weight:600;'>[✅今日已续费]</span> ";
                    }
                    const passText = isNeverRenewed ? "待首次续费" : `已过${daysPassed}天`;
                    renewInfo = `<div style="font-size:11px; color:var(--text-sec); margin-top:2px;">🔄 续费: ${renewStatusTag}${state.lastRenewDate ? state.lastRenewDate : '未续费'} (${passText}/周期${renewDays}天)</div>`;
                }
                
                return `
                <div style="font-size:12px; color:#555; margin-top:4px; padding:6px 8px; background:var(--input-bg); border-radius:6px;">
                    <div>${statusIcon} 尾号${last4}: ${nextTimeStr}${statusText}</div>
                    ${renewInfo}
                </div>`;
            }).join("");
        } else {
            timesHtml = "<div style='font-size:12px; color:#8e8e93; padding:4px 8px;'>未启用任何账号</div>";
        }

        let testButtons = "";
        if (b.enabledAccounts && b.enabledAccounts.length > 0) {
            const botId = b.username.replace(/[^a-zA-Z0-9]/g, '_');
            const hasRenew = Array.isArray(b.renewSteps) && b.renewSteps.length > 0;

            testButtons = b.enabledAccounts.map(phone => {
                const phoneHash = getPhoneHash(phone);
                const last4 = phone.slice(-4);
                const testKey = `${botId}-${last4}`;

                if (!hasRenew) {
                    return `
                    <form action="/run-single-bot" method="POST" class="ajax-form" style="margin:0; display:inline-block; vertical-align: middle;">
                        <input type="hidden" name="phoneHash" value="${phoneHash}">
                        <input type="hidden" name="bot" value="${b.username}">
                        <button type="submit" class="btn-action" style="background:#e5f1ff; color:#007aff; padding:4px 8px; font-size:11px; margin-right:4px;">测试尾号${last4}</button>
                    </form>`;
                } else {
                    return `
                    <div style="display:inline-block; vertical-align:middle; margin-right:4px;">
                        <button type="button" class="btn-action" id="btn-test-${testKey}" onclick="showTestOptions('${testKey}')" style="background:#e5f1ff; color:#007aff; padding:4px 8px; font-size:11px;">测试尾号${last4}</button>
                        <div id="opt-test-${testKey}" style="display:none; align-items:center; gap:3px;">
                            <form action="/run-single-bot" method="POST" class="ajax-form" style="margin:0; display:inline-block;">
                                <input type="hidden" name="phoneHash" value="${phoneHash}">
                                <input type="hidden" name="bot" value="${b.username}">
                                <button type="submit" class="btn-action" style="background:#e5f1ff; color:#007aff; padding:4px 8px; font-size:11px;">签到</button>
                            </form>
                            <form action="/run-single-renew" method="POST" class="ajax-form" style="margin:0; display:inline-block;">
                                <input type="hidden" name="phoneHash" value="${phoneHash}">
                                <input type="hidden" name="bot" value="${b.username}">
                                <button type="submit" class="btn-action" style="background:#fff2e8; color:#fa541c; padding:4px 8px; font-size:11px;">续费</button>
                            </form>
                            <button type="button" onclick="hideTestOptions('${testKey}')" style="background:#e5e5ea; color:#1c1c1e; border:none; border-radius:4px; padding:2px 6px; font-size:10px; cursor:pointer; height:22px; line-height:18px;">✕</button>
                        </div>
                    </div>`;
                }
            }).join("");
        }

        let inlineEditAccountsForm = "";
        if (data.accounts.length > 0) {
            const botId = b.username.replace(/[^a-zA-Z0-9]/g, '_');
            inlineEditAccountsForm = `
            <div style="display:inline-flex; align-items:center; gap:4px; vertical-align: middle;">
                <button type="button" class="btn-action" onclick="showEditAccountsForm('${botId}')" id="btn-edit-acc-${botId}" style="background:#007aff; color:#fff; padding:2px 6px; font-size:11px; margin:0; height:22px; line-height:18px; vertical-align: middle;">编辑账号</button>
                
                <form action="/update-bot-accounts" method="POST" class="ajax-form" id="form-edit-acc-${botId}" style="margin:0; display:none; align-items:center; gap:6px; flex-wrap:wrap; vertical-align: middle; padding:6px; background:var(--input-bg); border-radius:8px; margin-top:6px; width:100%;">
                    <input type="hidden" name="bot" value="${b.username}">
                    <div style="display:flex; flex-wrap:wrap; gap:8px; width:100%; margin-bottom:6px;">
                        ${data.accounts.map(acc => {
                            const phoneHash = getPhoneHash(acc.phone);
                            const isChecked = b.enabledAccounts && b.enabledAccounts.includes(acc.phone) ? "checked" : "";
                            const last4 = acc.phone.slice(-4);
                            return `
                            <label style="display:inline-flex; align-items:center; font-size:11px; cursor:pointer; background:#fff; padding:2px 6px; border-radius:4px; border:1px solid var(--border);">
                                <input type="checkbox" name="enabledAccounts" value="${phoneHash}" ${isChecked} style="margin-right:4px; width:12px; height:12px;">
                                尾号${last4}
                            </label>`;
                        }).join("")}
                    </div>
                    <div style="display:flex; gap:4px; width:100%;">
                        <button type="submit" class="btn-action" style="background:#34c759; color:#fff; padding:2px 8px; font-size:11px; height:22px; line-height:18px;">保存</button>
                        <button type="button" onclick="hideEditAccountsForm('${botId}')" style="background:#e5e5ea; color:#1c1c1e; border:none; border-radius:4px; padding:2px 8px; font-size:11px; height:22px; cursor:pointer; line-height:18px;">取消</button>
                    </div>
                </form>
            </div>`;
        }

        html += `
            <div class="bot-card" style="padding:15px; margin-bottom:15px; border-radius:12px; border:1px solid var(--border); background:#fff;">
                <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--border); padding-bottom:8px; margin-bottom:8px;">
                    <div>
                        <h3 style="margin:0; font-size:16px;">🤖 ${b.name} <span class="text-sec" style="font-size:12px; font-weight:normal;">${b.username}</span></h3>
                        <div style="font-size:11px; color:var(--text-sec); margin-top:3px;">签到周期: 每${b.checkinIntervalDays || 1}天 · 续费周期: ${b.renewIntervalDays > 0 ? '每' + b.renewIntervalDays + '天' : '未开启'}</div>
                    </div>
                    <form action="/remove-bot" method="POST" class="ajax-form" data-confirm="确定要删除这个机器人吗？此操作不可恢复。" style="margin:0;">
                        <input type="hidden" name="bot" value="${b.username}">
                        <button type="submit" class="btn-action" style="background:#ffe5e5; color:#ff3b30;">删除</button>
                    </form>
                </div>
                
                <div style="margin-bottom:10px;">
                    <div style="font-weight:600; font-size:13px; margin-bottom:4px;">🕒 运行账号与下次签到:</div>
                    ${timesHtml}
                </div>

                <div style="margin-bottom:10px; padding-top:8px; border-top:1px dashed var(--border);">
                    <div style="font-weight:600; font-size:13px; margin-bottom:6px;">⚡ 单独测试与账号管理:</div>
                    <div style="display:flex; flex-wrap:wrap; gap:4px; align-items:center; width:100%;">
                        <div style="display:flex; flex-wrap:wrap; gap:4px; align-items:center; width:100%;">
                            ${testButtons}
                            ${inlineEditAccountsForm}
                            ${(b.enabledAccounts.length === 0 && data.accounts.length === 0) ? "<span style='color:#8e8e93; font-size:12px;'>无可用测试账号</span>" : ""}
                        </div>
                    </div>
                </div>

                <details style="font-size:12px; margin-top:8px; border-top:1px dashed var(--border); padding-top:8px;">
                    <summary style="cursor:pointer; color:#007aff; font-weight:500; outline:none;">⚙️ 自定义配置</summary>
                    <form action="/update-bot-config" method="POST" class="ajax-form" style="margin-top:8px;">
                        <input type="hidden" name="bot" value="${b.username}">

                        <div style="margin-bottom:8px;">
                            <label style="display:block; margin-bottom:4px; font-weight:600; color:var(--text);">机器人用户名 @xxx:</label>
                            <input type="text" name="botUsername" value="${b.username}" required class="custom-input" style="margin:0;">
                        </div>
                        
                        <div style="margin-bottom:8px;">
                            <label style="display:block; margin-bottom:4px; font-weight:600; color:var(--text);">机器人昵称:</label>
                            <input type="text" name="botName" value="${b.name || b.username}" required class="custom-input" style="margin:0;">
                        </div>

                        <div style="display:flex; gap:8px; margin-bottom:8px;">
                            <div style="flex:1;">
                                <label style="display:block; margin-bottom:4px; font-weight:600; color:var(--text);">签到周期 (天):</label>
                                <input type="number" min="1" name="checkinIntervalDays" value="${b.checkinIntervalDays || 1}" required class="custom-input" style="margin:0;">
                            </div>
                            <div style="flex:1;">
                                <label style="display:block; margin-bottom:4px; font-weight:600; color:var(--text);">续费周期 (天，0为禁用):</label>
                                <input type="number" min="0" name="renewIntervalDays" value="${b.renewIntervalDays || 0}" required class="custom-input" style="margin:0;">
                            </div>
                        </div>

                        <div style="margin-bottom:8px;">
                            <label style="display:block; margin-bottom:4px; font-weight:600; color:var(--text);">签到步骤配置:</label>
                            <textarea name="stepsStr" rows="3" class="custom-textarea" placeholder="发送: /start&#10;发送并撤回: 签到&#10;Ai识别&#10;点击: 签到" style="margin:0;">${stepsStr}</textarea>
                        </div>

                        <div style="margin-bottom:8px;">
                            <label style="display:block; margin-bottom:4px; font-weight:600; color:var(--text);">续费步骤配置 (在签到成功后执行):</label>
                            <textarea name="renewStepsStr" rows="3" class="custom-textarea" placeholder="点击: 续费&#10;点击: 确认续费" style="margin:0;">${renewStepsStr}</textarea>
                        </div>

                        <div style="margin-bottom:8px;">
                            <label style="display:block; margin-bottom:4px; font-weight:600; color:var(--text);">签到/续费结果检测关键词 (逗号分隔):</label>
                            <input type="text" name="checkKeywords" value="${b.checkKeywords || ''}" placeholder="签到与续费检测关键词，逗号分隔，留空不检测" class="custom-input" style="margin:0;">
                        </div>

                        <button type="submit" class="btn-action" style="margin-top:6px; width:100%; background:#34c759; color:#fff; padding:6px;">保存配置</button>
                    </form>
                </details>
            </div>
        `;
    });
    return html;
}

function renderMainHtml() {
    const data = loadData();
    return `
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
                        <span>📋 账号管理</span>
                        <div style="display:flex; gap:8px;">
                            <button type="button" class="pill-btn" style="background:#34c759;" onclick="downloadBackup()">备份</button>
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
                    <div class="card-title">
                        <span>🎯 机器人管理</span>
                    </div>
                    <div id="bots-container">
                        ${renderBotsHtml()}
                    </div>
                    <div style="margin-top:15px; border-top:1px solid var(--border); padding-top:15px;">
                        <h4 style="margin:0 0 10px 0; font-size:14px;">➕ 添加全局机器人</h4>
                        <form action="/add-bot" method="POST" class="ajax-form" style="display:flex; gap:6px; align-items:stretch;">
                            <input type="text" name="botUsername" placeholder="用户名 @xxx" required class="custom-input" style="flex:1; min-width:0; padding:10px; margin:0; border-radius:8px; font-size:13px;">
                            <input type="text" name="customName" placeholder="昵称 选填" class="custom-input" style="flex:1; min-width:0; padding:10px; margin:0; border-radius:8px; font-size:13px;">
                            <button type="submit" class="btn-action" style="background:#007aff; color:white; padding:0 15px; margin:0;">添加</button>
                        </form>
                    </div>
                </div>

                <div class="card">
                    <div class="card-title">
                        <span>🤖 AI验证助手</span>
                        <button type="button" class="pill-btn" id="btn-fetch-models" onclick="fetchAiModels()">获取模型</button>
                    </div>
                    <form action="/save-aisettings" method="POST" class="ajax-form">
                        <div style="margin-bottom: 10px;">
                            <label style="display:block; margin-bottom:4px; font-weight:600; color:var(--text); font-size:13px;">模型 1 主模型:</label>
                            <select name="model1" data-value="${data.aiSettings?.model1 || ''}" style="padding: 12px; width: 100%; border: 1px solid var(--border); border-radius: 10px; background: var(--input-bg); color: var(--text); outline: none; font-size: 15px;">
                                <option value="${data.aiSettings?.model1 || ''}">${data.aiSettings?.model1 || '-- 未选择 --'}</option>
                            </select>
                        </div>
                        <div style="margin-bottom: 10px;">
                            <label style="display:block; margin-bottom:4px; font-weight:600; color:var(--text); font-size:13px;">模型 2 备用模型:</label>
                            <select name="model2" data-value="${data.aiSettings?.model2 || ''}" style="padding: 12px; width: 100%; border: 1px solid var(--border); border-radius: 10px; background: var(--input-bg); color: var(--text); outline: none; font-size: 15px;">
                                <option value="${data.aiSettings?.model2 || ''}">${data.aiSettings?.model2 || '-- 未选择 --'}</option>
                            </select>
                        </div>
                        <div style="margin-bottom: 10px;">
                            <label style="display:block; margin-bottom:4px; font-weight:600; color:var(--text); font-size:13px;">模型 3 备用模型:</label>
                            <select name="model3" data-value="${data.aiSettings?.model3 || ''}" style="padding: 12px; width: 100%; border: 1px solid var(--border); border-radius: 10px; background: var(--input-bg); color: var(--text); outline: none; font-size: 15px;">
                                <option value="${data.aiSettings?.model3 || ''}">${data.aiSettings?.model3 || '-- 未选择 --'}</option>
                            </select>
                        </div>
                        <button type="submit" class="btn-primary" style="background:#10a37f;">保存 AI 设置</button>
                    </form>
                </div>

                <div class="card">
                    <div class="card-title">📱 手机号验证码登录</div>
                    <div id="login-step-1">
                        <form action="/send-code" method="POST" class="ajax-form" id="form-phone">
                            <input type="text" name="phone" placeholder="手机号带国家代码如 +86..." required>
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
                    <div class="card-title">🔑 密钥 Session 直接登录</div>
                    <form action="/login-session" method="POST" class="ajax-form" id="form-session">
                        <input type="text" name="sessionString" placeholder="粘贴 Session 字符串..." required>
                        <button type="submit" class="btn-primary" style="background:#ff9500;">直接登录</button>
                    </form>
                </div>

                <div class="card">
                    <div class="card-title">⚙️ 保活机制 防休眠</div>
                    <form action="/save-keepalive" method="POST" class="ajax-form">
                        <input type="text" name="url" value="${data.keepAlive?.url || ''}" placeholder="应用网址 URL 留空关闭">
                        <input type="number" name="interval" value="${data.keepAlive?.interval || 300}" min="60" placeholder="请求间隔 秒" required>
                        <button type="submit" class="btn-primary" style="background:#5856d6;">保存设置</button>
                    </form>
                </div>
            </div>

            <script>
                function showEditAccountsForm(botId) {
                    document.getElementById('btn-edit-acc-' + botId).style.display = 'none';
                    document.getElementById('form-edit-acc-' + botId).style.display = 'block';
                }

                function hideEditAccountsForm(botId) {
                    document.getElementById('btn-edit-acc-' + botId).style.display = 'inline-block';
                    document.getElementById('form-edit-acc-' + botId).style.display = 'none';
                }

                function showTestOptions(key) {
                    const btn = document.getElementById('btn-test-' + key);
                    const opt = document.getElementById('opt-test-' + key);
                    if (btn && opt) {
                        btn.style.display = 'none';
                        opt.style.display = 'inline-flex';
                    }
                }

                function hideTestOptions(key) {
                    const btn = document.getElementById('btn-test-' + key);
                    const opt = document.getElementById('opt-test-' + key);
                    if (btn && opt) {
                        btn.style.display = 'inline-block';
                        opt.style.display = 'none';
                    }
                }

                async function fetchAiModels() {
                    const btn = document.getElementById('btn-fetch-models');
                    const originalText = btn.innerText;
                    btn.innerText = '⏳...';
                    btn.disabled = true;
                    try {
                        const res = await fetch('/api/fetch-models', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({})
                        });
                        const data = await res.json();
                        if (data.success && data.models) {
                            populateModelSelects(data.models);
                            alert('✅ 成功获取模型列表！');
                        } else {
                            alert('❌ 获取失败: ' + (data.error || '未知错误'));
                        }
                    } catch (e) {
                        alert('❌ 请求失败: ' + e.message);
                    } finally {
                        btn.innerText = originalText;
                        btn.disabled = false;
                    }
                }

                function populateModelSelects(models, selectedValues = {}) {
                    const selects = ['model1', 'model2', 'model3'];
                    selects.forEach(name => {
                        const select = document.querySelector(\`select[name="\${name}"]\`);
                        if (!select) return;
                        const currentValue = selectedValues[name] || select.getAttribute('data-value') || '';
                        
                        select.innerHTML = '<option value="">-- 未选择 --</option>';
                        
                        if (currentValue && !models.includes(currentValue)) {
                            const opt = document.createElement('option');
                            opt.value = currentValue;
                            opt.textContent = currentValue;
                            opt.selected = true;
                            select.appendChild(opt);
                        }
                        
                        models.forEach(m => {
                            const opt = document.createElement('option');
                            opt.value = m;
                            opt.textContent = m;
                            if (m === currentValue) {
                                opt.selected = true;
                            }
                            select.appendChild(opt);
                        });
                        select.setAttribute('data-value', select.value);
                    });
                }

                window.addEventListener('DOMContentLoaded', () => {
                    fetch('/api/fetch-models', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({})
                    })
                    .then(res => res.json())
                    .then(data => {
                        if (data.success && data.models) {
                            populateModelSelects(data.models);
                        }
                    })
                    .catch(() => {});
                });

                async function fetchSession(phoneHash, btn) {
                    const pwd = prompt("请输入密码以获取 Session 密钥：");
                    if (!pwd) return;
                    const originalText = btn.innerText;
                    btn.innerText = '⏳...';
                    btn.disabled = true;
                    try {
                        const res = await fetch('/api/get-session', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ phoneHash, password: pwd })
                        });
                        const data = await res.json();
                        if (data.success) {
                            const textareaId = 'sess-' + phoneHash;
                            const textarea = document.getElementById(textareaId);
                            textarea.value = data.session;
                            textarea.focus();
                            textarea.select();
                            textarea.setSelectionRange(0, 99999);
                            
                            let isCopied = false;
                            try {
                                if (navigator.clipboard && navigator.clipboard.writeText) {
                                    await navigator.clipboard.writeText(data.session);
                                    isCopied = true;
                                }
                            } catch (e) {}
                            
                            if (!isCopied) {
                                try {
                                    isCopied = document.execCommand("copy");
                                } catch (e) {}
                            }
                            
                            btn.innerText = isCopied ? "已复制!" : "已显示";
                            btn.style.background = '#34c759';
                            btn.style.color = '#fff';
                            setTimeout(() => { 
                                btn.innerText = originalText; 
                                btn.style.background = '#e5e5ea';
                                btn.style.color = '#1c1c1e';
                                btn.disabled = false;
                                textarea.value = "••••••••••••••••••••••••••••••••";
                            }, 5000);
                        } else {
                            alert("❌ 获取失败: " + data.error);
                            btn.innerText = originalText;
                            btn.disabled = false;
                        }
                    } catch (e) {
                        alert("❌ 请求失败: " + e.message);
                        btn.innerText = originalText;
                        btn.disabled = false;
                    }
                }

                function downloadBackup() {
                    const pwd = prompt("请输入密码以确认备份：");
                    if (!pwd) return;
                    
                    const form = document.createElement('form');
                    form.method = 'POST';
                    form.action = '/api/backup';
                    
                    const input = document.createElement('input');
                    input.type = 'hidden';
                    input.name = 'password';
                    input.value = pwd;
                    
                    form.appendChild(input);
                    document.body.appendChild(form);
                    form.submit();
                    document.body.removeChild(form);
                }

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
                                        document.getElementById('login-step-1').style.display = 'block';
                                        document.getElementById('login-step-2').style.display = 'none';
                                        document.getElementById('login-step-3').style.display = 'none';
                                        form.reset();
                                        if(document.getElementById('form-phone')) document.getElementById('form-phone').reset();
                                        alert("✅ 登录成功！");
                                    }
                                }
                            } else if (form.action.includes('/clear-logs')) {
                            } else {
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
                        const elAcc = document.getElementById('accounts-container');
                        const elBots = document.getElementById('bots-container');
                        if (document.activeElement && (elAcc.contains(document.activeElement) || elBots.contains(document.activeElement))) {
                            return;
                        }

                        const resAcc = await fetch('/api/accounts-html');
                        const htmlAcc = await resAcc.text();
                        if (elAcc && elAcc.innerHTML !== htmlAcc) {
                            elAcc.innerHTML = htmlAcc;
                        }

                        const resBots = await fetch('/api/bots-html');
                        const htmlBots = await resBots.text();
                        if (elBots && elBots.innerHTML !== htmlBots) {
                            elBots.innerHTML = htmlBots;
                        }
                    } catch (e) {}
                }

                if (window.EventSource) {
                    const evtSource = new EventSource('/api/events');
                    evtSource.onmessage = function() {
                        refreshAccounts();
                    };
                }

                async function fetchLogs() {
                    const consoleBox = document.getElementById('console-box');
                    try {
                        const res = await fetch('/api/logs');
                        if (!res.ok) {
                            throw new Error('HTTP ' + res.status + ' ' + res.statusText);
                        }
                        const data = await res.json();
                        if (!data || !Array.isArray(data.logs)) {
                            throw new Error('接口返回格式错误');
                        }
                        const escapeHtml = (str) => str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
                        const newHtml = (data.logs && data.logs.length > 0) 
                            ? data.logs.map(log => '<div class="log-item">' + escapeHtml(log) + '</div>').join('')
                            : '<div style="color:var(--text-sec); text-align:center; padding:10px;">暂无日志</div>';
                        if (consoleBox.innerHTML !== newHtml) {
                            const isAtBottom = consoleBox.scrollHeight - consoleBox.clientHeight - consoleBox.scrollTop < 50;
                            consoleBox.innerHTML = newHtml;
                            if (isAtBottom) {
                                consoleBox.scrollTop = consoleBox.scrollHeight;
                            }
                        }
                    } catch (error) {
                        console.error('日志加载失败:', error);
                        consoleBox.innerHTML = '<div style="color:#ff3b30; padding:10px;">❌ 日志加载失败: ' + error.message + '</div>';
                    }
                }
                setInterval(fetchLogs, 2000);
                fetchLogs();
            </script>
        </body>
        </html>
    `;
}

module.exports = {
    renderAccountsHtml,
    renderBotsHtml,
    renderMainHtml
};
