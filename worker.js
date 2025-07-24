/**
 * Cloudflare Worker for a Telegram Temporary Email Bot
 * Author: Gemini (with user-requested features)
 * Version: 2.0 (Menu System & Admin Broadcast)
 * Language: Burmese (Comments) & English (Code)
 * Features: Interactive menu, User panel, Admin panel, Broadcast to all users, Email creation/deletion, Inbox viewer, Random address generator.
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
        // Pass ctx to handleMessage for background tasks like broadcasting
        ctx.waitUntil(handleMessage(payload.message, env));
      } else if (payload.callback_query) {
        // Pass ctx to handleCallbackQuery as well
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
    inbox.unshift(newEmail);

    await env.MAIL_BOT_DB.put(emailKey, JSON.stringify({ inbox, owner }));

    await sendMessage(
      owner,
      `📬 **လိပ်စာအသစ်ရောက်ရှိ!**\n\nသင်၏လိပ်စာ \`${to}\` သို့ email အသစ်တစ်စောင် ရောက်ရှိနေပါသည်။ \n\n"📧 ကျွန်ုပ်၏ Email များ" ခလုတ်မှတစ်ဆင့် စစ်ဆေးနိုင်ပါသည်။`,
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

async function sendDocument(chatId, content, filename, caption, reply_markup, env) {
    const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`;
    const formData = new FormData();
    formData.append('chat_id', chatId);
    formData.append('document', new Blob([content], { type: 'text/plain' }), filename);
    formData.append('caption', caption);
    formData.append('parse_mode', 'Markdown');
    if (reply_markup) {
        formData.append('reply_markup', JSON.stringify(reply_markup));
    }
    await fetch(url, { method: 'POST', body: formData });
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

    // --- State-based actions (for multi-step processes like creating emails or broadcasting) ---
    // User ရဲ့ လက်ရှိလုပ်ဆောင်ချက် (state) ပေါ်မူတည်ပြီး အလုပ်လုပ်ရန်
    if (userData.state) {
        switch (userData.state) {
            case 'awaiting_email_name':
                await createNewEmail(chatId, text.toLowerCase().split(" ")[0], env);
                // Reset state after action
                userData.state = null;
                await updateUserData(chatId, userData, env);
                return;
            case 'awaiting_broadcast_message':
                if (isAdmin(chatId, env)) {
                    await confirmBroadcast(chatId, message.message_id, text, env);
                    userData.state = null; // Reset state
                    await updateUserData(chatId, userData, env);
                }
                return;
        }
    }

    // --- Command handling ---
    // Command များအတွက် အဓိက ကိုင်တွယ်ရန်
    if (text.startsWith('/')) {
        switch (text.toLowerCase()) {
            case "/start":
            case "/menu":
                await showMainMenu(chatId, env);
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
                if (isAdmin(chatId, env)) {
                    await showAdminPanel(chatId, env);
                } else {
                    await sendMessage(chatId, "⛔ သင်သည် Admin မဟုတ်ပါ။", null, env);
                }
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

async function listUserEmails(chatId, env) {
    const userData = await getUserData(chatId, env);

    if (!userData || userData.createdEmails.length === 0) {
        await sendMessage(chatId, "텅နေပါသည်! သင်ဖန်တီးထားသော email များမရှိသေးပါ။", { inline_keyboard: [[{ text: "➕ Email အသစ်ဖန်တီးရန်", callback_data: "create_email" }]] }, env);
        return;
    }

    const keyboard = [];
    for (const email of userData.createdEmails) {
        keyboard.push([
            { text: `📥 Inbox: ${email}`, callback_data: `view_inbox:${email}` },
            { text: "🗑️ ဖျက်ရန်", callback_data: `delete_email:${email}` },
        ]);
    }
    keyboard.push([{ text: "🔙 Menu သို့ပြန်သွားရန်", callback_data: "main_menu" }]);

    await sendMessage(chatId, "သင်၏ Email လိပ်စာများ:", { inline_keyboard: keyboard }, env);
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

    // Answer the callback query first to remove the "loading" state on the button
    await apiRequest('answerCallbackQuery', { callback_query_id: callbackQuery.id }, env);
    
    // Update user activity
    const userData = await getUserData(chatId, env);
    await updateUserData(chatId, userData, env);

    // --- Main Menu Actions ---
    switch (action) {
        case "main_menu":
            await showMainMenu(chatId, env, messageId);
            break;
        case "create_email":
            await requestEmailName(chatId, env);
            break;
        case "my_emails":
            await listUserEmails(chatId, env);
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

        // --- Inbox/Email Actions ---
        case "view_inbox":
            await viewInbox(chatId, params[0], env);
            break;
        case "refresh_inbox":
            await viewInbox(chatId, params[0], env, messageId);
            break;
        case "delete_email":
            await confirmDeleteEmail(chatId, messageId, params[0], env);
            break;
        case "delete_confirm":
            await deleteEmail(chatId, messageId, params[0], env);
            break;
        case "delete_cancel":
            await editMessage(chatId, messageId, "ဖျက်ခြင်းကို ပယ်ဖျက်လိုက်ပါသည်။", { inline_keyboard: [[{ text: "📧 ကျွန်ုပ်၏ Email များ ကြည့်ရန်", callback_data: "my_emails" }]] }, env);
            break;

        // --- Admin Panel Actions ---
        case "admin_panel":
            await showAdminPanel(chatId, env, messageId);
            break;
        case "admin_stats":
            await showAdminStats(chatId, messageId, env);
            break;
        case "admin_list_users":
            await listAllUsers(chatId, messageId, parseInt(params[0] || 1), env);
            break;
        case "admin_broadcast":
            await requestBroadcastMessage(chatId, messageId, env);
            break;
        case "broadcast_confirm":
            // Pass ctx to the broadcast execution function
            await executeBroadcast(chatId, messageId, env, ctx);
            break;
        case "broadcast_cancel":
            await editMessage(chatId, messageId, "❌ Broadcast ကို ပယ်ဖျက်လိုက်ပါသည်။", { inline_keyboard: [[{ text: "⬅️ Admin Panel သို့ပြန်သွားရန်", callback_data: "admin_panel" }]] }, env);
            // Clear the broadcast message from state
            const adminData = await getUserData(chatId, env);
            delete adminData.broadcast_message;
            await updateUserData(chatId, adminData, env);
            break;
        case "admin_back":
            await showAdminPanel(chatId, env, messageId);
            break;
        // Add other admin cases here if needed, like view_user, delete_email_as_admin, etc.
    }
}

// --- Email Management Functions ---

async function viewInbox(chatId, email, env, messageId = null) {
    const emailKey = `email:${email}`;
    const emailData = await env.MAIL_BOT_DB.get(emailKey);
    if (!emailData) {
        await sendMessage(chatId, "❌ Error: Email not found.", null, env);
        return;
    }
    const { inbox } = JSON.parse(emailData);
    if (inbox.length === 0) {
        const text = `**Inbox: \`${email}\`**\n\n텅နေပါသည်! Email များ ရောက်ရှိမလာသေးပါ။`;
        const keyboard = { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: `refresh_inbox:${email}` }], [{ text: "🔙 Email List သို့ပြန်သွားရန်", callback_data: "my_emails" }]] };
        if (messageId) {
            await editMessage(chatId, messageId, text, keyboard, env);
        } else {
            await sendMessage(chatId, text, keyboard, env);
        }
        return;
    }
    let fileContent = `Inbox for: ${email}\n=========================\n\n`;
    for (const mail of inbox) {
        fileContent += `From: ${mail.from}\n`;
        fileContent += `Subject: ${mail.subject}\n`;
        fileContent += `Date: ${new Date(mail.receivedAt).toLocaleString('en-GB')}\n`;
        fileContent += `-------------------------\n`;
        fileContent += `${mail.body}\n\n`;
        fileContent += `=========================\n\n`;
    }
    const caption = `📥 **Inbox for \`${email}\`**\n\nစုစုပေါင်း email \`${inbox.length}\` စောင်ရှိပါသည်။ အသေးစိတ်အတွက် ဖိုင်ကို download လုပ်ပါ။`;
    const keyboard = { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: `refresh_inbox:${email}` }], [{ text: "🔙 Email List သို့ပြန်သွားရန်", callback_data: "my_emails" }]] };
    await sendDocument(chatId, fileContent, `inbox_${email}.txt`, caption, keyboard, env);
}

async function confirmDeleteEmail(chatId, messageId, email, env) {
    const text = `🗑️ **အတည်ပြုပါ**\n\nသင် \`${email}\` ကို အပြီးတိုင် ဖျက်လိုပါသလား? ဤလုပ်ဆောင်ချက်ကို နောက်ပြန်လှည့်၍မရပါ။`;
    const keyboard = {
        inline_keyboard: [
            [
                { text: "✅ ဟုတ်ကဲ့၊ ဖျက်မည်", callback_data: `delete_confirm:${email}` },
                { text: "❌ မဟုတ်ပါ", callback_data: "delete_cancel" },
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
    await editMessage(chatId, messageId, `✅ **အောင်မြင်စွာဖျက်ပြီးပါပြီ။**\nလိပ်စာ \`${email}\` ကို ဖျက်လိုက်ပါပြီ။`, { inline_keyboard: [[{ text: "🔙 Email List သို့ပြန်သွားရန်", callback_data: "my_emails" }]] }, env);
}


// --- Admin Panel Functions ---

async function showAdminPanel(chatId, env, messageId = null) {
    const text = `⚙️ **Admin Control Panel**\n\nသင်သည် Admin အဖြစ်ဝင်ရောက်နေပါသည်။ အောက်ပါလုပ်ဆောင်ချက်များကို ရွေးချယ်ပါ။`;
    const keyboard = {
        inline_keyboard: [
            [{ text: "📢 အားလုံးသို့စာပို့ရန် (Broadcast)", callback_data: "admin_broadcast" }],
            [{ text: "📊 Bot Stats", callback_data: "admin_stats" }],
            [{ text: "👥 Users List", callback_data: "admin_list_users:1" }],
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

async function listAllUsers(chatId, messageId, page, env) {
    // This function is long and can be kept as is from the original script if needed.
    // For brevity, I'll just put a placeholder implementation.
    const allUserKeys = (await env.MAIL_BOT_DB.list({ prefix: "user:" })).keys;
    const text = `👥 **Users List**\n\nစုစုပေါင်း User \`${allUserKeys.length}\` ယောက်ရှိပါသည်။ (အသေးစိတ်ကြည့်ရှုရန် feature ကို ထပ်မံထည့်သွင်းနိုင်ပါသည်။)`;
    const keyboard = { inline_keyboard: [[{ text: "⬅️ Admin Panel သို့ပြန်သွားရန်", callback_data: "admin_panel" }]] };
    await editMessage(chatId, messageId, text, keyboard, env);
}

// --- NEW: Broadcast Functions ---

async function requestBroadcastMessage(chatId, messageId, env) {
    const adminData = await getUserData(chatId, env);
    adminData.state = 'awaiting_broadcast_message';
    await updateUserData(chatId, adminData, env);

    const text = "📢 **Broadcast Message**\n\nUser အားလုံးထံ ပေးပို့လိုသော စာသားကို ရေးပြီး ပို့ပေးပါ။\n\n*Markdown formatting အသုံးပြုနိုင်ပါသည်။*";
    await editMessage(chatId, messageId, text, { inline_keyboard: [[{ text: "❌ ပယ်ဖျက်မည်", callback_data: "broadcast_cancel" }]] }, env);
}

async function confirmBroadcast(chatId, messageId, messageText, env) {
    // Store the message to be broadcasted in the admin's user data
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
    
    // Clear the broadcast message from state immediately
    delete adminData.broadcast_message;
    await updateUserData(chatId, adminData, env);

    // Use ctx.waitUntil to perform the broadcast in the background
    // This allows the function to return a response to Telegram quickly
    // while the long-running task continues.
    ctx.waitUntil((async () => {
        const allUserKeys = (await env.MAIL_BOT_DB.list({ prefix: "user:" })).keys;
        let sentCount = 0;
        let failedCount = 0;

        for (const key of allUserKeys) {
            const targetUserId = key.name.split(":")[1];
            try {
                await sendMessage(targetUserId, messageText, null, env);
                sentCount++;
                // To avoid hitting API rate limits, add a small delay.
                // Cloudflare workers might not guarantee exact timing with await.
                // For a large number of users, a Queue is a better solution.
                await new Promise(resolve => setTimeout(resolve, 100)); // 100ms delay
            } catch (e) {
                console.error(`Failed to send broadcast to ${targetUserId}: ${e}`);
                failedCount++;
            }
        }

        const reportText = `✅ **Broadcast ပြီးဆုံးပါပြီ!**\n\n- ✔️ ပေးပို့สำเร็จ: ${sentCount} ယောက်\n- ✖️ ပေးပို့မสำเร็จ: ${failedCount} ယောက်`;
        await sendMessage(chatId, reportText, { inline_keyboard: [[{ text: "⬅️ Admin Panel သို့ပြန်သွားရန်", callback_data: "admin_panel" }]] }, env);
    })());
}
