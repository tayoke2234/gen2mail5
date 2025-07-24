/**
 * Cloudflare Worker for a Telegram Temporary Email Bot
 * Author: Gemini (with user-requested features)
 * Version: 3.1 (Broadcast Stability Fix)
 * Language: Burmese (Comments) & English (Code)
 * Features: Interactive menu, Paginated inbox, Clear single email view, Admin panel, Broadcast, Email management.
 * Database: Cloudflare KV
 * Email Receiving: Cloudflare Email Routing
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
  async fetch(request, env, ctx) {
    if (request.method === "POST") {
      const payload = await request.json();
      if (payload.message) {
        ctx.waitUntil(handleMessage(payload.message, env));
      } else if (payload.callback_query) {
        ctx.waitUntil(handleCallbackQuery(payload.callback_query, env, ctx));
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

    const emailData = await env.MAIL_BOT_DB.get(emailKey);
    if (!emailData) {
      message.setReject("Address does not exist.");
      return;
    }

    const reader = message.raw.getReader();
    let chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const rawEmail = new TextDecoder("utf-8").decode(
      new Uint8Array(
        chunks.reduce((acc, chunk) => [...acc, ...chunk], [])
      )
    );

    const bodyMatch = rawEmail.match(/(?:\r\n\r\n|\n\n)([\s\S]*)/);
    const body = bodyMatch ? bodyMatch[1].trim() : "Empty Body";

    const newEmail = {
      from: message.headers.get("from") || "Unknown Sender",
      subject: message.headers.get("subject") || "No Subject",
      body: body,
      receivedAt: new Date().toISOString(),
    };

    let { inbox, owner } = JSON.parse(emailData);
    inbox.unshift(newEmail); // Add new email to the top

    await env.MAIL_BOT_DB.put(emailKey, JSON.stringify({ inbox, owner }));

    await sendMessage(
      owner,
      `📬 **Email အသစ်ရောက်ရှိ!**\n\nသင်၏လိပ်စာ \`${to}\` သို့ email အသစ်တစ်စောင် ရောက်ရှိနေပါသည်။ \n\n"📧 ကျွန်ုပ်၏ Email များ" ခလုတ်မှတစ်ဆင့် စစ်ဆေးနိုင်ပါသည်။`,
      null,
      env
    );
  },
};

// --- Telegram API Helper Functions ---

async function apiRequest(method, payload, env) {
    const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
    const options = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    };
    return await fetch(url, options);
}

async function sendMessage(chatId, text, reply_markup = null, env) {
    const payload = { chat_id: chatId, text, parse_mode: "Markdown" };
    if (reply_markup) payload.reply_markup = reply_markup;
    return apiRequest('sendMessage', payload, env);
}

async function editMessage(chatId, messageId, text, reply_markup = null, env) {
    const payload = { chat_id: chatId, message_id: messageId, text, parse_mode: "Markdown" };
    if (reply_markup) payload.reply_markup = reply_markup;
    return apiRequest('editMessageText', payload, env);
}

// --- State and User Management ---

async function getUserData(chatId, env) {
    const userKey = `user:${chatId}`;
    const data = await env.MAIL_BOT_DB.get(userKey);
    return data ? JSON.parse(data) : { createdEmails: [], lastActive: null, state: null };
}

async function updateUserData(chatId, data, env) {
    const userKey = `user:${chatId}`;
    data.lastActive = new Date().toISOString();
    await env.MAIL_BOT_DB.put(userKey, JSON.stringify(data));
}

function isAdmin(chatId, env) {
    return env.ADMIN_IDS.split(",").includes(chatId.toString());
}

// --- Message Handlers ---

async function handleMessage(message, env) {
    const chatId = message.chat.id;
    const text = message.text ? message.text.trim() : "";
    const userData = await getUserData(chatId, env);

    if (userData.state) {
        switch (userData.state) {
            case 'awaiting_email_name':
                await createNewEmail(chatId, text.toLowerCase().split(" ")[0], env);
                userData.state = null;
                await updateUserData(chatId, userData, env);
                return;
            case 'awaiting_broadcast_message':
                if (isAdmin(chatId, env)) {
                    await confirmBroadcast(chatId, message.message_id, text, env);
                    userData.state = null;
                    await updateUserData(chatId, userData, env);
                }
                return;
        }
    }

    if (text.startsWith('/')) {
        switch (text.toLowerCase()) {
            case "/start":
            case "/menu":
                await showMainMenu(chatId, env);
                break;
            default:
                await sendMessage(chatId, "🤔 Command ကို နားမလည်ပါ။ /start ကိုနှိပ်ပြီး menu ကိုပြန်ခေါ်နိုင်ပါသည်။", null, env);
        }
    }
}

// --- Main Menu and Core Features ---

async function showMainMenu(chatId, env, messageId = null) {
    const text = `👋 **မင်္ဂလာပါ၊ Temp Mail Bot မှ ကြိုဆိုပါတယ်။**\n\nအောက်ပါ Menu မှတစ်ဆင့် လုပ်ဆောင်ချက်များကို ရွေးချယ်နိုင်ပါသည်။`;
    const keyboard = {
        inline_keyboard: [
            [{ text: "➕ Email အသစ်ဖန်တီးရန်", callback_data: "create_email" }],
            [{ text: "🎲 ကျပန်းလိပ်စာ ဖန်တီးရန်", callback_data: "random_address" }],
            [{ text: "📧 ကျွန်ုပ်၏ Email များ", callback_data: "my_emails" }],
        ]
    };

    if (isAdmin(chatId, env)) {
        keyboard.inline_keyboard.push([{ text: "👑 Admin Panel", callback_data: "admin_panel" }]);
    }

    if (messageId) {
        await editMessage(chatId, messageId, text, keyboard, env);
    } else {
        await sendMessage(chatId, text, keyboard, env);
    }
}

async function requestEmailName(chatId, env) {
    const userData = await getUserData(chatId, env);
    userData.state = 'awaiting_email_name';
    await updateUserData(chatId, userData, env);

    const text = `📧 **Email လိပ်စာအသစ် ဖန်တီးခြင်း**\n\nသင်အသုံးပြုလိုသော နာမည်ကို စာပြန်ရိုက်ထည့်ပေးပါ။ (Space မပါစေရ၊ English အက္ခရာနှင့် ဂဏန်းများသာ)။\n\nဥပမာ: \`myname123\`\n\nBot မှ သင့်နာမည်နောက်တွင် \`@${env.DOMAIN}\` ကို အလိုအလျောက် ထည့်ပေးပါလိမ့်မည်။`;
    await sendMessage(chatId, text, { inline_keyboard: [[{ text: "🔙 Menu သို့ပြန်သွားရန်", callback_data: "main_menu" }]] }, env);
}

async function createNewEmail(chatId, name, env) {
    if (!/^[a-z0-9.-]+$/.test(name)) {
        await sendMessage(chatId, "❌ **မှားယွင်းနေပါသည်!**\nနာမည်တွင် English အက္ခရာ အသေး (a-z)၊ ဂဏန်း (0-9)၊ နှင့် `.` `-` တို့သာ ပါဝင်ရပါမည်။ Space မပါရပါ။\n\nခလုတ်ကိုနှိပ်ပြီး ထပ်ကြိုးစားပါ။", { inline_keyboard: [[{ text: '➕ ထပ်ကြိုးစားမည်', callback_data: 'create_email' }]] }, env);
        return;
    }

    const email = `${name.toLowerCase()}@${env.DOMAIN}`;
    const emailKey = `email:${email}`;
    const existingEmail = await env.MAIL_BOT_DB.get(emailKey);
    if (existingEmail) {
        await sendMessage(chatId, `😥 **လိပ်စာအသုံးပြုပြီးသားပါ။**\n\`${email}\` သည် အခြားသူတစ်ယောက် အသုံးပြုနေပါသည်။ နာမည်အသစ်တစ်ခု ထပ်ကြိုးစားပါ။`, { inline_keyboard: [[{ text: '➕ ထပ်ကြိုးစားမည်', callback_data: 'create_email' }]] }, env);
        return;
    }

    await env.MAIL_BOT_DB.put(emailKey, JSON.stringify({ inbox: [], owner: chatId }));

    const userData = await getUserData(chatId, env);
    if (!userData.createdEmails.includes(email)) {
        userData.createdEmails.push(email);
    }
    await updateUserData(chatId, userData, env);

    await sendMessage(chatId, `✅ **အောင်မြင်ပါသည်!**\nသင်၏ email လိပ်စာအသစ်မှာ:\n\n\`${email}\`\n\n"📧 ကျွန်ုပ်၏ Email များ" ကိုနှိပ်ပြီး စီမံခန့်ခွဲနိုင်ပါသည်။`, { inline_keyboard: [[{ text: "🔙 Menu သို့ပြန်သွားရန်", callback_data: "main_menu" }]] }, env);
}

async function listUserEmails(chatId, env, messageId = null) {
    const userData = await getUserData(chatId, env);

    if (!userData || userData.createdEmails.length === 0) {
        const text = "텅နေပါသည်! သင်ဖန်တီးထားသော email များမရှိသေးပါ။";
        const keyboard = { inline_keyboard: [[{ text: "➕ Email အသစ်ဖန်တီးရန်", callback_data: "create_email" }], [{ text: "🔙 Menu သို့ပြန်သွားရန်", callback_data: "main_menu" }]] };
        if (messageId) await editMessage(chatId, messageId, text, keyboard, env);
        else await sendMessage(chatId, text, keyboard, env);
        return;
    }

    const keyboard = [];
    for (const email of userData.createdEmails) {
        keyboard.push([{ text: `📬 ${email}`, callback_data: `view_inbox:${email}:1` }]);
    }
    keyboard.push([{ text: "🔙 Menu သို့ပြန်သွားရန်", callback_data: "main_menu" }]);

    const textToSend = "သင်၏ Email လိပ်စာများအား ကြည့်ရှုရန် (သို့) စီမံရန် ရွေးချယ်ပါ:";
    if (messageId) {
        await editMessage(chatId, messageId, textToSend, { inline_keyboard: keyboard }, env);
    } else {
        await sendMessage(chatId, textToSend, { inline_keyboard: keyboard }, env);
    }
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
            [{ text: "🎲 နောက်တစ်ခု", callback_data: "generate_another" }],
            [{ text: "🔙 Menu သို့ပြန်သွားရန်", callback_data: "main_menu" }]
        ]
    };

    if (messageId) {
        await editMessage(chatId, messageId, text, keyboard, env);
    } else {
        await sendMessage(chatId, text, keyboard, env);
    }
}

// --- Callback Query Handlers ---

async function handleCallbackQuery(callbackQuery, env, ctx) {
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data = callbackQuery.data;
    const [action, ...params] = data.split(":");

    await apiRequest('answerCallbackQuery', { callback_query_id: callbackQuery.id }, env);
    
    const userData = await getUserData(chatId, env);
    await updateUserData(chatId, userData, env);

    switch (action) {
        // --- Main Menu & Creation ---
        case "main_menu":
            await showMainMenu(chatId, env, messageId);
            break;
        case "create_email":
            await requestEmailName(chatId, env);
            break;
        case "my_emails":
            await listUserEmails(chatId, env, messageId);
            break;
        case "random_address":
            await generateRandomAddress(chatId, env, messageId);
            break;
        case "create_random":
            await createNewEmail(chatId, params[0], env);
            await editMessage(chatId, messageId, `✅ ကျပန်းလိပ်စာ \`${params[0]}@${env.DOMAIN}\` ကို အောင်မြင်စွာဖန်တီးပြီးပါပြီ။`, { inline_keyboard: [[{ text: "🔙 Menu သို့ပြန်သွားရန်", callback_data: "main_menu" }]] }, env);
            break;
        case "generate_another":
            await generateRandomAddress(chatId, env, messageId);
            break;

        // --- Inbox and Email Viewing ---
        case "view_inbox":
            await viewInbox(chatId, messageId, params[0], parseInt(params[1] || 1), env);
            break;
        case "view_email":
            await viewSingleEmail(chatId, messageId, params[0], parseInt(params[1]), parseInt(params[2]), env);
            break;
        
        // --- Email Deletion ---
        case "delete_email_prompt":
            await confirmDeleteEmail(chatId, messageId, params[0], env);
            break;
        case "delete_email_confirm":
            await deleteEmail(chatId, messageId, params[0], env);
            break;

        // --- Admin Panel ---
        case "admin_panel":
        case "admin_back":
            await showAdminPanel(chatId, env, messageId);
            break;
        case "admin_stats":
            await showAdminStats(chatId, messageId, env);
            break;
        case "admin_broadcast":
            await requestBroadcastMessage(chatId, messageId, env);
            break;
        case "broadcast_confirm":
            await executeBroadcast(chatId, messageId, env, ctx);
            break;
        case "broadcast_cancel":
            // **FIXED**: This now correctly clears the user's state.
            await editMessage(chatId, messageId, "❌ Broadcast ကို ပယ်ဖျက်လိုက်ပါသည်။", { inline_keyboard: [[{ text: "⬅️ Admin Panel သို့ပြန်သွားရန်", callback_data: "admin_panel" }]] }, env);
            const adminData = await getUserData(chatId, env);
            delete adminData.broadcast_message; // Clear message if it exists
            adminData.state = null; // Reset the state
            await updateUserData(chatId, adminData, env);
            break;
    }
}

// --- Email Viewing Functions ---

async function viewInbox(chatId, messageId, emailAddress, page, env) {
    const emailKey = `email:${emailAddress}`;
    const emailData = await env.MAIL_BOT_DB.get(emailKey);
    const { inbox } = emailData ? JSON.parse(emailData) : { inbox: [] };

    const EMAILS_PER_PAGE = 5;
    const totalPages = Math.ceil(inbox.length / EMAILS_PER_PAGE);
    page = Math.max(1, Math.min(page, totalPages));

    const startIndex = (page - 1) * EMAILS_PER_PAGE;
    const endIndex = startIndex + EMAILS_PER_PAGE;
    const pageEmails = inbox.slice(startIndex, endIndex);

    let text = `📥 **Inbox for \`${emailAddress}\`**\n\n`;
    const keyboard = [];

    if (inbox.length === 0) {
        text += "텅နေပါသည်! Email များ ရောက်ရှိမလာသေးပါ။";
    } else {
        text += `စာမျက်နှာ ${page}/${totalPages} | စုစုပေါင်း ${inbox.length} စောင်`;
        pageEmails.forEach((mail, index) => {
            const originalIndex = startIndex + index;
            const subject = mail.subject.substring(0, 25) + (mail.subject.length > 25 ? '...' : '');
            keyboard.push([{ text: `📧 ${subject}`, callback_data: `view_email:${emailAddress}:${originalIndex}:${page}` }]);
        });
    }

    const paginationRow = [];
    if (page > 1) {
        paginationRow.push({ text: "◀️ ရှေ့へ", callback_data: `view_inbox:${emailAddress}:${page - 1}` });
    }
    if (page < totalPages) {
        paginationRow.push({ text: "နောက်へ ▶️", callback_data: `view_inbox:${emailAddress}:${page + 1}` });
    }
    if (paginationRow.length > 0) {
        keyboard.push(paginationRow);
    }
    
    keyboard.push([
        { text: "🔄 Refresh", callback_data: `view_inbox:${emailAddress}:${page}` },
        { text: "🗑️ ဖျက်ရန်", callback_data: `delete_email_prompt:${emailAddress}` }
    ]);
    keyboard.push([{ text: "🔙 ကျွန်ုပ်၏ Email များသို့", callback_data: "my_emails" }]);
    
    await editMessage(chatId, messageId, text, { inline_keyboard: keyboard }, env);
}

async function viewSingleEmail(chatId, messageId, emailAddress, emailIndex, fromPage, env) {
    const emailKey = `email:${emailAddress}`;
    const emailData = await env.MAIL_BOT_DB.get(emailKey);
    if (!emailData) {
        await editMessage(chatId, messageId, "❌ Error: Email not found.", null, env);
        return;
    }
    const { inbox } = JSON.parse(emailData);
    const mail = inbox[emailIndex];

    if (!mail) {
        await editMessage(chatId, messageId, "❌ Error: Could not retrieve this specific email.", null, env);
        return;
    }
    
    const body = mail.body.length > 3500 ? mail.body.substring(0, 3500) + "\n\n[...Message Truncated...]" : mail.body;

    let text = `**From:** \`${mail.from}\`\n`;
    text += `**Subject:** \`${mail.subject}\`\n`;
    text += `**Received:** \`${new Date(mail.receivedAt).toLocaleString('en-GB')}\`\n`;
    text += `\n----------------------------------------\n\n${body}`;

    const keyboard = {
        inline_keyboard: [
            [{ text: `🔙 Inbox (Page ${fromPage}) သို့ပြန်သွားရန်`, callback_data: `view_inbox:${emailAddress}:${fromPage}` }]
        ]
    };

    await editMessage(chatId, messageId, text, keyboard, env);
}


// --- Email Deletion Functions ---

async function confirmDeleteEmail(chatId, messageId, email, env) {
    const text = `🗑️ **အတည်ပြုပါ**\n\nသင် \`${email}\` ကို အပြီးတိုင် ဖျက်လိုပါသလား? ဤလုပ်ဆောင်ချက်ကို နောက်ပြန်လှည့်၍မရပါ။ Inbox ထဲမှ စာများအားလုံးပါ ဖျက်ပစ်ပါမည်။`;
    const keyboard = {
        inline_keyboard: [
            [
                { text: "✅ ဟုတ်ကဲ့၊ ဖျက်မည်", callback_data: `delete_email_confirm:${email}` },
                { text: "❌ မဟုတ်ပါ", callback_data: `view_inbox:${email}:1` },
            ],
        ],
    };
    await editMessage(chatId, messageId, text, keyboard, env);
}

async function deleteEmail(chatId, messageId, email, env) {
    const emailKey = `email:${email}`;
    const userData = await getUserData(chatId, env);
    if (userData) {
        userData.createdEmails = userData.createdEmails.filter(e => e !== email);
        await updateUserData(chatId, userData, env);
    }
    await env.MAIL_BOT_DB.delete(emailKey);
    await editMessage(chatId, messageId, `✅ **အောင်မြင်စွာဖျက်ပြီးပါပြီ။**\nလိပ်စာ \`${email}\` ကို ဖျက်လိုက်ပါပြီ။`, { inline_keyboard: [[{ text: "🔙 ကျွန်ုပ်၏ Email များသို့", callback_data: "my_emails" }]] }, env);
}


// --- Admin Panel Functions ---

async function showAdminPanel(chatId, env, messageId = null) {
    const text = `⚙️ **Admin Control Panel**\n\nသင်သည် Admin အဖြစ်ဝင်ရောက်နေပါသည်။ အောက်ပါလုပ်ဆောင်ချက်များကို ရွေးချယ်ပါ။`;
    const keyboard = {
        inline_keyboard: [
            [{ text: "📢 အားလုံးသို့စာပို့ရန် (Broadcast)", callback_data: "admin_broadcast" }],
            [{ text: "📊 Bot Stats", callback_data: "admin_stats" }],
            [{ text: "🔙 Main Menu သို့ပြန်သွားရန်", callback_data: "main_menu" }],
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
    const text = `📊 **Bot Statistics**\n\n- စုစုပေါင်း User အရေအတွက်: \`${allUserKeys.keys.length}\`\n- စုစုပေါင်း ဖန်တီးထားသော Email အရေအတွက်: \`${allEmailKeys.keys.length}\``;
    const keyboard = { inline_keyboard: [[{ text: "⬅️ Admin Panel သို့ပြန်သွားရန်", callback_data: "admin_panel" }]] };
    await editMessage(chatId, messageId, text, keyboard, env);
}

async function requestBroadcastMessage(chatId, messageId, env) {
    const adminData = await getUserData(chatId, env);
    adminData.state = 'awaiting_broadcast_message';
    // **FIXED**: Clear any old, stale message data before starting a new broadcast.
    delete adminData.broadcast_message;
    await updateUserData(chatId, adminData, env);

    const text = "📢 **Broadcast Message**\n\nUser အားလုံးထံ ပေးပို့လိုသော စာသားကို ရေးပြီး ပို့ပေးပါ။\n\n*Markdown formatting အသုံးပြုနိုင်ပါသည်။*";
    await editMessage(chatId, messageId, text, { inline_keyboard: [[{ text: "❌ ပယ်ဖျက်မည်", callback_data: "broadcast_cancel" }]] }, env);
}

async function confirmBroadcast(chatId, messageId, messageText, env) {
    const adminData = await getUserData(chatId, env);
    adminData.broadcast_message = messageText;
    await updateUserData(chatId, adminData, env);

    const text = `--- Preview ---\n\n${messageText}\n\n-----------------\n⚠️ အထက်ပါစာကို အသုံးပြုသူအားလုံးထံ ပေးပို့မှာသေချာလား?`;
    const keyboard = {
        inline_keyboard: [
            [
                { text: "✅ ဟုတ်ကဲ့၊ ပို့မည်", callback_data: `broadcast_confirm` },
                { text: "❌ မဟုတ်ပါ", callback_data: "broadcast_cancel" },
            ],
        ],
    };
    await sendMessage(chatId, text, keyboard, env);
}

async function executeBroadcast(chatId, messageId, env, ctx) {
    const adminData = await getUserData(chatId, env);
    const messageText = adminData.broadcast_message;

    if (!messageText) {
        await editMessage(chatId, messageId, "❌ Error: Broadcast message not found. Please try again.", { inline_keyboard: [[{ text: "⬅️ Admin Panel သို့ပြန်သွားရန်", callback_data: "admin_panel" }]] }, env);
        return;
    }

    await editMessage(chatId, messageId, "⏳ Broadcast ကို စတင်ပို့ဆောင်နေပါပြီ... ပြီးဆုံးပါက အကြောင်းကြားပါမည်။", null, env);
    
    delete adminData.broadcast_message;
    await updateUserData(chatId, adminData, env);

    ctx.waitUntil((async () => {
        const allUserKeys = (await env.MAIL_BOT_DB.list({ prefix: "user:" })).keys;
        let sentCount = 0;
        let failedCount = 0;

        for (const key of allUserKeys) {
            const targetUserId = key.name.split(":")[1];
            try {
                await sendMessage(targetUserId, messageText, null, env);
                sentCount++;
                await new Promise(resolve => setTimeout(resolve, 100));
            } catch (e) {
                console.error(`Failed to send broadcast to ${targetUserId}: ${e}`);
                failedCount++;
            }
        }

        const reportText = `✅ **Broadcast ပြီးဆုံးပါပြီ!**\n\n- ✔️ ပေးပို့สำเร็จ: ${sentCount} ယောက်\n- ✖️ ပေးပို့မสำเร็จ: ${failedCount} ယောက်`;
        await sendMessage(chatId, reportText, { inline_keyboard: [[{ text: "⬅️ Admin Panel သို့ပြန်သွားရန်", callback_data: "admin_panel" }]] }, env);
    })());
}
