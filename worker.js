/**
 * Cloudflare Worker for a Telegram Temporary Email Bot
 * Author: Gemini (with user-requested features)
 * Version: 5.0 (Inbox, Broadcast, and Admin Panel Fixes)
 * Language: Burmese (Comments) & English (Code)
 * Features: Interactive menu, Paginated inbox, User stats, Email forwarding setup, Admin panel, Broadcast, Email management, User management for admins.
 * Database: Cloudflare KV
 * Email Receiving: Cloudflare Email Routing
 * External Service: SendGrid (for forwarding)
 */

// --- Configuration ---
// These values are set in the Worker's environment variables (Settings -> Variables)
// BOT_TOKEN: Your Telegram bot token
// ADMIN_IDS: Comma-separated list of admin Telegram user IDs
// DOMAIN: The domain you are using for emails
// SENDGRID_API_KEY: Your API key from SendGrid for sending forwarded emails.
// FORWARD_FROM_EMAIL: The email address SendGrid is authorized to send from (e.g., bot@yourdomain.com)

// --- Main Handler ---
export default {
  /**
   * Handles incoming HTTP requests from Telegram's webhook.
   */
  async fetch(request, env, ctx) {
    if (request.method === "POST") {
      try {
        const payload = await request.json();
        if (payload.message) {
          ctx.waitUntil(handleMessage(payload.message, env));
        } else if (payload.callback_query) {
          ctx.waitUntil(handleCallbackQuery(payload.callback_query, env, ctx));
        }
      } catch (e) {
        console.error("Error parsing payload:", e);
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

    const emailDataJSON = await env.MAIL_BOT_DB.get(emailKey);
    if (!emailDataJSON) {
      console.log(`Email rejected for non-existent address: ${to}`);
      message.setReject("Address does not exist.");
      return;
    }

    // Parse the raw email to get the body
    const reader = message.raw.getReader();
    let chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const rawEmailBytes = new Uint8Array(chunks.reduce((acc, chunk) => [...acc, ...chunk], []));
    const rawEmail = new TextDecoder("utf-8").decode(rawEmailBytes);

    // A more reliable way to find the body
    const bodyMatch = rawEmail.match(/(?:\r\n\r\n|\n\n)([\s\S]*)/);
    let body = bodyMatch ? bodyMatch[1].trim() : "Empty Body";
    // If the body is base64 encoded, try to decode it
    if (message.headers.get("content-transfer-encoding")?.toLowerCase() === 'base64') {
        try {
            body = atob(body.replace(/\s/g, ''));
        } catch (e) {
            console.log("Could not decode base64 body, using as is.");
        }
    }

    const newEmail = {
      from: message.headers.get("from") || "Unknown Sender",
      subject: message.headers.get("subject") || "No Subject",
      body: body,
      receivedAt: new Date().toISOString(),
    };

    let { inbox, owner } = JSON.parse(emailDataJSON);
    inbox.unshift(newEmail); // Add new email to the top

    await env.MAIL_BOT_DB.put(emailKey, JSON.stringify({ inbox, owner }));

    // Notify the user
    await sendMessage(
      owner,
      `📬 **Email အသစ်ရောက်ရှိ!**\n\nသင်၏လိပ်စာ \`${to}\` သို့ email အသစ်တစ်စောင် ရောက်ရှိနေပါသည်။ \n\n"📧 ကျွန်ုပ်၏ Email များ" ခလုတ်မှတစ်ဆင့် စစ်ဆေးနိုင်ပါသည်။`,
      null,
      env
    );
      
    // Forward the email if configured
    const userData = await getUserData(owner, env);
    if (userData && userData.forwardEmail) {
        await forwardEmailWithThirdParty(userData.forwardEmail, newEmail, env);
    }
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
    const response = await fetch(url, options);
    if (!response.ok) {
        const errorBody = await response.json();
        console.error(`Telegram API Error (${method}):`, errorBody);
    }
    return response;
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
    return data ? JSON.parse(data) : { createdEmails: [], lastActive: null, state: null, forwardEmail: null };
}

async function updateUserData(chatId, data, env) {
    const userKey = `user:${chatId}`;
    data.lastActive = new Date().toISOString();
    await env.MAIL_BOT_DB.put(userKey, JSON.stringify(data));
}

function isAdmin(chatId, env) {
    const adminIds = env.ADMIN_IDS ? env.ADMIN_IDS.split(",") : [];
    return adminIds.includes(chatId.toString());
}

// --- Message Handlers ---

async function handleMessage(message, env) {
    const chatId = message.chat.id;
    const text = message.text ? message.text.trim() : "";
    const userData = await getUserData(chatId, env);

    // Handle state-based inputs
    if (userData.state) {
        let stateHandled = true;
        switch (userData.state) {
            case 'awaiting_email_name':
                await createNewEmail(chatId, text.toLowerCase().split(" ")[0], userData, env);
                break;
            case 'awaiting_forward_email':
                await setForwardEmail(chatId, text, userData, env);
                break;
            case 'awaiting_broadcast_message':
                if (isAdmin(chatId, env)) {
                    // Use the new stateless broadcast confirmation
                    await confirmBroadcast(chatId, text, env);
                }
                break;
            default:
                stateHandled = false;
        }
        if (stateHandled) {
            userData.state = null;
            await updateUserData(chatId, userData, env);
            return;
        }
    }

    // Handle commands
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
            [{ text: "⚙️ Forwarding တပ်ဆင်ရန်", callback_data: "setup_forwarding" }],
            [{ text: "📊 ကျွန်ုပ်၏ စာရင်းအင်း", callback_data: "user_stats" }],
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

// --- Callback Query Handlers ---

async function handleCallbackQuery(callbackQuery, env, ctx) {
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data = callbackQuery.data;
    const [action, ...params] = data.split(":");

    // Answer the callback query immediately to prevent the "loading" state on the client
    await apiRequest('answerCallbackQuery', { callback_query_id: callbackQuery.id }, env);
    
    // Update user's last active time
    const userData = await getUserData(chatId, env);
    await updateUserData(chatId, userData, env); // This also saves any state changes from previous steps

    switch (action) {
        // Main Menu
        case "main_menu": await showMainMenu(chatId, env, messageId); break;
        
        // Email Creation
        case "create_email": await requestEmailName(chatId, messageId, env); break;
        case "random_address": await generateRandomAddress(chatId, env, messageId); break;
        case "create_random": 
            await createNewEmail(chatId, params[0], userData, env);
            await updateUserData(chatId, userData, env); // Save immediately
            await editMessage(chatId, messageId, `✅ ကျပန်းလိပ်စာ \`${params[0]}@${env.DOMAIN}\` ကို အောင်မြင်စွာဖန်တီးပြီးပါပြီ။`, { inline_keyboard: [[{ text: "🔙 Menu သို့ပြန်သွားရန်", callback_data: "main_menu" }]] }, env);
            break;
        case "generate_another": await generateRandomAddress(chatId, env, messageId); break;

        // Email Viewing & Management
        case "my_emails": await listUserEmails(chatId, env, messageId); break;
        case "view_inbox": await viewInbox(chatId, messageId, params[0], parseInt(params[1] || 1), env); break;
        case "view_email": await viewSingleEmail(chatId, messageId, params[0], parseInt(params[1]), parseInt(params[2]), env); break;
        
        // Email Deletion
        case "delete_email_prompt": await confirmDeleteEmail(chatId, messageId, params[0], env); break;
        case "delete_email_confirm": await deleteEmail(chatId, messageId, params[0], env); break;

        // User Features
        case "user_stats": await showUserStats(chatId, messageId, env); break;
        case "setup_forwarding": await showForwardingSetup(chatId, messageId, env); break;
        case "set_forward_email": await requestForwardEmail(chatId, messageId, env); break;
        case "remove_forward_email": await removeForwardEmail(chatId, messageId, env); break;

        // --- Admin Panel ---
        case "admin_panel": case "admin_back": await showAdminPanel(chatId, env, messageId); break;
        case "admin_stats": await showAdminStats(chatId, messageId, env); break;
        
        // Broadcast (New Stateless Flow)
        case "admin_broadcast": await requestBroadcastMessage(chatId, messageId, env); break;
        case "broadcast_confirm": 
            // The UUID of the message is in params[0]
            await executeBroadcast(chatId, messageId, params[0], env, ctx); 
            break;
        case "broadcast_cancel":
            await editMessage(chatId, messageId, "❌ Broadcast ကို ပယ်ဖျက်လိုက်ပါသည်။", { inline_keyboard: [[{ text: "⬅️ Admin Panel သို့ပြန်သွားရန်", callback_data: "admin_panel" }]] }, env);
            break;

        // User Management (New Feature)
        case "admin_manage_users": await listAllUsers(chatId, messageId, 1, env); break;
        case "list_users_page": await listAllUsers(chatId, messageId, parseInt(params[0]), env); break;
        case "admin_view_user": await showUserEmailsForAdmin(chatId, messageId, params[0], parseInt(params[1]), env); break;
        case "admin_delete_prompt":
            // params are: targetUserId, encodedEmail, fromUserListPage
            await confirmDeleteUserEmailForAdmin(chatId, messageId, params[0], params[1], params[2], env);
            break;
        case "admin_delete_confirm":
            // params are: targetUserId, encodedEmail, fromUserListPage
            await deleteUserEmailForAdmin(chatId, messageId, params[0], params[1], params[2], env);
            break;
    }
}


// --- Email Creation and Management ---

async function createNewEmail(chatId, name, userData, env) {
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
    
    if (!userData.createdEmails.includes(email)) {
        userData.createdEmails.push(email);
    }
    // The calling function is responsible for saving the userData
    
    await sendMessage(chatId, `✅ **အောင်မြင်ပါသည်!**\nသင်၏ email လိပ်စာအသစ်မှာ:\n\n\`${email}\`\n\n"📧 ကျွန်ုပ်၏ Email များ" ကိုနှိပ်ပြီး စီမံခန့်ခွဲနိုင်ပါသည်။`, { inline_keyboard: [[{ text: "🔙 Menu သို့ပြန်သွားရန်", callback_data: "main_menu" }]] }, env);
}

async function requestEmailName(chatId, messageId, env) {
    const userData = await getUserData(chatId, env);
    userData.state = 'awaiting_email_name';
    await updateUserData(chatId, userData, env);
    const text = `📧 **Email လိပ်စာအသစ် ဖန်တီးခြင်း**\n\nသင်အသုံးပြုလိုသော နာမည်ကို စာပြန်ရိုက်ထည့်ပေးပါ။ (Space မပါစေရ၊ English အက္ခရာနှင့် ဂဏန်းများသာ)။\n\nဥပမာ: \`myname123\`\n\nBot မှ သင့်နာမည်နောက်တွင် \`@${env.DOMAIN}\` ကို အလိုအလျောက် ထည့်ပေးပါလိမ့်မည်။`;
    await editMessage(chatId, messageId, text, { inline_keyboard: [[{ text: "🔙 Menu သို့ပြန်သွားရန်", callback_data: "main_menu" }]] }, env);
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

async function viewInbox(chatId, messageId, emailAddress, page, env) {
    const emailKey = `email:${emailAddress}`;
    const emailDataJSON = await env.MAIL_BOT_DB.get(emailKey);
    const { inbox } = emailDataJSON ? JSON.parse(emailDataJSON) : { inbox: [] };
    const EMAILS_PER_PAGE = 5;
    const totalPages = Math.max(1, Math.ceil(inbox.length / EMAILS_PER_PAGE));
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
            // FIX: The callback data is correct. The issue is in the handler.
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

// --- FIX 1: INBOX VIEW FIX ---
async function viewSingleEmail(chatId, messageId, emailAddress, emailIndex, fromPage, env) {
    // Show a loading message to the user immediately for better UX
    await editMessage(chatId, messageId, "⏳ Email ကို ဖွင့်နေပါသည်...", null, env);

    try {
        const emailKey = `email:${emailAddress}`;
        const emailDataJSON = await env.MAIL_BOT_DB.get(emailKey);

        if (!emailDataJSON) {
            await editMessage(chatId, messageId, "❌ **Error**\nEmail data ကို ရှာမတွေ့ပါ။ ဖျက်လိုက်ပြီး ဖြစ်နိုင်ပါသည်။", { inline_keyboard: [[{ text: `🔙 Inbox သို့ပြန်သွားရန်`, callback_data: `view_inbox:${emailAddress}:${fromPage}` }]] }, env);
            return;
        }

        const { inbox } = JSON.parse(emailDataJSON);
        const mail = inbox[emailIndex];

        if (!mail) {
            await editMessage(chatId, messageId, "❌ **Error**\nဤ email ကို ဆွဲထုတ်၍မရပါ။ Inbox ကို refresh လုပ်ပြီး ပြန်စမ်းကြည့်ပါ။", { inline_keyboard: [[{ text: `🔙 Inbox သို့ပြန်သွားရန်`, callback_data: `view_inbox:${emailAddress}:${fromPage}` }]] }, env);
            return;
        }

        // Truncate body to avoid hitting Telegram's message length limit
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

    } catch (error) {
        console.error("Error in viewSingleEmail:", error);
        await editMessage(chatId, messageId, "❌ **System Error**\nEmail ကိုပြသရာတွင် အမှားအယွင်းတစ်ခု ဖြစ်ပွားခဲ့ပါသည်။", { inline_keyboard: [[{ text: `🔙 Inbox သို့ပြန်သွားရန်`, callback_data: `view_inbox:${emailAddress}:${fromPage}` }]] }, env);
    }
}

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


// --- User Stats and Forwarding ---

async function showUserStats(chatId, messageId, env) {
    const userData = await getUserData(chatId, env);
    const emailCount = userData.createdEmails.length;
    let totalMessages = 0;

    for (const emailAddress of userData.createdEmails) {
        const emailKey = `email:${emailAddress}`;
        const emailDataJSON = await env.MAIL_BOT_DB.get(emailKey);
        if (emailDataJSON) {
            const emailData = JSON.parse(emailDataJSON);
            totalMessages += emailData.inbox.length;
        }
    }

    let text = `📊 **သင်၏ စာရင်းအင်းများ**\n\n`;
    text += `- 📧 ဖန်တီးထားသော Email အရေအတွက်: \`${emailCount}\`\n`;
    text += `- 📥 လက်ခံရရှိသော စာစုစုပေါင်း: \`${totalMessages}\`\n`;

    const keyboard = { inline_keyboard: [[{ text: "🔙 Menu သို့ပြန်သွားရန်", callback_data: "main_menu" }]] };
    await editMessage(chatId, messageId, text, keyboard, env);
}

async function showForwardingSetup(chatId, messageId, env) {
    const userData = await getUserData(chatId, env);
    let text = `⚙️ **Email Forwarding တပ်ဆင်ခြင်း**\n\nဤနေရာမှ သင်၏ယာယီလိပ်စာများသို့ ရောက်လာသော email များကို သင်၏ email အစစ်ဆီသို့ အလိုအလျောက် ပေးပို့ရန် 설정နိုင်ပါသည်။\n\n`;
    text += `**လက်ရှိအခြေအနေ:** `;
    
    const keyboard_rows = [];

    if (userData.forwardEmail) {
        text += `Forwarding လုပ်ရန် 설정ထားသော လိပ်စာမှာ \`${userData.forwardEmail}\` ဖြစ်ပါသည်။`;
        keyboard_rows.push([{ text: "🔄 Forwarding လိပ်စာပြောင်းရန်", callback_data: "set_forward_email" }]);
        keyboard_rows.push([{ text: "➖ Forwarding ကိုပယ်ဖျက်ရန်", callback_data: "remove_forward_email" }]);
    } else {
        text += `Forwarding မလုပ်ထားပါ။`;
        keyboard_rows.push([{ text: "➕ Forwarding လိပ်စာထည့်ရန်", callback_data: "set_forward_email" }]);
    }

    keyboard_rows.push([{ text: "🔙 Menu သို့ပြန်သွားရန်", callback_data: "main_menu" }]);
    await editMessage(chatId, messageId, text, { inline_keyboard: keyboard_rows }, env);
}

async function requestForwardEmail(chatId, messageId, env) {
    const userData = await getUserData(chatId, env);
    userData.state = 'awaiting_forward_email';
    await updateUserData(chatId, userData, env);

    const text = ` forward လုပ်လိုသော သင်၏ email အစစ်ကို ရိုက်ထည့်ပေးပါ။\n\nဥပမာ: \`my.real.email@gmail.com\``;
    await editMessage(chatId, messageId, text, { inline_keyboard: [[{ text: "🔙 Forwarding Setup သို့ပြန်သွားရန်", callback_data: "setup_forwarding" }]] }, env);
}

async function setForwardEmail(chatId, email, userData, env) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        await sendMessage(chatId, `❌ **Email ပုံစံမမှန်ပါ။** \`${email}\` သည် မှန်ကန်သော email address မဟုတ်ပါ။ ထပ်ကြိုးစားပါ။`, { inline_keyboard: [[{ text: '➕ ထပ်ကြိုးစားမည်', callback_data: 'set_forward_email' }]] }, env);
        return;
    }
    userData.forwardEmail = email;
    // Calling function will save userData
    await sendMessage(chatId, `✅ **အောင်မြင်ပါသည်။**\n\nယခုမှစ၍ email အသစ်များဝင်လာပါက \`${email}\` သို့ forward လုပ်ပေးပါမည်။`, { inline_keyboard: [[{ text: '🔙 Menu သို့ပြန်သွားရန်', callback_data: 'main_menu' }]] }, env);
}

async function removeForwardEmail(chatId, messageId, env) {
    const userData = await getUserData(chatId, env);
    userData.forwardEmail = null;
    await updateUserData(chatId, userData, env);

    const text = `✅ **Forwarding ကို ပယ်ဖျက်ပြီးပါပြီ။**\n\nယခုမှစ၍ email များကို forward လုပ်တော့မည်မဟုတ်ပါ။`;
    await editMessage(chatId, messageId, text, { inline_keyboard: [[{ text: '🔙 Menu သို့ပြန်သွားရန်', callback_data: 'main_menu' }]] }, env);
}

async function forwardEmailWithThirdParty(forwardTo, emailContent, env) {
    if (!env.SENDGRID_API_KEY || !env.FORWARD_FROM_EMAIL) {
        console.error("SendGrid API Key or From Email not configured. Skipping forward.");
        return;
    }
    const forwardBody = `<p>--- This is an automated forward from your Temp Mail Bot ---</p><p><b>Original Sender:</b> ${emailContent.from}</p><p><b>Original Subject:</b> ${emailContent.subject}</p><hr><div>${emailContent.body.replace(/\n/g, '<br>')}</div>`;
    const sendGridPayload = {
        personalizations: [{ to: [{ email: forwardTo }] }],
        from: { email: env.FORWARD_FROM_EMAIL, name: "Temp Mail Bot" },
        subject: `[Forwarded] ${emailContent.subject}`,
        content: [{ type: "text/html", value: forwardBody }],
    };
    try {
        const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
            method: "POST",
            headers: { "Authorization": `Bearer ${env.SENDGRID_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify(sendGridPayload),
        });
        if (!response.ok) {
            const errorBody = await response.text();
            console.error(`SendGrid Error: ${response.status} ${response.statusText} - ${errorBody}`);
        } else {
            console.log(`Successfully forwarded email to ${forwardTo}`);
        }
    } catch (error) {
        console.error("Failed to forward email via SendGrid:", error);
    }
}


// --- Admin Panel Functions ---

async function showAdminPanel(chatId, env, messageId = null) {
    const text = `⚙️ **Admin Control Panel**\n\nသင်သည် Admin အဖြစ်ဝင်ရောက်နေပါသည်။ အောက်ပါလုပ်ဆောင်ချက်များကို ရွေးချယ်ပါ။`;
    const keyboard = {
        inline_keyboard: [
            [{ text: "📢 အားလုံးသို့စာပို့ရန် (Broadcast)", callback_data: "admin_broadcast" }],
            [{ text: "📊 Bot Stats", callback_data: "admin_stats" }],
            // FIX 3: Add User Management Button
            [{ text: "👤 User Management", callback_data: "admin_manage_users" }],
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
    // Using .list() is inefficient for large numbers of keys.
    // For a more scalable solution, you would typically maintain counters.
    // But for moderate use, this is acceptable.
    const allUserKeys = await env.MAIL_BOT_DB.list({ prefix: "user:" });
    const allEmailKeys = await env.MAIL_BOT_DB.list({ prefix: "email:" });
    const text = `📊 **Bot Statistics**\n\n- စုစုပေါင်း User အရေအတွက်: \`${allUserKeys.keys.length}\`\n- စုစုပေါင်း ဖန်တီးထားသော Email အရေအတွက်: \`${allEmailKeys.keys.length}\``;
    const keyboard = { inline_keyboard: [[{ text: "⬅️ Admin Panel သို့ပြန်သွားရန်", callback_data: "admin_panel" }]] };
    await editMessage(chatId, messageId, text, keyboard, env);
}

// --- FIX 2: STATELESS BROADCAST ---

async function requestBroadcastMessage(chatId, messageId, env) {
    const adminData = await getUserData(chatId, env);
    adminData.state = 'awaiting_broadcast_message';
    await updateUserData(chatId, adminData, env);
    const text = "📢 **Broadcast Message**\n\nUser အားလုံးထံ ပေးပို့လိုသော စာသားကို ရေးပြီး ပို့ပေးပါ။\n\n*Markdown formatting အသုံးပြုနိုင်ပါသည်။*";
    await editMessage(chatId, messageId, text, { inline_keyboard: [[{ text: "❌ ပယ်ဖျက်မည်", callback_data: "admin_panel" }]] }, env); // Go back to admin panel on cancel
}

async function confirmBroadcast(chatId, messageText, env) {
    // This function is now called from handleMessage
    const broadcastId = crypto.randomUUID();
    // Store the message temporarily with a short expiration (e.g., 10 minutes)
    await env.MAIL_BOT_DB.put(`broadcast:${broadcastId}`, messageText, { expirationTtl: 600 });

    const text = `--- Preview ---\n\n${messageText}\n\n-----------------\n⚠️ အထက်ပါစာကို အသုံးပြုသူအားလုံးထံ ပေးပို့မှာသေချာလား?`;
    const keyboard = {
        inline_keyboard: [
            [
                { text: "✅ ဟုတ်ကဲ့၊ ပို့မည်", callback_data: `broadcast_confirm:${broadcastId}` },
                { text: "❌ မဟုတ်ပါ", callback_data: "broadcast_cancel" },
            ],
        ],
    };
    await sendMessage(chatId, text, keyboard, env);
}

async function executeBroadcast(chatId, messageId, broadcastId, env, ctx) {
    const messageText = await env.MAIL_BOT_DB.get(`broadcast:${broadcastId}`);
    
    if (!messageText) {
        await editMessage(chatId, messageId, "❌ **Error:** Broadcast message not found or has expired. Please try again.", { inline_keyboard: [[{ text: "⬅️ Admin Panel သို့ပြန်သွားရန်", callback_data: "admin_panel" }]] }, env);
        return;
    }

    // Delete the temporary key to prevent re-sends
    await env.MAIL_BOT_DB.delete(`broadcast:${broadcastId}`);

    await editMessage(chatId, messageId, "⏳ Broadcast ကို စတင်ပို့ဆောင်နေပါပြီ... ပြီးဆုံးပါက အကြောင်းကြားပါမည်။", null, env);

    // Perform the broadcast in the background
    ctx.waitUntil((async () => {
        const allUserKeys = (await env.MAIL_BOT_DB.list({ prefix: "user:" })).keys;
        let sentCount = 0;
        let failedCount = 0;
        
        for (const key of allUserKeys) {
            const targetUserId = key.name.split(":")[1];
            try {
                const res = await sendMessage(targetUserId, messageText, null, env);
                if (res.ok) {
                    sentCount++;
                } else {
                    failedCount++;
                }
                // Telegram has rate limits, so a small delay is good practice.
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


// --- FIX 3: NEW ADMIN USER MANAGEMENT ---

async function listAllUsers(chatId, messageId, page, env) {
    await editMessage(chatId, messageId, "⏳ User စာရင်းကို ရှာဖွေနေပါသည်...", null, env);

    const userKeys = (await env.MAIL_BOT_DB.list({ prefix: "user:" })).keys;
    const USERS_PER_PAGE = 5;
    const totalPages = Math.max(1, Math.ceil(userKeys.length / USERS_PER_PAGE));
    page = Math.max(1, Math.min(page, totalPages));
    const startIndex = (page - 1) * USERS_PER_PAGE;
    const pageUserKeys = userKeys.slice(startIndex, startIndex + USERS_PER_PAGE);

    const text = `👤 **User Management** (Page ${page}/${totalPages})`;
    const keyboard = [];

    for (const key of pageUserKeys) {
        const targetUserId = key.name.split(":")[1];
        keyboard.push([{ text: `🆔 ${targetUserId}`, callback_data: `admin_view_user:${targetUserId}:${page}` }]);
    }

    const paginationRow = [];
    if (page > 1) {
        paginationRow.push({ text: "◀️ ရှေ့へ", callback_data: `list_users_page:${page - 1}` });
    }
    if (page < totalPages) {
        paginationRow.push({ text: "နောက်へ ▶️", callback_data: `list_users_page:${page + 1}` });
    }
    if (paginationRow.length > 0) {
        keyboard.push(paginationRow);
    }
    keyboard.push([{ text: "⬅️ Admin Panel သို့ပြန်သွားရန်", callback_data: "admin_panel" }]);

    await editMessage(chatId, messageId, text, { inline_keyboard: keyboard }, env);
}

async function showUserEmailsForAdmin(chatId, messageId, targetUserId, fromUserListPage, env) {
    await editMessage(chatId, messageId, `⏳ User ID: \`${targetUserId}\` ၏ email များကို ရှာဖွေနေပါသည်...`, null, env);

    const userData = await getUserData(targetUserId, env);
    let text = `📧 **Emails for User \`${targetUserId}\`**\n\n`;
    const keyboard = [];

    if (userData.createdEmails.length === 0) {
        text += "ဤ user သည် email တစ်ခုမှ မဖန်တီးထားပါ။";
    } else {
        for (const email of userData.createdEmails) {
            // encodeURIComponent is crucial for emails in callbacks
            const encodedEmail = encodeURIComponent(email);
            keyboard.push([{
                text: `🗑️ ${email}`,
                callback_data: `admin_delete_prompt:${targetUserId}:${encodedEmail}:${fromUserListPage}`
            }]);
        }
    }

    keyboard.push([{ text: `🔙 User List (Page ${fromUserListPage}) သို့ပြန်သွားရန်`, callback_data: `list_users_page:${fromUserListPage}` }]);
    await editMessage(chatId, messageId, text, { inline_keyboard: keyboard }, env);
}

async function confirmDeleteUserEmailForAdmin(chatId, messageId, targetUserId, encodedEmail, fromUserListPage, env) {
    const email = decodeURIComponent(encodedEmail);
    const text = `🗑️ **Admin Deletion Confirmation**\n\nUser \`${targetUserId}\` ၏ email \`${email}\` ကို အပြီးတိုင် ဖျက်မှာ သေချာလား?`;
    const keyboard = {
        inline_keyboard: [
            [{ text: "✅ ဟုတ်ကဲ့၊ ဖျက်မည်", callback_data: `admin_delete_confirm:${targetUserId}:${encodedEmail}:${fromUserListPage}` }],
            [{ text: "❌ မဟုတ်ပါ", callback_data: `admin_view_user:${targetUserId}:${fromUserListPage}` }]
        ]
    };
    await editMessage(chatId, messageId, text, keyboard, env);
}

async function deleteUserEmailForAdmin(chatId, messageId, targetUserId, encodedEmail, fromUserListPage, env) {
    const email = decodeURIComponent(encodedEmail);
    const emailKey = `email:${email}`;
    
    // 1. Get the target user's data
    const targetUserData = await getUserData(targetUserId, env);
    
    // 2. Remove email from their created list
    if (targetUserData) {
        targetUserData.createdEmails = targetUserData.createdEmails.filter(e => e !== email);
        await updateUserData(targetUserId, targetUserData, env);
    }
    
    // 3. Delete the main email record from KV
    await env.MAIL_BOT_DB.delete(emailKey);
    
    await editMessage(chatId, messageId, `✅ **အောင်မြင်စွာဖျက်ပြီးပါပြီ။**\nUser \`${targetUserId}\` ၏ လိပ်စာ \`${email}\` ကို ဖျက်လိုက်ပါပြီ။`, {
        inline_keyboard: [[{ text: `🔙 User \`${targetUserId}\` ၏ စာရင်းသို့ ပြန်သွားရန်`, callback_data: `admin_view_user:${targetUserId}:${fromUserListPage}` }]]
    });

    // 4. (Optional) Notify the user
    await sendMessage(targetUserId, `ℹ️ **အသိပေးချက်**\n\nသင်၏ email လိပ်စာ \`${email}\` ကို Admin မှ ဖျက်လိုက်ပါသည်။`, null, env);
}
