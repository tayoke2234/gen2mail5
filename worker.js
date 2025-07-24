/**
 * Cloudflare Worker for a Telegram Temporary Email Bot
 * Author: Gemini (with user-requested enhancements)
 * Language: Burmese (Comments & UI) & English (Code)
 * Version: 3.0 (Full User & Admin Panels)
 *
 * --- Features in this Version ---
 * 1.  Interactive User Panel (/start, /panel).
 * 2.  Comprehensive Admin Panel (/admin) with:
 * - Bot Statistics (Total users, total emails).
 * - Paginated User List.
 * - Ability to inspect individual users and their emails.
 * - Ability for admin to delete user emails.
 * - List of inactive users for cleanup.
 * 3.  Interactive, paginated inbox with read/unread/delete management.
 */

// --- Configuration ---
// These values are set in the Worker's environment variables (Settings -> Variables)
// BOT_TOKEN: Your Telegram bot token
// ADMIN_IDS: Comma-separated list of admin Telegram user IDs
// DOMAIN: The domain you are using for emails

// --- Main Handler ---
export default {
	async fetch(request, env) {
		if (request.method === "POST") {
			const payload = await request.json();
			if (payload.message) {
				await handleMessage(payload.message, env);
			} else if (payload.callback_query) {
				await handleCallbackQuery(payload.callback_query, env);
			}
		}
		return new Response("OK");
	},

	async email(message, env) {
		const to = message.to.toLowerCase();
		const emailKey = `email:${to}`;
		const emailData = await env.MAIL_BOT_DB.get(emailKey);
		if (!emailData) {
			message.setReject("Address does not exist in our system.");
			return;
		}

		const reader = message.raw.getReader();
		let chunks = [];
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
		}
		const rawEmail = new TextDecoder("utf-8").decode(new Uint8Array(chunks.reduce((acc, chunk) => [...acc, ...chunk], [])));
		const bodyMatch = rawEmail.match(/(?:\r\n\r\n|\n\n)([\s\S]*)/);
		const body = bodyMatch ? bodyMatch[1].trim() : "Empty Body";

		const newEmail = {
			from: message.headers.get("from") || "Unknown Sender",
			subject: message.headers.get("subject") || "No Subject",
			body: body,
			receivedAt: new Date().toISOString(),
			read: false,
		};

		let { inbox, owner } = JSON.parse(emailData);
		inbox.unshift(newEmail);
		await env.MAIL_BOT_DB.put(emailKey, JSON.stringify({ inbox, owner }));

		await sendMessage(owner, `📬 **လိပ်စာအသစ်ရောက်ရှိ!**\n\nသင်၏လိပ်စာ \`${to}\` သို့ email အသစ်တစ်စောင် ရောက်ရှိနေပါသည်။ \n\n/my_emails မှတစ်ဆင့် စစ်ဆေးနိုင်ပါသည်။`, null, env);
	},
};

// --- Telegram API Helpers ---
async function apiRequest(method, payload, env) {
	const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
	return await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
}

async function sendMessage(chatId, text, reply_markup = null, env) {
	await apiRequest("sendMessage", { chat_id: chatId, text: text, parse_mode: "Markdown", reply_markup: reply_markup }, env);
}

async function editMessage(chatId, messageId, text, reply_markup = null, env) {
	await apiRequest("editMessageText", { chat_id: chatId, message_id: messageId, text: text, parse_mode: "Markdown", reply_markup: reply_markup }, env);
}

async function answerCallbackQuery(callbackQueryId, text = "", env) {
    await apiRequest("answerCallbackQuery", { callback_query_id: callbackQueryId, text: text }, env);
}

// --- Message & Callback Handlers ---
async function handleMessage(message, env) {
	const chatId = message.chat.id;
	const text = message.text ? message.text.toLowerCase().trim() : "";
	await trackUserActivity(`user:${chatId}`, env);

	if (message.reply_to_message && message.reply_to_message.text.includes("သင်အသုံးပြုလိုသော နာမည်ကိုထည့်ပါ")) {
		await createNewEmail(chatId, text.split(" ")[0], env);
		return;
	}

	const isAdmin = env.ADMIN_IDS.split(",").includes(chatId.toString());

	switch (text) {
		case "/start":
		case "/panel":
			await showUserPanel(chatId, env);
			break;
		case "/create":
			await requestEmailName(chatId, env);
			break;
		case "/my_emails":
		case "/myemails":
			await listUserEmails(chatId, env);
			break;
		case "/random_address":
			await generateRandomAddress(chatId, env);
			break;
		case "/admin":
			if (isAdmin) {
				await showAdminPanel(chatId, env);
			} else {
				await sendMessage(chatId, "⛔ သင်သည် Admin မဟုတ်ပါ။", null, env);
			}
			break;
		default:
			await showUserPanel(chatId, env);
	}
}

async function handleCallbackQuery(callbackQuery, env) {
	const chatId = callbackQuery.message.chat.id;
	const messageId = callbackQuery.message.message_id;
	const data = callbackQuery.data;
	const [action, ...params] = data.split(":");
    const isAdmin = env.ADMIN_IDS.split(",").includes(chatId.toString());

	await answerCallbackQuery(callbackQuery.id, "လုပ်ဆောင်နေပါသည်...", env);
    await trackUserActivity(`user:${chatId}`, env);

	// User Panel Actions
	if (action === "panel_my_emails") await listUserEmails(chatId, env);
	else if (action === "panel_create") await requestEmailName(chatId, env);
	else if (action === "panel_random") await generateRandomAddress(chatId, env);

	// Inbox & Email Management
	else if (action === "view_inbox") await showInboxList(chatId, messageId, params[0], parseInt(params[1] || 1), env);
    else if (action === "view_email") await viewSingleEmail(chatId, messageId, params[0], parseInt(params[1]), env);
    else if (action === "mark_unread") await markEmailUnread(chatId, messageId, params[0], parseInt(params[1]), env);
    else if (action === "delete_single_confirm") await confirmDeleteSingleEmail(chatId, messageId, params[0], parseInt(params[1]), env);
    else if (action === "delete_single_execute") await deleteSingleEmail(chatId, messageId, params[0], parseInt(params[1]), env);
	
    // Address Deletion
    else if (action === "delete_email") await confirmDeleteEmail(chatId, messageId, params[0], env);
	else if (action === "delete_confirm") await deleteEmail(chatId, messageId, params[0], env);
	else if (action === "delete_cancel") await editMessage(chatId, messageId, "ဖျက်ခြင်းကို ပယ်ဖျက်လိုက်ပါသည်။", null, env);

	// Random Address
    else if (action === "create_random") {
        await createNewEmail(chatId, params[0], env);
        await editMessage(chatId, messageId, `✅ ကျပန်းလိပ်စာ \`${params[0]}@${env.DOMAIN}\` ကို အောင်မြင်စွာဖန်တီးပြီးပါပြီ။`, null, env);
    }
    else if (action === "generate_another") await generateRandomAddress(chatId, env, messageId);

	// Admin Actions (Checked for security)
	else if (isAdmin) {
        if (action === "admin_panel") await showAdminPanel(chatId, env, messageId);
		else if (action === "admin_stats") await showAdminStats(chatId, messageId, env);
		else if (action === "admin_list_users") await listAllUsers(chatId, messageId, parseInt(params[0] || 1), env);
        else if (action === "admin_view_user") await viewUserAsAdmin(chatId, messageId, params[0], env);
        else if (action === "admin_delete_user_email_confirm") await confirmDeleteEmailAsAdmin(chatId, messageId, params[0], params[1], env);
        else if (action === "admin_delete_user_email_execute") await deleteEmailAsAdmin(chatId, messageId, params[0], params[1], env);
        else if (action === "admin_inactive_users") await listInactiveUsers(chatId, messageId, parseInt(params[0] || 30), env);
	}
}

// --- User Panel & Core Functions ---
async function showUserPanel(chatId, env) {
	const userData = await env.MAIL_BOT_DB.get(`user:${chatId}`);
	const emailCount = userData ? JSON.parse(userData).createdEmails.length : 0;
	const text = `👋 **User Control Panel**\n\nသင်၏ကိုယ်ပိုင်ယာယီအီးမေးလ်များကို ဤနေရာတွင် ဖန်တီးနိုင်၊ စီမံခန့်ခွဲနိုင်ပါသည်။\n\n- သင်၏ Telegram ID: \`${chatId}\`\n- ဖန်တီးထားသော Email အရေအတွက်: \`${emailCount}\``;
	const keyboard = {
		inline_keyboard: [
			[{ text: "📧 Email များကြည့်ရန်", callback_data: "panel_my_emails" }],
			[{ text: "➕ Email အသစ်ဖန်တီးရန်", callback_data: "panel_create" }],
			[{ text: "🎲 ကျပန်းလိပ်စာ", callback_data: "panel_random" }],
		]
	};
	await sendMessage(chatId, text, keyboard, env);
}

async function listUserEmails(chatId, env) {
	const userData = await env.MAIL_BOT_DB.get(`user:${chatId}`);
	if (!userData || JSON.parse(userData).createdEmails.length === 0) {
		await sendMessage(chatId, "텅နေပါသည်! သင်ဖန်တီးထားသော email များမရှိသေးပါ။\n/create ကိုနှိပ်ပြီး စတင်လိုက်ပါ။", null, env);
		return;
	}
	const { createdEmails } = JSON.parse(userData);
	const keyboard = createdEmails.map(email => ([
        { text: `📥 Inbox: ${email}`, callback_data: `view_inbox:${email}:1` },
        { text: "🗑️ ဖျက်ရန်", callback_data: `delete_email:${email}` }
    ]));
	await sendMessage(chatId, "သင်၏ Email လိပ်စာများ:", { inline_keyboard: keyboard }, env);
}

// --- Inbox & Email Management ---
async function showInboxList(chatId, messageId, email, page = 1, env) {
    const emailData = await env.MAIL_BOT_DB.get(`email:${email}`);
    if (!emailData) {
        await editMessage(chatId, messageId, "❌ Error: Email not found.", null, env);
        return;
    }
    const { inbox } = JSON.parse(emailData);
    if (inbox.length === 0) {
        const text = `**Inbox: \`${email}\`**\n\n텅နေပါသည်! Email များ ရောက်ရှိမလာသေးပါ။`;
        const keyboard = { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: `view_inbox:${email}:1` }]] };
        await editMessage(chatId, messageId, text, keyboard, env);
        return;
    }

    const emailsPerPage = 5;
    const totalPages = Math.ceil(inbox.length / emailsPerPage);
    page = Math.max(1, Math.min(page, totalPages));
    const start = (page - 1) * emailsPerPage;
    const emailPage = inbox.slice(start, start + emailsPerPage);

    let text = `📥 **Inbox: \`${email}\`** (စာမျက်နှာ ${page}/${totalPages})\n`;
    const keyboardRows = emailPage.map((mail, index) => {
        const globalIndex = start + index;
        const readStatus = mail.read ? "" : "🆕 ";
        const subject = (mail.subject || "No Subject").substring(0, 25);
        const from = (mail.from || "Unknown").split('<')[0].trim().substring(0, 20);
        return [{ text: `${readStatus}${from} | ${subject}`, callback_data: `view_email:${email}:${globalIndex}` }];
    });

    const paginationRow = [];
    if (page > 1) paginationRow.push({ text: "◀️ ရှေ့", callback_data: `view_inbox:${email}:${page - 1}` });
    paginationRow.push({ text: "🔄", callback_data: `view_inbox:${email}:${page}` });
    if (page < totalPages) paginationRow.push({ text: "နောက် ▶️", callback_data: `view_inbox:${email}:${page + 1}` });
    keyboardRows.push(paginationRow);
    keyboardRows.push([{ text: "⬅️ Email List သို့ပြန်သွားရန်", callback_data: "panel_my_emails" }]);

    await editMessage(chatId, messageId, text, { inline_keyboard: keyboardRows }, env);
}

async function viewSingleEmail(chatId, messageId, emailAddr, emailIndex, env) {
    const emailKey = `email:${emailAddr}`;
    const emailData = await env.MAIL_BOT_DB.get(emailKey);
    if (!emailData) return;
    let { inbox, owner } = JSON.parse(emailData);
    const email = inbox[emailIndex];
    if (!email) return;

    if (!email.read) {
        email.read = true;
        await env.MAIL_BOT_DB.put(emailKey, JSON.stringify({ inbox, owner }));
    }

    let bodyText = (email.body || "Empty Body").substring(0, 3500);
    let text = `**From:** \`${email.from}\`\n**Subject:** \`${email.subject}\`\n**Date:** \`${new Date(email.receivedAt).toLocaleString('en-GB')}\`\n-------------------------\n${bodyText}`;
    const keyboard = {
        inline_keyboard: [
            [{ text: "မဖတ်ရသေးဟု သတ်မှတ်မည်", callback_data: `mark_unread:${emailAddr}:${emailIndex}` }, { text: "🗑️ ဖျက်မည်", callback_data: `delete_single_confirm:${emailAddr}:${emailIndex}` }],
            [{ text: "⬅️ Inbox သို့ပြန်သွားရန်", callback_data: `view_inbox:${emailAddr}:${Math.floor(emailIndex / 5) + 1}` }]
        ]
    };
    await editMessage(chatId, messageId, text, keyboard, env);
}

async function markEmailUnread(chatId, messageId, emailAddr, emailIndex, env) {
    const emailKey = `email:${emailAddr}`;
    const emailData = await env.MAIL_BOT_DB.get(emailKey);
    if (!emailData) return;
    let { inbox, owner } = JSON.parse(emailData);
    if (inbox[emailIndex]) {
        inbox[emailIndex].read = false;
        await env.MAIL_BOT_DB.put(emailKey, JSON.stringify({ inbox, owner }));
    }
    await viewSingleEmail(chatId, messageId, emailAddr, emailIndex, env);
}

async function confirmDeleteSingleEmail(chatId, messageId, emailAddr, emailIndex, env) {
    const text = `🗑️ **အတည်ပြုပါ**\n\nဤအီးမေးလ်တစ်စောင်တည်းကိုသာ ဖျက်မှာသေချာလား?`;
    const keyboard = {
        inline_keyboard: [
            [{ text: "✅ ဟုတ်ကဲ့၊ ဖျက်မည်", callback_data: `delete_single_execute:${emailAddr}:${emailIndex}` }, { text: "❌ မဟုတ်ပါ", callback_data: `view_email:${emailAddr}:${emailIndex}` }]
        ]
    };
    await editMessage(chatId, messageId, text, keyboard, env);
}

async function deleteSingleEmail(chatId, messageId, emailAddr, emailIndex, env) {
    const emailKey = `email:${emailAddr}`;
    const emailData = await env.MAIL_BOT_DB.get(emailKey);
    if (!emailData) return;
    let { inbox, owner } = JSON.parse(emailData);
    if (inbox[emailIndex]) {
        inbox.splice(emailIndex, 1);
        await env.MAIL_BOT_DB.put(emailKey, JSON.stringify({ inbox, owner }));
    }
    await editMessage(chatId, messageId, "✅ အီးမေးလ်ကို အောင်မြင်စွာဖျက်ပြီးပါပြီ။", null, env);
    await showInboxList(chatId, messageId, emailAddr, 1, env);
}


// --- Admin Panel Functions ---
async function showAdminPanel(chatId, env, messageId = null) {
	const text = `⚙️ **Admin Control Panel**\n\nသင်သည် Admin အဖြစ်ဝင်ရောက်နေပါသည်။ အောက်ပါလုပ်ဆောင်ချက်များကို ရွေးချယ်ပါ။`;
	const keyboard = {
		inline_keyboard: [
			[{ text: "📊 Bot စာရင်းအချက်အလက်", callback_data: "admin_stats" }],
			[{ text: "👥 User များစာရင်း", callback_data: "admin_list_users:1" }],
			[{ text: "⏳ အသုံးမပြုတော့သော User များ", callback_data: "admin_inactive_users:30" }],
		],
	};
	if (messageId) {
		await editMessage(chatId, messageId, text, keyboard, env);
	} else {
		await sendMessage(chatId, text, keyboard, env);
	}
}

async function showAdminStats(chatId, messageId, env) {
	const allUserKeys = await env.MAIL_BOT_DB.list({ prefix: "user:" });
	const allEmailKeys = await env.MAIL_BOT_DB.list({ prefix: "email:" });
	const text = `📊 **Bot စာရင်းအချက်အလက်**\n\n- စုစုပေါင်း User အရေအတွက်: \`${allUserKeys.keys.length}\`\n- စုစုပေါင်း ဖန်တီးထားသော Email အရေအတွက်: \`${allEmailKeys.keys.length}\``;
	const keyboard = { inline_keyboard: [[{ text: "⬅️ Admin Panel သို့ပြန်သွားရန်", callback_data: "admin_panel" }]] };
	await editMessage(chatId, messageId, text, keyboard, env);
}

async function listAllUsers(chatId, messageId, page, env) {
	const allUserKeys = (await env.MAIL_BOT_DB.list({ prefix: "user:" })).keys;
	const usersPerPage = 5;
	const totalPages = Math.ceil(allUserKeys.length / usersPerPage);
	page = Math.max(1, Math.min(page, totalPages));
	const userPageKeys = allUserKeys.slice((page - 1) * usersPerPage, page * usersPerPage);

	let text = `👥 **Users List (Page ${page}/${totalPages})**\n\n`;
	const keyboardRows = userPageKeys.map(key => {
        const userId = key.name.split(":")[1];
        return [{ text: `👤 ${userId}`, callback_data: `admin_view_user:${userId}` }];
    });

	const paginationRow = [];
	if (page > 1) paginationRow.push({ text: "◀️ Prev", callback_data: `admin_list_users:${page - 1}` });
	if (page < totalPages) paginationRow.push({ text: "Next ▶️", callback_data: `admin_list_users:${page + 1}` });
	if (paginationRow.length > 0) keyboardRows.push(paginationRow);

	keyboardRows.push([{ text: "⬅️ Admin Panel သို့ပြန်သွားရန်", callback_data: "admin_panel" }]);
	await editMessage(chatId, messageId, text, { inline_keyboard: keyboardRows }, env);
}

async function viewUserAsAdmin(chatId, messageId, targetUserId, env) {
    const userData = await env.MAIL_BOT_DB.get(`user:${targetUserId}`);
    if (!userData || JSON.parse(userData).createdEmails.length === 0) {
        await editMessage(chatId, messageId, `User \`${targetUserId}\` တွင် ဖန်တီးထားသော email များမရှိပါ။`, {
            inline_keyboard: [[{ text: "⬅️ Users List သို့ပြန်သွားရန်", callback_data: "admin_list_users:1" }]]
        }, env);
        return;
    }
    const { createdEmails } = JSON.parse(userData);
    let text = `📧 **User: \`${targetUserId}\` ၏ Email များ**\n\n`;
    const keyboardRows = createdEmails.map(email => ([
        { text: `📥 ${email}`, callback_data: `view_inbox:${email}:1` },
        { text: "🗑️ Delete", callback_data: `admin_delete_user_email_confirm:${email}:${targetUserId}` }
    ]));
    keyboardRows.push([{ text: "⬅️ Users List သို့ပြန်သွားရန်", callback_data: "admin_list_users:1" }]);
    await editMessage(chatId, messageId, text, { inline_keyboard: keyboardRows }, env);
}

async function confirmDeleteEmailAsAdmin(chatId, messageId, emailToDelete, targetUserId, env) {
    const text = `🗑️ **Admin အတည်ပြုချက်**\n\nUser \`${targetUserId}\` ပိုင်ဆိုင်သော \`${emailToDelete}\` ကို ဖျက်မှာသေချာလား?`;
    const keyboard = {
        inline_keyboard: [
            [{ text: "✅ ဟုတ်ကဲ့၊ ဖျက်မည်", callback_data: `admin_delete_user_email_execute:${emailToDelete}:${targetUserId}` }],
            [{ text: "❌ မဟုတ်ပါ", callback_data: `admin_view_user:${targetUserId}` }]
        ]
    };
    await editMessage(chatId, messageId, text, keyboard, env);
}

async function deleteEmailAsAdmin(chatId, messageId, emailToDelete, targetUserId, env) {
    const userKey = `user:${targetUserId}`;
    const emailKey = `email:${emailToDelete}`;
    let userData = await env.MAIL_BOT_DB.get(userKey);
    if (userData) {
        let parsedData = JSON.parse(userData);
        parsedData.createdEmails = parsedData.createdEmails.filter(e => e !== emailToDelete);
        await env.MAIL_BOT_DB.put(userKey, JSON.stringify(parsedData));
    }
    await env.MAIL_BOT_DB.delete(emailKey);
    await editMessage(chatId, messageId, `✅ **Admin Action:**\nEmail \`${emailToDelete}\` ကို User \`${targetUserId}\` ထံမှ ဖျက်ပြီးပါပြီ။`, {
        inline_keyboard: [[{ text: "⬅️ User ကို ပြန်ကြည့်ရန်", callback_data: `admin_view_user:${targetUserId}` }]]
    }, env);
}

async function listInactiveUsers(chatId, messageId, days, env) {
    const allUserKeys = (await env.MAIL_BOT_DB.list({ prefix: "user:" })).keys;
    const inactiveUsers = [];
    const threshold = new Date();
    threshold.setDate(threshold.getDate() - days);

    for (const key of allUserKeys) {
        const userData = await env.MAIL_BOT_DB.get(key.name);
        if (userData) {
            const { lastActive } = JSON.parse(userData);
            if (!lastActive || new Date(lastActive) < threshold) {
                inactiveUsers.push(key.name.split(":")[1]);
            }
        }
    }
    let text = `⏳ **Inactive Users (ရက်ပေါင်း ${days} ကျော် အသုံးမပြုသူများ)**\n\n`;
    text += inactiveUsers.length === 0 ? "Inactive user မရှိပါ။" : inactiveUsers.map(id => `- \`${id}\``).join("\n");
    const keyboard = { inline_keyboard: [[{ text: "⬅️ Admin Panel သို့ပြန်သွားရန်", callback_data: "admin_panel" }]] };
    await editMessage(chatId, messageId, text, keyboard, env);
}

// --- Unchanged Helper Functions ---
async function trackUserActivity(userKey, env) { /* ... same as before ... */ }
async function requestEmailName(chatId, env) { /* ... same as before ... */ }
async function createNewEmail(chatId, name, env) { /* ... same as before ... */ }
async function confirmDeleteEmail(chatId, messageId, email, env) { /* ... same as before ... */ }
async function deleteEmail(chatId, messageId, email, env) { /* ... same as before ... */ }
async function generateRandomAddress(chatId, env, messageId = null) { /* ... same as before ... */ }
