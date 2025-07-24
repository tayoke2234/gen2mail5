/**
 * Cloudflare Worker for a Telegram Temporary Email Bot
 * Author: Gemini (with user-requested enhancements)
 * Language: Burmese (Comments & UI) & English (Code)
 * Version: 2.0
 *
 * --- New Features in this Version ---
 * 1.  Interactive Inbox: Instead of a single .txt file, the inbox is now a paginated list of buttons.
 * 2.  Individual Email Viewing: Users can click to view a single email's content.
 * 3.  Email Management:
 * - Emails are marked as 'read' automatically when viewed.
 * - Option to mark an email as 'unread'.
 * - Option to delete a single email from the inbox.
 * 4.  Clear Status Messages: Users are notified when the bot is loading or processing.
 * 5.  Enhanced Menu System: More interactive buttons for a better user experience.
 */

// --- Configuration ---
// These values are set in the Worker's environment variables (Settings -> Variables)
// BOT_TOKEN: Your Telegram bot token
// ADMIN_IDS: Comma-separated list of admin Telegram user IDs
// DOMAIN: The domain you are using for emails

// --- Main Handler ---
export default {
	/**
	 * Handles incoming HTTP requests from Telegram's webhook.
	 */
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

	/**
	 * Handles incoming emails via Cloudflare Email Routing.
	 */
	async email(message, env) {
		const to = message.to.toLowerCase();
		const emailKey = `email:${to}`;

		// Check if the email address was created by a user
		const emailData = await env.MAIL_BOT_DB.get(emailKey);
		if (!emailData) {
			message.setReject("Address does not exist in our system.");
			return;
		}

		// Read the email body stream
		const reader = message.raw.getReader();
		let chunks = [];
		while (true) {
			const {
				done,
				value
			} = await reader.read();
			if (done) break;
			chunks.push(value);
		}
		const rawEmail = new TextDecoder("utf-8").decode(
			new Uint8Array(
				chunks.reduce((acc, chunk) => [...acc, ...chunk], [])
			)
		);

		// Simple parsing for the email body
		const bodyMatch = rawEmail.match(/(?:\r\n\r\n|\n\n)([\s\S]*)/);
		const body = bodyMatch ? bodyMatch[1].trim() : "Empty Body";

		const newEmail = {
			from: message.headers.get("from") || "Unknown Sender",
			subject: message.headers.get("subject") || "No Subject",
			body: body,
			receivedAt: new Date().toISOString(),
			read: false, // NEW: Add read status, default to unread
		};

		let {
			inbox,
			owner
		} = JSON.parse(emailData);
		inbox.unshift(newEmail); // Add new email to the top

		// Save the updated inbox
		await env.MAIL_BOT_DB.put(emailKey, JSON.stringify({
			inbox,
			owner
		}));

		// Notify the user
		await sendMessage(
			owner,
			`📬 **လိပ်စာအသစ်ရောက်ရှိ!**\n\nသင်၏လိပ်စာ \`${to}\` သို့ email အသစ်တစ်စောင် ရောက်ရှိနေပါသည်။ \n\n/my_emails မှတစ်ဆင့် စစ်ဆေးနိုင်ပါသည်။`,
			null,
			env
		);
	},
};

// --- Telegram API Helper Functions ---

async function apiRequest(method, payload, env) {
	const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
	return await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json"
		},
		body: JSON.stringify(payload),
	});
}

async function sendMessage(chatId, text, reply_markup = null, env) {
	await apiRequest("sendMessage", {
		chat_id: chatId,
		text: text,
		parse_mode: "Markdown",
		reply_markup: reply_markup,
	}, env);
}

async function editMessage(chatId, messageId, text, reply_markup = null, env) {
	await apiRequest("editMessageText", {
		chat_id: chatId,
		message_id: messageId,
		text: text,
		parse_mode: "Markdown",
		reply_markup: reply_markup,
	}, env);
}

async function answerCallbackQuery(callbackQueryId, text = "", env) {
    await apiRequest("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        text: text,
    }, env);
}


// --- Message Handlers ---

async function handleMessage(message, env) {
	const chatId = message.chat.id;
	const text = message.text ? message.text.toLowerCase().trim() : "";
	const userKey = `user:${chatId}`;

	await trackUserActivity(userKey, env);

	// Handle reply for email creation
	if (message.reply_to_message && message.reply_to_message.text.includes("သင်အသုံးပြုလိုသော နာမည်ကိုထည့်ပါ")) {
		await createNewEmail(chatId, text.split(" ")[0], env);
		return;
	}

	// Command handling
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
			if (env.ADMIN_IDS.split(",").includes(chatId.toString())) {
				await showAdminPanel(chatId, env);
			} else {
				await sendMessage(chatId, "⛔ သင်သည် Admin မဟုတ်ပါ။", null, env);
			}
			break;
		default:
			await showUserPanel(chatId, env);
	}
}

// --- User-Facing Functions ---

async function showUserPanel(chatId, env) {
	const userKey = `user:${chatId}`;
	const userData = await env.MAIL_BOT_DB.get(userKey);
	const emailCount = userData ? JSON.parse(userData).createdEmails.length : 0;

	const text = `👋 **မင်္ဂလာပါ၊ Temp Mail Bot မှ ကြိုဆိုပါတယ်။**

သင်၏ကိုယ်ပိုင်ယာယီအီးမေးလ်များကို ဤနေရာတွင် ဖန်တီးနိုင်၊ စီမံခန့်ခွဲနိုင်ပါသည်။

- သင်၏ Telegram ID: \`${chatId}\`
- ဖန်တီးထားသော Email အရေအတွက်: \`${emailCount}\`

အောက်ပါခလုတ်များမှတစ်ဆင့် စီမံခန့်ခွဲနိုင်ပါသည်။`;
	const keyboard = {
		inline_keyboard: [
			[{
				text: "📧 Email များကြည့်ရန်",
				callback_data: "panel_my_emails"
			}],
			[{
				text: "➕ Email အသစ်ဖန်တီးရန်",
				callback_data: "panel_create"
			}],
			[{
				text: "🎲 ကျပန်းလိပ်စာ",
				callback_data: "panel_random"
			}],
		]
	};
	await sendMessage(chatId, text, keyboard, env);
}

async function listUserEmails(chatId, env) {
	const userKey = `user:${chatId}`;
	const userData = await env.MAIL_BOT_DB.get(userKey);

	if (!userData || JSON.parse(userData).createdEmails.length === 0) {
		await sendMessage(chatId, "텅နေပါသည်! သင်ဖန်တီးထားသော email များမရှိသေးပါ။\n/create ကိုနှိပ်ပြီး စတင်လိုက်ပါ။", null, env);
		return;
	}

	const {
		createdEmails
	} = JSON.parse(userData);
	const keyboard = [];
	for (const email of createdEmails) {
		keyboard.push([{
			text: `📥 Inbox: ${email}`,
			callback_data: `view_inbox:${email}:1` // Start at page 1
		}, {
			text: "🗑️ ဖျက်ရန်",
			callback_data: `delete_email:${email}`
		}, ]);
	}

	await sendMessage(chatId, "သင်၏ Email လိပ်စာများ:", {
		inline_keyboard: keyboard
	}, env);
}

// --- Callback Query Handlers ---

async function handleCallbackQuery(callbackQuery, env) {
	const chatId = callbackQuery.message.chat.id;
	const messageId = callbackQuery.message.message_id;
	const data = callbackQuery.data;
	const [action, ...params] = data.split(":");

	// Acknowledge the button press immediately
    await answerCallbackQuery(callbackQuery.id, "လုပ်ဆောင်နေပါသည်...", env);
    await trackUserActivity(`user:${chatId}`, env);

	switch (action) {
		// Main Panel
		case "panel_my_emails":
			await listUserEmails(chatId, env);
			break;
		case "panel_create":
			await requestEmailName(chatId, env);
			break;
		case "panel_random":
			await generateRandomAddress(chatId, env);
			break;

		// Inbox Viewing (New Flow)
		case "view_inbox":
			await showInboxList(chatId, messageId, params[0], parseInt(params[1] || 1), env);
			break;
        case "view_email":
            await viewSingleEmail(chatId, messageId, params[0], parseInt(params[1]), env);
            break;

		// Email Management (New)
        case "mark_unread":
            await markEmailUnread(chatId, messageId, params[0], parseInt(params[1]), env);
            break;
        case "delete_single_confirm":
            await confirmDeleteSingleEmail(chatId, messageId, params[0], parseInt(params[1]), env);
            break;
        case "delete_single_execute":
            await deleteSingleEmail(chatId, messageId, params[0], parseInt(params[1]), env);
            break;

		// Email Deletion (Whole Address)
		case "delete_email":
			await confirmDeleteEmail(chatId, messageId, params[0], env);
			break;
		case "delete_confirm":
			await deleteEmail(chatId, messageId, params[0], env);
			break;
		case "delete_cancel":
			await editMessage(chatId, messageId, "ဖျက်ခြင်းကို ပယ်ဖျက်လိုက်ပါသည်။", null, env);
			break;

		// Random Address Generation
		case "create_random":
			await createNewEmail(chatId, params[0], env);
			await editMessage(chatId, messageId, `✅ ကျပန်းလိပ်စာ \`${params[0]}@${env.DOMAIN}\` ကို အောင်မြင်စွာဖန်တီးပြီးပါပြီ။`, null, env);
			break;
		case "generate_another":
			await generateRandomAddress(chatId, env, messageId);
			break;

		// Admin actions
		case "admin_stats":
			await showAdminStats(chatId, messageId, env);
			break;
		case "admin_list_users":
			await listAllUsers(chatId, messageId, parseInt(params[0] || 1), env);
			break;
		case "admin_back":
			await showAdminPanel(chatId, env, messageId);
			break;
        // Other admin cases can be added here...
	}
}

// --- NEW/UPDATED: Interactive Inbox Functions ---

async function showInboxList(chatId, messageId, email, page = 1, env) {
    const emailKey = `email:${email}`;
    const emailData = await env.MAIL_BOT_DB.get(emailKey);

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
    const end = start + emailsPerPage;
    const emailPage = inbox.slice(start, end);

    let text = `📥 **Inbox: \`${email}\`** (စာမျက်နှာ ${page}/${totalPages})\n`;
    const keyboardRows = [];

    emailPage.forEach((mail, index) => {
        const globalIndex = start + index;
        const readStatus = mail.read ? "" : "🆕 ";
        const subject = (mail.subject || "No Subject").substring(0, 25);
        const from = (mail.from || "Unknown").split('<')[0].trim().substring(0, 20);
        keyboardRows.push([
            { text: `${readStatus}${from} | ${subject}`, callback_data: `view_email:${email}:${globalIndex}` }
        ]);
    });

    const paginationRow = [];
    if (page > 1) {
        paginationRow.push({ text: "◀️ ရှေ့", callback_data: `view_inbox:${email}:${page - 1}` });
    }
    paginationRow.push({ text: "🔄", callback_data: `view_inbox:${email}:${page}` });
    if (page < totalPages) {
        paginationRow.push({ text: "နောက် ▶️", callback_data: `view_inbox:${email}:${page + 1}` });
    }
    keyboardRows.push(paginationRow);
    keyboardRows.push([{ text: "⬅️ Email List သို့ပြန်သွားရန်", callback_data: "panel_my_emails" }]);

    await editMessage(chatId, messageId, text, { inline_keyboard: keyboardRows }, env);
}

async function viewSingleEmail(chatId, messageId, emailAddr, emailIndex, env) {
    const emailKey = `email:${emailAddr}`;
    const emailData = await env.MAIL_BOT_DB.get(emailKey);
    if (!emailData) { /* handle error */ return; }

    let { inbox, owner } = JSON.parse(emailData);
    const email = inbox[emailIndex];
    if (!email) { /* handle error */ return; }

    let needsUpdate = false;
    if (!email.read) {
        email.read = true;
        needsUpdate = true;
    }

    let bodyText = email.body || "Empty Body";
    if (bodyText.length > 3500) {
        bodyText = bodyText.substring(0, 3500) + "\n\n... (message truncated)";
    }

    let text = `**From:** \`${email.from}\`\n`;
    text += `**Subject:** \`${email.subject}\`\n`;
    text += `**Date:** \`${new Date(email.receivedAt).toLocaleString('en-GB')}\`\n`;
    text += `-------------------------\n${bodyText}`;

    const keyboard = {
        inline_keyboard: [
            [{ text: "မဖတ်ရသေးဟု သတ်မှတ်မည်", callback_data: `mark_unread:${emailAddr}:${emailIndex}` }, { text: "🗑️ ဖျက်မည်", callback_data: `delete_single_confirm:${emailAddr}:${emailIndex}` }],
            [{ text: "⬅️ Inbox သို့ပြန်သွားရန်", callback_data: `view_inbox:${emailAddr}:${Math.floor(emailIndex / 5) + 1}` }]
        ]
    };

    await editMessage(chatId, messageId, text, keyboard, env);

    if (needsUpdate) {
        await env.MAIL_BOT_DB.put(emailKey, JSON.stringify({ inbox, owner }));
    }
}

async function markEmailUnread(chatId, messageId, emailAddr, emailIndex, env) {
    const emailKey = `email:${emailAddr}`;
    const emailData = await env.MAIL_BOT_DB.get(emailKey);
    if (!emailData) { return; }

    let { inbox, owner } = JSON.parse(emailData);
    if (inbox[emailIndex]) {
        inbox[emailIndex].read = false;
        await env.MAIL_BOT_DB.put(emailKey, JSON.stringify({ inbox, owner }));
    }
    // Refresh the view
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
    if (!emailData) { return; }

    let { inbox, owner } = JSON.parse(emailData);
    if (inbox[emailIndex]) {
        inbox.splice(emailIndex, 1); // Remove the email from array
        await env.MAIL_BOT_DB.put(emailKey, JSON.stringify({ inbox, owner }));
    }
    await editMessage(chatId, messageId, "✅ အီးမေးလ်ကို အောင်မြင်စွာဖျက်ပြီးပါပြီ။", null, env);
    // Go back to inbox list
    await showInboxList(chatId, messageId, emailAddr, 1, env);
}


// --- Other Functions (Mostly Unchanged) ---

async function requestEmailName(chatId, env) {
    const text = `📧 **Email လိပ်စာအသစ် ဖန်တီးခြင်း**

သင်အသုံးပြုလိုသော နာမည်ကိုထည့်ပါ။ (Space မပါစေရ၊ English အက္ခရာနှင့် ဂဏန်းများသာ)။

**အရေးကြီး:** ဤ Message ကို **Reply** လုပ်ပြီး နာမည်ထည့်ပေးပါ။

ဥပမာ: \`myname123\`

Bot မှ သင့်နာမည်နောက်တွင် \`@${env.DOMAIN}\` ကို အလိုအလျောက် ထည့်ပေးပါလိမ့်မည်။`;
    const replyMarkup = { force_reply: true, selective: true, input_field_placeholder: 'your-name-here' };
    await sendMessage(chatId, text, replyMarkup, env);
}

async function createNewEmail(chatId, name, env) {
	if (!/^[a-z0-9.-]+$/.test(name)) {
		await sendMessage(chatId, "❌ **မှားယွင်းနေပါသည်!**\nနာမည်တွင် English အက္ခရာ အသေး (a-z)၊ ဂဏန်း (0-9)၊ နှင့် `.` `-` တို့သာ ပါဝင်ရပါမည်။ Space မပါရပါ။\n\n/create ကိုပြန်နှိပ်ပြီး ထပ်ကြိုးစားပါ။", null, env);
		return;
	}
	const email = `${name.toLowerCase()}@${env.DOMAIN}`;
	const emailKey = `email:${email}`;
	const userKey = `user:${chatId}`;
	const existingEmail = await env.MAIL_BOT_DB.get(emailKey);
	if (existingEmail) {
		await sendMessage(chatId, `😥 **လိပ်စာအသုံးပြုပြီးသားပါ။**\n\`${email}\` သည် အခြားသူတစ်ယောက် အသုံးပြုနေပါသည်။ နာမည်အသစ်တစ်ခု ထပ်ကြိုးစားပါ။`, null, env);
		return;
	}
	await env.MAIL_BOT_DB.put(emailKey, JSON.stringify({ inbox: [], owner: chatId }));
	let userData = await env.MAIL_BOT_DB.get(userKey);
	userData = userData ? JSON.parse(userData) : { createdEmails: [], lastActive: new Date().toISOString() };
	userData.createdEmails.push(email);
	await env.MAIL_BOT_DB.put(userKey, JSON.stringify(userData));
	await sendMessage(chatId, `✅ **အောင်မြင်ပါသည်!**\nသင်၏ email လိပ်စာအသစ်မှာ:\n\n\`${email}\`\n\n/my_emails ကိုနှိပ်ပြီး စီမံခန့်ခွဲနိုင်ပါသည်။`, null, env);
}

async function confirmDeleteEmail(chatId, messageId, email, env) {
	const text = `🗑️ **အတည်ပြုပါ**\n\nသင် \`${email}\` လိပ်စာတစ်ခုလုံးကို အပြီးတိုင် ဖျက်လိုပါသလား? Inbox ထဲမှ email များအားလုံးပါ ဖျက်သိမ်းသွားမည်ဖြစ်ပြီး ဤလုပ်ဆောင်ချက်ကို နောက်ပြန်လှည့်၍မရပါ။`;
	const keyboard = {
		inline_keyboard: [
			[{ text: "✅ ဟုတ်ကဲ့၊ ဖျက်မည်", callback_data: `delete_confirm:${email}` }, { text: "❌ မဟုတ်ပါ", callback_data: "delete_cancel" }, ],
		],
	};
	await editMessage(chatId, messageId, text, keyboard, env);
}

async function deleteEmail(chatId, messageId, email, env) {
	const userKey = `user:${chatId}`;
	const emailKey = `email:${email}`;
	let userData = await env.MAIL_BOT_DB.get(userKey);
	if (userData) {
		let parsedData = JSON.parse(userData);
		parsedData.createdEmails = parsedData.createdEmails.filter(e => e !== email);
		await env.MAIL_BOT_DB.put(userKey, JSON.stringify(parsedData));
	}
	await env.MAIL_BOT_DB.delete(emailKey);
	await editMessage(chatId, messageId, `✅ **အောင်မြင်စွာဖျက်ပြီးပါပြီ။**\nလိပ်စာ \`${email}\` ကို ဖျက်လိုက်ပါပြီ။`, null, env);
}

async function generateRandomAddress(chatId, env, messageId = null) {
    const cities = ["yangon", "mandalay", "naypyitaw", "bago", "mawlamyine", "pathein", "taunggyi", "sittwe", "myitkyina"];
    const nouns = ["post", "mail", "box", "connect", "link", "service"];
    const randomCity = cities[Math.floor(Math.random() * cities.length)];
    const randomNoun = nouns[Math.floor(Math.random() * nouns.length)];
    const randomNumber = Math.floor(100 + Math.random() * 900);
    const randomName = `${randomCity}.${randomNoun}${randomNumber}`;
    const text = `🎲 **ကျပန်းလိပ်စာ**\n\nအကြံပြုထားသော လိပ်စာမှာ:\n\`${randomName}@${env.DOMAIN}\`\n\nသင်ဤလိပ်စာကို အသုံးပြုလိုပါသလား?`;
    const keyboard = {
        inline_keyboard: [
            [{ text: "✅ ဒီလိပ်စာကို ဖန်တီးမည်", callback_data: `create_random:${randomName}` }],
            [{ text: "🎲 နောက်တစ်ခု", callback_data: "generate_another" }]
        ]
    };
    if (messageId) {
        await editMessage(chatId, messageId, text, keyboard, env);
    } else {
        await sendMessage(chatId, text, keyboard, env);
    }
}

async function trackUserActivity(userKey, env) {
	let userData = await env.MAIL_BOT_DB.get(userKey);
	let parsedData;
	if (userData) {
		parsedData = JSON.parse(userData);
	} else {
		parsedData = { createdEmails: [] };
	}
	parsedData.lastActive = new Date().toISOString();
	await env.MAIL_BOT_DB.put(userKey, JSON.stringify(parsedData));
}

// Admin functions are omitted for brevity but would be here...
async function showAdminPanel(chatId, env, messageId = null) { /* ... */ }
async function showAdminStats(chatId, messageId, env) { /* ... */ }
async function listAllUsers(chatId, messageId, page, env) { /* ... */ }
